import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import zlib from 'zlib';

// Fetch-side integrity verification for the packages aggregation.
//
// kdex-tech/host-manager#161: when the packager runs inside the registry's
// post-publish propagation window, the install can end up carrying the
// PREVIOUS version's bytes for a correctly bumped pin. npm exits 0, the
// packages image builds, and /-/modules/** serves stale code with nothing in
// the logs to say so. The KDexInternalPackageReferences won't re-fetch for an
// unchanged version string, so the bad content then freezes.
//
// This runs right after install and asserts, per exactly-pinned dependency:
//
//   1. the installed package.json declares the pinned version;
//   2. the registry is self-consistent for that version — the tarball hashes
//      to the dist.shasum / dist.integrity the registry advertises;
//   3. the installed files match that verified tarball byte for byte.
//
// (3) is the check that actually catches the reported failure: (1) alone passes
// when the right version's package.json sits on top of the wrong dist bytes.
//
// What gives the check its power is not that anything is downloaded twice, it
// is the TEMPORAL GAP: the metadata read here is a second, LATER read than the
// one the install used, so a propagation-window packument that has since been
// corrected shows up as a changed dist digest. That gap belongs to the metadata
// read alone, which is why it is the only part forced online — see npmPack and
// the ledger below for what that buys.
//
// MUST run before `optimize`, which rewrites node_modules JS in place with
// esbuild — after that, no installed file matches its published bytes.
//
// It also assumes node_modules was installed fresh. The packager's WORKDIR is
// a per-Job EmptyDir (only the package-manager download cache persists), so
// that holds in production; a REUSED tree that a previous `optimize` already
// rewrote would be reported as differing — correctly, but unhelpfully.

// Only a fully-qualified semver names one specific version. "1.x", "1.0" and
// "^1.0.0" are all RANGES that legitimately resolve to something else, so
// there is nothing to compare them against.
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/;

export function isExactVersion(version) {
    return EXACT_VERSION.test(String(version ?? '').trim());
}

// package.json is excluded from the byte comparison: an installer may
// legitimately annotate the installed copy. Its `version` is checked directly
// in step (1) instead, which is the part that matters.
const CONTENT_COMPARE_EXCLUDE = new Set(['package.json']);

const execFileAsync = promisify(execFile);

// Asynchronous on purpose: a *Sync child-process call blocks the event loop, so
// verifying several dependencies at once would still run them one at a time.
export async function defaultExec(file, args, options = {}) {
    const { stdout } = await execFileAsync(file, args, {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        ...options,
    });
    return stdout;
}

// Run `worker` over every item with at most `limit` in flight, returning the
// results in ITEM order however they finish — the report must not shuffle from
// run to run just because a package answered quickly.
async function mapWithConcurrency(items, limit, worker) {
    const results = new Array(items.length);
    let next = 0;
    const runner = async () => {
        for (let i = next++; i < items.length; i = next++) {
            results[i] = await worker(items[i], i);
        }
    };
    await Promise.all(
        Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, runner)
    );
    return results;
}

function sha1(buffer) {
    return crypto.createHash('sha1').update(buffer).digest('hex');
}

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

// npm's dist.integrity is Subresource Integrity: "<alg>-<base64 digest>".
function integrityMatches(buffer, integrity) {
    const [alg, expected] = String(integrity).split('-', 2);
    if (!alg || !expected) return false;
    let actual;
    try {
        actual = crypto.createHash(alg.replace('sha', 'sha')).update(buffer).digest('base64');
    } catch {
        return false; // unknown algorithm; treated as "cannot verify"
    }
    return actual === expected;
}

// --- minimal tar reader -------------------------------------------------
//
// npm tarballs are gzipped tar. Only regular files are needed, but long paths
// arrive via pax ('x') or GNU ('L') extension records, so both are honoured --
// skipping them would silently drop exactly the deeply-nested files a stale
// build is most likely to differ in.

function parseOctal(buffer) {
    const text = buffer.toString('utf8').replace(/\0.*$/, '').trim();
    if (!text) return 0;
    return parseInt(text, 8) || 0;
}

