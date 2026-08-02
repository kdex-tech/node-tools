import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
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
//   2. the registry's own metadata is self-consistent — a freshly fetched
//      tarball hashes to the dist.shasum / dist.integrity the registry
//      advertises for that version;
//   3. the installed files match that verified tarball byte for byte.
//
// (3) is the check that actually catches the reported failure: (1) alone passes
// when the right version's package.json sits on top of the wrong dist bytes.
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

function defaultExec(file, args, options = {}) {
    return execFileSync(file, args, {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        ...options,
    });
}

function sha1(buffer) {
    return crypto.createHash('sha1').update(buffer).digest('hex');
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

// --- registry access ----------------------------------------------------

function npmView(name, version, { exec, workdir }) {
    const raw = exec('npm', [
        'view', `${name}@${version}`, '--json', '--prefer-online',
    ], { cwd: workdir });
    const meta = JSON.parse(raw);
    // `npm view` yields an array when the selector matches multiple versions;
    // an exact pin should not, but take the last if it does.
    return Array.isArray(meta) ? meta[meta.length - 1] : meta;
}

function npmPack(name, version, destDir, { exec, workdir }) {
    const raw = exec('npm', [
        'pack', `${name}@${version}`, '--json', '--prefer-online',
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

function readInstalledVersion(modulesDir, name) {
    const manifest = path.join(modulesDir, name, 'package.json');
    if (!fs.existsSync(manifest)) return null;
    try {
        return JSON.parse(fs.readFileSync(manifest, 'utf8')).version ?? null;
    } catch {
        return null;
    }
}

function compareInstalledToTarball(modulesDir, name, entries) {
    const installedRoot = path.join(modulesDir, name);
    const differing = [];

    for (const [entryName, published] of entries) {
        const relative = stripPackagePrefix(entryName);
        if (relative === null || relative === '') continue;
        if (CONTENT_COMPARE_EXCLUDE.has(relative)) continue;

        const installedPath = path.join(installedRoot, relative);
        if (!fs.existsSync(installedPath)) {
            differing.push({ file: relative, reason: 'missing from the installed tree' });
            continue;
        }
        const installed = fs.readFileSync(installedPath);
        if (!installed.equals(published)) {
            differing.push({
                file: relative,
                reason: `content differs (published ${sha1(published).slice(0, 12)}, installed ${sha1(installed).slice(0, 12)})`,
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
    } = options;

    let deps = options.deps;
    if (!deps) {
        const pkgPath = path.join(workdir, 'package.json');
        deps = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).dependencies ?? {};
    }

    const checked = [];
    const skipped = [];
    const failures = [];
    const unverified = [];

    for (const [name, range] of Object.entries(deps)) {
        if (!isExactVersion(range)) {
            skipped.push({ name, range, reason: 'not an exact version' });
            continue;
        }
        const version = String(range).trim();

        // (1) the installed tree declares the pinned version.
        const installedVersion = readInstalledVersion(modulesDir, name);
        if (installedVersion === null) {
            failures.push({ name, version, reason: 'not present in node_modules after install' });
            continue;
        }
        if (installedVersion !== version) {
            failures.push({
                name, version,
                reason: `installed version is ${installedVersion}, pinned ${version}`,
            });
            continue;
        }

        // (2) the registry is self-consistent for this version.
        let meta;
        let tarballPath;
        try {
            meta = npmView(name, version, { exec, workdir });
            tarballPath = npmPack(name, version, tmpDir, { exec, workdir });
        } catch (err) {
            unverified.push({ name, version, reason: `registry fetch failed: ${err.message}` });
            continue;
        }

        const tarball = fs.readFileSync(tarballPath);
        const expectedShasum = meta?.dist?.shasum;
        const expectedIntegrity = meta?.dist?.integrity;

        if (expectedShasum) {
            const actual = sha1(tarball);
            if (actual !== expectedShasum) {
                failures.push({
                    name, version,
                    reason: `fetched tarball sha1 ${actual} != registry dist.shasum ${expectedShasum}`,
                });
                continue;
            }
        } else if (expectedIntegrity) {
            if (!integrityMatches(tarball, expectedIntegrity)) {
                failures.push({
                    name, version,
                    reason: `fetched tarball does not match registry dist.integrity ${expectedIntegrity}`,
                });
                continue;
            }
        } else {
            unverified.push({ name, version, reason: 'registry metadata carries no dist.shasum or dist.integrity' });
            continue;
        }

        // (3) the installed files ARE the published files.
        const entries = readTarGz(tarball);
        const differing = compareInstalledToTarball(modulesDir, name, entries);
        if (differing.length > 0) {
            const preview = differing.slice(0, 5).map((d) => `${d.file} (${d.reason})`);
            failures.push({
                name, version,
                reason: `installed content differs from the published ${version} tarball in ${differing.length} file(s): ${preview.join('; ')}${differing.length > 5 ? '; …' : ''}`,
            });
            continue;
        }

        checked.push({ name, version, files: entries.size });
        log(`  ✓ ${name}@${version} matches the published tarball (${entries.size} entries)`);
    }

    for (const s of skipped) {
        log(`  – ${s.name}@${s.range} skipped (${s.reason})`);
    }
    for (const u of unverified) {
        log(`  ? ${u.name}@${u.version} NOT verified: ${u.reason}`);
    }

    return { checked, skipped, failures, unverified };
}