export function readTarGz(buffer) {
    const tar = zlib.gunzipSync(buffer);
    const entries = new Map();

    let offset = 0;
    let longName = null;
    let paxPath = null;

    while (offset + 512 <= tar.length) {
        const header = tar.subarray(offset, offset + 512);
        offset += 512;

        // Two consecutive zero blocks end the archive.
        if (header.every((b) => b === 0)) continue;

        const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
        const size = parseOctal(header.subarray(124, 136));
        const typeflag = String.fromCharCode(header[156]) || '0';

        const dataSize = size;
        const padded = Math.ceil(dataSize / 512) * 512;
        const data = tar.subarray(offset, offset + dataSize);
        offset += padded;

        if (typeflag === 'L') {
            longName = data.toString('utf8').replace(/\0.*$/, '');
            continue;
        }
        if (typeflag === 'x') {
            // pax extended header: "<len> path=<value>\n" records.
            const text = data.toString('utf8');
            const match = text.match(/\d+ path=([^\n]*)\n/);
            paxPath = match ? match[1] : null;
            continue;
        }
        if (typeflag === 'g') continue; // global pax header

        const name = paxPath ?? longName ?? rawName;
        longName = null;
        paxPath = null;

        // Regular files only ('0' or NUL).
        if (typeflag !== '0' && typeflag !== '\0') continue;

        entries.set(name, Buffer.from(data));
    }

    return entries;
}

// npm tarballs root every entry under "package/".
function stripPackagePrefix(name) {
    const clean = name.replace(/^\.\//, '');
    return clean.startsWith('package/') ? clean.slice('package/'.length) : null;
}

// --- verification ledger ------------------------------------------------
//
// The expensive half of this check is fetching, gunzipping and tar-parsing a
// tarball whose contents can never change: npm forbids republishing a version,
// so a (name, version, registry digest) triple is a permanent identity. Once
// verified, recording the tarball's per-file digests lets a later Job re-run
// step (3) — the byte comparison that actually catches #161 — against the
// recording instead of the tarball.
//
// The entry is keyed on the digest the registry advertises RIGHT NOW, which is
// what keeps this from weakening the guard. It cannot outlive its own premise:
// if the registry ever advertises different bytes for the version — precisely
// the propagation-window packument being corrected — the key misses and the
// full path runs. An entry recorded from a bad window can never be consulted,
// because whatever would invalidate it also changes the key.
//
// The metadata read is what supplies that key, so it stays online. It is a
// second, LATER read than the one the install used, and that temporal gap is
// the entire mechanism.

/**
 * Where the ledger lives, or null when no persistent cache is attached.
 *
 * host-manager mounts the packager's cache claim at /cache and advertises it
 * through NPM_CONFIG_CACHE / BUN_INSTALL_CACHE_DIR; deriving the root from the
 * npm cache's parent means this works against today's controller with no CRD
 * or controller release. KDEX_CACHE_DIR is the explicit form for when one is
 * added. Neither set (an empty CacheClaim) leaves every Job on the cold path,
 * which is the correct degradation.
 */
export function resolveLedgerDir(env = process.env) {
    if (env.KDEX_CACHE_DIR) return path.join(env.KDEX_CACHE_DIR, 'verify');
    if (env.NPM_CONFIG_CACHE) return path.join(path.dirname(env.NPM_CONFIG_CACHE), 'verify');
    return null;
}

function registryKey(meta) {
    return meta?.dist?.shasum ? `sha1:${meta.dist.shasum}` : `sri:${meta.dist.integrity}`;
}

function ledgerEntryPath(ledgerDir, name, version) {
    // Scoped names nest naturally ("@scope/pkg/1.0.0.json"); versions are
    // filename-safe by construction, having passed isExactVersion.
    return path.join(ledgerDir, name, `${version}.json`);
}

function readLedgerEntry(ledgerDir, name, version, key) {
    if (!ledgerDir) return null;
    try {
        const entry = JSON.parse(fs.readFileSync(ledgerEntryPath(ledgerDir, name, version), 'utf8'));
        // A key mismatch is the invalidation path, not an error: fall through
        // and re-verify against the tarball the registry now advertises.
        return entry?.key === key && entry.files ? entry : null;
    } catch {
        return null;
    }
}

function writeLedgerEntry(ledgerDir, name, version, key, files) {
    if (!ledgerDir) return;
    try {
        const target = ledgerEntryPath(ledgerDir, name, version);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        // tmp + rename: packaging Jobs for the same host can overlap on the
        // claim, and a half-written entry read by the other one would be a
        // spurious build failure. Entries are immutable per key, so a racing
        // writer produces identical bytes and the last rename simply wins.
        const tmp = `${target}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ name, version, key, files }));
        fs.renameSync(tmp, target);
    } catch {
        // A cache that cannot be written is a lost optimisation, never a
        // reason to fail an otherwise verified build.
    }
}

// --- registry access ----------------------------------------------------

async function npmView(name, version, { exec, workdir }) {
    const raw = await exec('npm', [
        'view', `${name}@${version}`, '--json', '--prefer-online',
    ], { cwd: workdir });
    const meta = JSON.parse(raw);
    // `npm view` yields an array when the selector matches multiple versions;
    // an exact pin should not, but take the last if it does.
    return Array.isArray(meta) ? meta[meta.length - 1] : meta;
}

// The tarball is trusted because it hashes to the FRESHLY fetched
// dist.shasum/integrity, not because of where its bytes came from — content
// addressing means a cached tarball cannot vouch for itself the way a cached
// packument can. So the first fetch is allowed to hit the package-manager cache
// that `npm install` has just populated in the same Job; only a digest mismatch
// forces `preferOnline`, which is what separates a stale cache from a
// self-inconsistent registry.
async function npmPack(name, version, destDir, { exec, workdir, preferOnline = false }) {
    const raw = await exec('npm', [
        'pack', `${name}@${version}`, '--json',
        ...(preferOnline ? ['--prefer-online'] : []),
        '--pack-destination', destDir,
    ], { cwd: workdir });
    const result = JSON.parse(raw);
    const filename = Array.isArray(result) ? result[0]?.filename : result?.filename;
    if (!filename) {
        throw new Error(`npm pack ${name}@${version} reported no filename`);
    }
    // npm has shipped both "<file>" and a path; normalise to the destination.
    return path.join(destDir, path.basename(filename));
}

// --- verification -------------------------------------------------------

// Does this tarball hash to what the registry advertises for the version?
// dist.shasum is preferred because every registry emits it; dist.integrity is
// the modern fallback.
function tarballDigest(tarball, meta) {
    const expectedShasum = meta?.dist?.shasum;
    if (expectedShasum) {
        const actual = sha1(tarball);
        return actual === expectedShasum
            ? { ok: true }
            : { ok: false, reason: `fetched tarball sha1 ${actual} != registry dist.shasum ${expectedShasum}` };
    }
    const expectedIntegrity = meta?.dist?.integrity;
    return integrityMatches(tarball, expectedIntegrity)
        ? { ok: true }
        : { ok: false, reason: `fetched tarball does not match registry dist.integrity ${expectedIntegrity}` };
}

function readInstalledVersion(modulesDir, name) {
    const manifest = path.join(modulesDir, name, 'package.json');
    if (!fs.existsSync(manifest)) return null;
    try {
        return JSON.parse(fs.readFileSync(manifest, 'utf8')).version ?? null;
    } catch {
        return null;
    }
}

// The published tree reduced to { relative path -> digest }. This is both the
// cold path's comparison basis and exactly what the ledger records, so the
// warm and cold paths run the identical comparison over identical data.
function tarballFileDigests(entries) {
    const files = {};
    for (const [entryName, published] of entries) {
        const relative = stripPackagePrefix(entryName);
        if (relative === null || relative === '') continue;
        if (CONTENT_COMPARE_EXCLUDE.has(relative)) continue;
        files[relative] = sha256(published);
    }
    return files;
}

function compareInstalledToDigests(modulesDir, name, files) {
    const installedRoot = path.join(modulesDir, name);
    const differing = [];

    for (const [relative, published] of Object.entries(files)) {
        const installedPath = path.join(installedRoot, relative);
        if (!fs.existsSync(installedPath)) {
            differing.push({ file: relative, reason: 'missing from the installed tree' });
            continue;
        }
        const installed = sha256(fs.readFileSync(installedPath));
        if (installed !== published) {
            differing.push({
                file: relative,
                reason: `content differs (published ${published.slice(0, 12)}, installed ${installed.slice(0, 12)})`,
            });
        }
    }

    return differing;
}

/**
 * Verify that every exactly-pinned dependency was installed as published.
 *
 * Returns { checked, skipped, failures }. `failures` is what matters: a
 * non-empty list means the install does NOT reflect the registry and the
 * aggregation must not proceed.
 *
 * Verification errors (registry unreachable, unparseable metadata) are
 * reported separately as `unverified` rather than folded into `failures` --
 * "could not check" is not "checked and wrong", and failing builds on a
 * registry blip would be worse than the bug this guards against.
 */
export async function verifyIntegrity(options = {}) {
    const {
        workdir = process.cwd(),
        modulesDir = path.join(workdir, 'node_modules'),
        exec = defaultExec,
        log = console.log,
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdex-verify-')),
        ledgerDir = null,
        // Bounded so a large dependency set cannot open an unreasonable number
        // of registry connections at once; every unit here is one npm process.
        concurrency = 8,
    } = options;

    let deps = options.deps;
    if (!deps) {
        const pkgPath = path.join(workdir, 'package.json');
        deps = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).dependencies ?? {};
    }

    // One dependency's verdict, tagged with the bucket it belongs in. Each
    // package is independent, so this runs concurrently and the caller
    // reassembles the buckets in dependency order afterwards.
    const verifyOne = async ([name, range]) => {
        if (!isExactVersion(range)) {
            return { bucket: 'skipped', entry: { name, range, reason: 'not an exact version' } };
        }
        const version = String(range).trim();
        const fail = (reason) => ({ bucket: 'failures', entry: { name, version, reason } });
        const cannotVerify = (reason) => ({ bucket: 'unverified', entry: { name, version, reason } });

        // (1) the installed tree declares the pinned version.
        const installedVersion = readInstalledVersion(modulesDir, name);
        if (installedVersion === null) {
            return fail('not present in node_modules after install');
        }
        if (installedVersion !== version) {
            return fail(`installed version is ${installedVersion}, pinned ${version}`);
        }

        // (2) the registry is self-consistent for this version.
        //
        // The metadata read MUST stay online. It is a second, LATER read than
        // the one the install used, and that temporal gap is the whole
        // mechanism: a propagation-window packument that has since been
        // corrected shows up here as a different dist digest.
        let meta;
        try {
            meta = await npmView(name, version, { exec, workdir });
        } catch (err) {
            return cannotVerify(`registry fetch failed: ${err.message}`);
        }

        if (!meta?.dist?.shasum && !meta?.dist?.integrity) {
            return cannotVerify('registry metadata carries no dist.shasum or dist.integrity');
        }

        // A ledger entry recorded against the digest the registry is
        // advertising right now already carries the published file digests, so
        // the tarball round trip can be skipped entirely.
        const key = registryKey(meta);
        const cached = readLedgerEntry(ledgerDir, name, version, key);
        let files = cached?.files;

        if (!files) {
            let tarball;
            let digest;
            try {
                tarball = fs.readFileSync(await npmPack(name, version, tmpDir, { exec, workdir }));
                digest = tarballDigest(tarball, meta);
                if (!digest.ok) {
                    // One mismatching fetch is not enough to blame the registry
                    // — the package-manager cache may simply be holding the
                    // wrong bytes. Re-fetch online; only if THAT still
                    // disagrees is the registry itself inconsistent.
                    tarball = fs.readFileSync(
                        await npmPack(name, version, tmpDir, { exec, workdir, preferOnline: true })
                    );
                    digest = tarballDigest(tarball, meta);
                }
            } catch (err) {
                return cannotVerify(`registry fetch failed: ${err.message}`);
            }

            if (!digest.ok) {
                return fail(digest.reason);
            }

            files = tarballFileDigests(readTarGz(tarball));
        }

        // (3) the installed files ARE the published files.
        const differing = compareInstalledToDigests(modulesDir, name, files);
        if (differing.length > 0) {
            const preview = differing.slice(0, 5).map((d) => `${d.file} (${d.reason})`);
            return fail(
                `installed content differs from the published ${version} tarball in ${differing.length} file(s): ` +
                `${preview.join('; ')}${differing.length > 5 ? '; …' : ''}`
            );
        }

        // Recorded only once the package verified clean, so a failed check can
        // never be handed to the next Job as an answer.
        if (!cached) {
            writeLedgerEntry(ledgerDir, name, version, key, files);
        }

        const count = Object.keys(files).length;
        return {
            bucket: 'checked',
            entry: { name, version, files: count, cached: Boolean(cached) },
            log: `  ✓ ${name}@${version} matches the published tarball (${count} entries${cached ? ', from cache' : ''})`,
        };
    };

    const outcomes = await mapWithConcurrency(Object.entries(deps), concurrency, verifyOne);

    const checked = [];
    const skipped = [];
    const failures = [];
    const unverified = [];
    const buckets = { checked, skipped, failures, unverified };

    // Reassembled in dependency order, not completion order, so the report is
    // reproducible run to run.
    for (const outcome of outcomes) {
        buckets[outcome.bucket].push(outcome.entry);
        if (outcome.log) log(outcome.log);
    }

    for (const s of skipped) {
        log(`  – ${s.name}@${s.range} skipped (${s.reason})`);
    }
    for (const u of unverified) {
        log(`  ? ${u.name}@${u.version} NOT verified: ${u.reason}`);
    }

    return { checked, skipped, failures, unverified };
}
