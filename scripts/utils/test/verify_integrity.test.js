import assert from 'assert';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';

import { defaultExec, isExactVersion, readTarGz, resolveLedgerDir, verifyIntegrity } from '../verify_integrity.js';

// --- fixtures -----------------------------------------------------------

// Minimal tar writer, the mirror of the reader under test. Kept independent
// (hand-rolled headers rather than reusing the reader's constants) so a bug in
// the reader cannot cancel itself out against the fixture.
function makeTarGz(files) {
    const blocks = [];
    for (const [name, body] of Object.entries(files)) {
        const content = Buffer.from(body);
        const header = Buffer.alloc(512);
        header.write(name, 0, 100, 'utf8');
        header.write('0000644\0', 100, 8, 'utf8');            // mode
        header.write('0000000\0', 108, 8, 'utf8');            // uid
        header.write('0000000\0', 116, 8, 'utf8');            // gid
        header.write(content.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf8');
        header.write('00000000000\0', 136, 12, 'utf8');       // mtime
        header.write('        ', 148, 8, 'utf8');             // checksum placeholder
        header.write('0', 156, 1, 'utf8');                    // typeflag: regular
        header.write('ustar\0', 257, 6, 'utf8');
        header.write('00', 263, 2, 'utf8');

        let sum = 0;
        for (const byte of header) sum += byte;
        header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');

        blocks.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512));
    }
    blocks.push(Buffer.alloc(1024)); // end-of-archive
    return zlib.gzipSync(Buffer.concat(blocks));
}

function sha1(buffer) {
    return crypto.createHash('sha1').update(buffer).digest('hex');
}

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function tmpLedgerDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'verify-ledger-'));
}

// A package whose published bytes and installed bytes agree — the shape every
// ledger test starts from.
function cleanScenario(body = 'export const v = "0.1.6";') {
    return scenario({
        pinned: '0.1.6',
        installedFiles: { 'dist/index.js': body },
        publishedFiles: { 'dist/index.js': body },
    });
}

function run(s, extra = {}) {
    return verifyIntegrity({
        workdir: s.root,
        modulesDir: s.modulesDir,
        deps: { 'demo-pkg': '0.1.6' },
        exec: s.exec,
        tmpDir: s.tmpDir,
        log: quiet,
        ...extra,
    });
}

// An exec that fails loudly if the tarball is fetched at all — the assertion
// that the ledger removed the expensive half of the check.
function execWithoutPack(s) {
    return (file, args) => {
        if (args[0] === 'pack') {
            throw new Error('the tarball must not be fetched when the ledger already covers this version');
        }
        return s.exec(file, args);
    };
}

// Builds a workdir with an installed node_modules tree, plus a fake npm that
// answers `view` from the registry metadata and `pack` with a prepared tarball.
//
// `staleCachedFiles` models a package-manager cache holding the WRONG bytes for
// this version: a `pack` without --prefer-online serves those, one with it
// serves the real tarball. That is the only way the two fetch modes are allowed
// to differ, and it is what the cache-then-refetch path has to survive.
function scenario({ pinned, installedFiles, publishedFiles, installedVersion, staleCachedFiles }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-test-'));
    const modulesDir = path.join(root, 'node_modules');
    const pkgDir = path.join(modulesDir, 'demo-pkg');
    fs.mkdirSync(pkgDir, { recursive: true });

    fs.writeFileSync(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({ name: 'demo-pkg', version: installedVersion ?? pinned })
    );
    for (const [rel, body] of Object.entries(installedFiles)) {
        const target = path.join(pkgDir, rel);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, body);
    }

    const tarFiles = { 'package/package.json': JSON.stringify({ name: 'demo-pkg', version: pinned }) };
    for (const [rel, body] of Object.entries(publishedFiles)) {
        tarFiles[`package/${rel}`] = body;
    }
    const tarball = makeTarGz(tarFiles);

    let staleTarball = null;
    if (staleCachedFiles) {
        const staleFiles = { 'package/package.json': JSON.stringify({ name: 'demo-pkg', version: pinned }) };
        for (const [rel, body] of Object.entries(staleCachedFiles)) {
            staleFiles[`package/${rel}`] = body;
        }
        staleTarball = makeTarGz(staleFiles);
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-pack-'));

    const calls = [];
    const exec = (file, args) => {
        calls.push(args);
        assert.strictEqual(file, 'npm');
        if (args[0] === 'view') {
            assert.ok(args.includes('--prefer-online'),
                'registry metadata must be fetched fresh, or a stale cache answers for itself');
            return JSON.stringify({
                name: 'demo-pkg',
                version: pinned,
                dist: { shasum: sha1(tarball), tarball: 'https://registry.example/demo-pkg.tgz' },
            });
        }
        if (args[0] === 'pack') {
            const online = args.includes('--prefer-online');
            const body = !online && staleTarball ? staleTarball : tarball;
            const dest = args[args.indexOf('--pack-destination') + 1];
            const filename = `demo-pkg-${pinned}.tgz`;
            fs.writeFileSync(path.join(dest, filename), body);
            return JSON.stringify([{ filename }]);
        }
        throw new Error(`unexpected npm invocation: ${args.join(' ')}`);
    };

    return { root, modulesDir, exec, tmpDir, tarball, calls };
}

const packCalls = (calls) => calls.filter((args) => args[0] === 'pack');
const viewCalls = (calls) => calls.filter((args) => args[0] === 'view');

const quiet = () => {};

// --- tests --------------------------------------------------------------

// The core of kdex-tech/host-manager#161, and the case the host-manager-side
// check CANNOT see: the right version's package.json sits on top of the
// PREVIOUS version's dist bytes. A version-only check passes here.
async function testCatchesStaleBytesUnderCorrectVersion() {
    const s = scenario({
        pinned: '0.1.6',
        installedFiles: { 'dist/index.js': 'export const v = "0.1.5";' },  // stale content
        publishedFiles: { 'dist/index.js': 'export const v = "0.1.6";' },  // what the registry has
    });

    const result = await verifyIntegrity({
        workdir: s.root,
        modulesDir: s.modulesDir,
        deps: { 'demo-pkg': '0.1.6' },
        exec: s.exec,
        tmpDir: s.tmpDir,
        log: quiet,
    });

    assert.strictEqual(result.failures.length, 1,
        'stale dist bytes under a correct version must be a failure');
    assert.match(result.failures[0].reason, /installed content differs/);
    assert.match(result.failures[0].reason, /dist\/index\.js/);
    assert.strictEqual(result.checked.length, 0);
    console.log('--- stale-bytes-under-correct-version test passed ---');
}

// Control: a clean install must not be reported, or every build fails.
async function testCleanInstallPasses() {
    const body = 'export const v = "0.1.6";';
    const s = scenario({
        pinned: '0.1.6',
        installedFiles: { 'dist/index.js': body },
        publishedFiles: { 'dist/index.js': body },
    });

    const result = await verifyIntegrity({
        workdir: s.root,
        modulesDir: s.modulesDir,
        deps: { 'demo-pkg': '0.1.6' },
        exec: s.exec,
        tmpDir: s.tmpDir,
        log: quiet,
    });

    assert.deepStrictEqual(result.failures, [], 'a faithful install must produce no failures');
    assert.strictEqual(result.checked.length, 1);
    console.log('--- clean-install control test passed ---');
}

// The cheap half: the installed tree is simply the previous version.
async function testCatchesWrongInstalledVersion() {
    const s = scenario({
        pinned: '0.1.6',
        installedVersion: '0.1.5',
        installedFiles: { 'dist/index.js': 'export const v = "0.1.5";' },
        publishedFiles: { 'dist/index.js': 'export const v = "0.1.6";' },
    });

    const result = await verifyIntegrity({
        workdir: s.root,
        modulesDir: s.modulesDir,
        deps: { 'demo-pkg': '0.1.6' },
        exec: s.exec,
        tmpDir: s.tmpDir,
        log: quiet,
    });

    assert.strictEqual(result.failures.length, 1);
    assert.match(result.failures[0].reason, /installed version is 0\.1\.5, pinned 0\.1\.6/);
    console.log('--- wrong-installed-version test passed ---');
}

// A registry that contradicts itself (advertised shasum != fetched tarball) is
// a hard failure: nothing downstream can be trusted.
async function testCatchesRegistryShasumMismatch() {
    const s = scenario({
        pinned: '0.1.6',
        installedFiles: { 'dist/index.js': 'x' },
        publishedFiles: { 'dist/index.js': 'x' },
    });

    const exec = (file, args) => {
        if (args[0] === 'view') {
            return JSON.stringify({ dist: { shasum: 'deadbeef'.repeat(5) } }); // wrong on purpose
        }
        return s.exec(file, args);
    };

    const result = await verifyIntegrity({
        workdir: s.root,
        modulesDir: s.modulesDir,
        deps: { 'demo-pkg': '0.1.6' },
        exec,
        tmpDir: s.tmpDir,
        log: quiet,
    });

    assert.strictEqual(result.failures.length, 1);
    assert.match(result.failures[0].reason, /!= registry dist\.shasum/);
    // Only after an online re-fetch also disagrees is the REGISTRY the culprit;
    // a single mismatching fetch could just be a stale package-manager cache.
    assert.strictEqual(packCalls(s.calls).length, 2,
        'the registry may only be blamed once an online re-fetch also mismatches');
    console.log('--- registry-shasum-mismatch test passed ---');
}

// "Could not verify" must stay distinct from "verified and wrong": a registry
// blip must not fail an otherwise good build.
async function testUnreachableRegistryIsNotAFailure() {
    const s = scenario({
        pinned: '0.1.6',
        installedFiles: { 'dist/index.js': 'x' },
        publishedFiles: { 'dist/index.js': 'x' },
    });

    const exec = () => { throw new Error('ETIMEDOUT'); };

    const result = await verifyIntegrity({
        workdir: s.root,
        modulesDir: s.modulesDir,
        deps: { 'demo-pkg': '0.1.6' },
        exec,
        tmpDir: s.tmpDir,
        log: quiet,
    });

    assert.deepStrictEqual(result.failures, [], 'an unreachable registry must not fail the build');
    assert.strictEqual(result.unverified.length, 1);
    assert.match(result.unverified[0].reason, /registry fetch failed/);
    console.log('--- unreachable-registry test passed ---');
}

// Ranges resolve to whatever npm picks, so there is nothing to compare.
async function testSkipsNonExactPins() {
    const s = scenario({
        pinned: '0.1.6',
        installedFiles: { 'dist/index.js': 'x' },
        publishedFiles: { 'dist/index.js': 'x' },
    });

    const result = await verifyIntegrity({
        workdir: s.root,
        modulesDir: s.modulesDir,
        deps: { 'demo-pkg': '^0.1.0' },
        exec: () => { throw new Error('the registry must not be consulted for a range'); },
        tmpDir: s.tmpDir,
        log: quiet,
    });

    assert.deepStrictEqual(result.failures, []);
    assert.strictEqual(result.skipped.length, 1);
    console.log('--- non-exact-pin skip test passed ---');
}

// --- slice A: the tarball may come from the cache ------------------------
//
// What gives this check its power is the TEMPORAL GAP: `npm view` is a second,
// LATER registry read than the one the install used, so a propagation-window
// packument that has since been corrected shows up as a changed integrity.
// That gap is a property of the metadata read alone. The tarball is only a
// source of bytes, and it is trusted solely because it hashes to the
// freshly-fetched dist.shasum -- content addressing means a cached tarball
// cannot vouch for itself. Forcing it online only re-downloads what `npm
// install` just wrote to the package-manager cache.
async function testTarballIsFetchedFromCacheButMetadataStaysOnline() {
    const body = 'export const v = "0.1.6";';
    const s = scenario({
        pinned: '0.1.6',
        installedFiles: { 'dist/index.js': body },
        publishedFiles: { 'dist/index.js': body },
    });

    await verifyIntegrity({
        workdir: s.root,
        modulesDir: s.modulesDir,
        deps: { 'demo-pkg': '0.1.6' },
        exec: s.exec,
        tmpDir: s.tmpDir,
        log: quiet,
    });

    assert.ok(viewCalls(s.calls).every((args) => args.includes('--prefer-online')),
        'metadata must stay online: it is the later registry read the check depends on');
    assert.strictEqual(packCalls(s.calls)[0].includes('--prefer-online'), false,
        'the first tarball fetch must be allowed to hit the package-manager cache');
    console.log('--- tarball-from-cache test passed ---');
}

// A cache that holds the wrong bytes must not be reported as a self-inconsistent
// REGISTRY. Re-fetch online before drawing that conclusion.
async function testStaleCachedTarballIsRefetchedOnline() {
    const body = 'export const v = "0.1.6";';
    const s = scenario({
        pinned: '0.1.6',
        installedFiles: { 'dist/index.js': body },
        publishedFiles: { 'dist/index.js': body },
        staleCachedFiles: { 'dist/index.js': 'export const v = "0.1.5";' },
    });

    const result = await verifyIntegrity({
        workdir: s.root,
        modulesDir: s.modulesDir,
        deps: { 'demo-pkg': '0.1.6' },
        exec: s.exec,
        tmpDir: s.tmpDir,
        log: quiet,
    });

    assert.deepStrictEqual(result.failures, [],
        'a stale CACHE must not be reported as a failure when the registry is fine');
    assert.strictEqual(result.checked.length, 1);
    assert.strictEqual(packCalls(s.calls).length, 2, 'the mismatching fetch must be retried online');
    assert.strictEqual(packCalls(s.calls)[1].includes('--prefer-online'), true);
    console.log('--- stale-cached-tarball-refetch test passed ---');
}

// --- slice B: the verification ledger on the persistent cache ------------
//
// npm forbids republishing a version, so a verified (name, version, registry
// digest) triple is permanently valid. Recording the verified tarball's
// per-file digests lets a later Job re-run the byte comparison — the check that
// actually catches #161 — with no download, no gunzip and no tar parse.

// The ledger lives on the packager's cache claim, which host-manager mounts at
// /cache and currently advertises only through the package-manager cache vars.
function testResolveLedgerDir() {
    assert.strictEqual(resolveLedgerDir({ KDEX_CACHE_DIR: '/cache' }), '/cache/verify');
    // Derived from the npm cache's parent so this works against today's
    // host-manager, which exports NPM_CONFIG_CACHE but no explicit cache root.
    assert.strictEqual(resolveLedgerDir({ NPM_CONFIG_CACHE: '/cache/npm' }), '/cache/verify');
    assert.strictEqual(resolveLedgerDir({ KDEX_CACHE_DIR: '/a', NPM_CONFIG_CACHE: '/b/npm' }), '/a/verify',
        'an explicit cache root wins over the derived one');
    // No claim attached: no ledger, and every Job pays the cold path. Correct.
    assert.strictEqual(resolveLedgerDir({}), null);
    console.log('--- resolveLedgerDir test passed ---');
}

async function testColdVerificationWritesALedgerEntry() {
    const body = 'export const v = "0.1.6";';
    const s = cleanScenario(body);
    const ledgerDir = tmpLedgerDir();

    const result = await run(s, { ledgerDir });
    assert.deepStrictEqual(result.failures, []);

    const entry = JSON.parse(fs.readFileSync(path.join(ledgerDir, 'demo-pkg', '0.1.6.json'), 'utf8'));
    assert.strictEqual(entry.key, `sha1:${sha1(s.tarball)}`,
        'the entry must be keyed on the digest the registry advertises, so a corrected packument invalidates it');
    assert.strictEqual(entry.files['dist/index.js'], sha256(body));
    assert.ok(!('package.json' in entry.files),
        'package.json is excluded from the content comparison, so recording it would create a false mismatch');
    console.log('--- cold-run-writes-ledger test passed ---');
}

async function testWarmLedgerSkipsTheTarballFetch() {
    const ledgerDir = tmpLedgerDir();
    await run(cleanScenario(), { ledgerDir });

    const warm = cleanScenario();
    const result = await run(warm, { ledgerDir, exec: execWithoutPack(warm) });

    assert.deepStrictEqual(result.failures, []);
    assert.strictEqual(result.checked.length, 1, 'a ledger hit still counts as verified');
    assert.strictEqual(packCalls(warm.calls).length, 0);
    assert.strictEqual(viewCalls(warm.calls).length, 1,
        'the metadata read stays — it is what proves the ledger entry is still the published one');
    console.log('--- warm-ledger-skips-tarball test passed ---');
}

// The entry cannot outlive its own premise: it is consulted only while the
// registry still advertises the digest it was recorded against.
async function testLedgerEntryForOtherBytesIsIgnored() {
    const ledgerDir = tmpLedgerDir();
    await run(cleanScenario('export const v = "first";'), { ledgerDir });

    const corrected = cleanScenario('export const v = "corrected";');
    const result = await run(corrected, { ledgerDir });

    assert.deepStrictEqual(result.failures, [],
        'the registry and the install agree on the new bytes; only the stale entry disagreed');
    assert.strictEqual(packCalls(corrected.calls).length, 1,
        'a key miss must fall through to the full tarball comparison');

    const entry = JSON.parse(fs.readFileSync(path.join(ledgerDir, 'demo-pkg', '0.1.6.json'), 'utf8'));
    assert.strictEqual(entry.key, `sha1:${sha1(corrected.tarball)}`, 'the entry must be replaced, not left stale');
    console.log('--- ledger-key-miss test passed ---');
}

// The point of the whole exercise: the cached path must still catch #161.
async function testWarmLedgerStillCatchesStaleInstalledBytes() {
    const ledgerDir = tmpLedgerDir();
    const s = cleanScenario();
    await run(s, { ledgerDir });

    fs.writeFileSync(path.join(s.modulesDir, 'demo-pkg', 'dist/index.js'), 'export const v = "0.1.5";');
    const result = await run(s, { ledgerDir, exec: execWithoutPack(s) });

    assert.strictEqual(result.failures.length, 1,
        'stale installed bytes must fail on the ledger path exactly as on the cold path');
    assert.match(result.failures[0].reason, /installed content differs/);
    assert.match(result.failures[0].reason, /dist\/index\.js/);
    console.log('--- warm-ledger-catches-stale-bytes test passed ---');
}

// Two Jobs for the same host can overlap on the claim. A half-written or
// otherwise unreadable entry must degrade to the cold path — never fail a build
// over the state of a cache.
async function testUnreadableLedgerEntryFallsBackToTheColdPath() {
    const ledgerDir = tmpLedgerDir();
    const s = cleanScenario();
    const target = path.join(ledgerDir, 'demo-pkg', '0.1.6.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '{"key": "sha1:abc", "files": {"dist/index.js"');   // truncated

    const result = await run(s, { ledgerDir });

    assert.deepStrictEqual(result.failures, []);
    assert.strictEqual(packCalls(s.calls).length, 1, 'an unreadable entry must fall through to the tarball');
    assert.strictEqual(JSON.parse(fs.readFileSync(target, 'utf8')).key, `sha1:${sha1(s.tarball)}`,
        'and the entry must be repaired on the way out');
    console.log('--- unreadable-ledger-entry test passed ---');
}

async function testFailedVerificationWritesNoLedgerEntry() {
    const ledgerDir = tmpLedgerDir();
    const s = scenario({
        pinned: '0.1.6',
        installedFiles: { 'dist/index.js': 'export const v = "0.1.5";' },
        publishedFiles: { 'dist/index.js': 'export const v = "0.1.6";' },
    });

    const result = await run(s, { ledgerDir });

    assert.strictEqual(result.failures.length, 1);
    assert.strictEqual(fs.existsSync(path.join(ledgerDir, 'demo-pkg', '0.1.6.json')), false,
        'a failed verification must not be recorded, or the next Job would trust it');
    console.log('--- failed-verification-writes-no-ledger test passed ---');
}

// --- slice C: dependencies are verified concurrently ---------------------
//
// Even with the tarball fetch gone, each dep still costs a registry round trip.
// Serialising them makes the step scale with dependency COUNT rather than with
// the slowest package.

// A workdir of `count` faithful packages whose fake npm is asynchronous and
// records how many calls are ever in flight at once. Later packages answer
// FASTER, so completion order differs from dependency order.
function concurrentScenario(count) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-conc-'));
    const modulesDir = path.join(root, 'node_modules');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-conc-pack-'));
    const deps = {};
    const tarballs = {};

    for (let i = 0; i < count; i++) {
        const name = `pkg-${i}`;
        const body = `export const n = ${i};`;
        deps[name] = '1.0.0';
        const pkgDir = path.join(modulesDir, name);
        fs.mkdirSync(pkgDir, { recursive: true });
        fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
        fs.writeFileSync(path.join(pkgDir, 'index.js'), body);
        tarballs[name] = makeTarGz({
            'package/package.json': JSON.stringify({ name, version: '1.0.0' }),
            'package/index.js': body,
        });
    }

    let inFlight = 0;
    let maxInFlight = 0;

    const exec = async (file, args) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
            const name = String(args[1]).split('@')[0];
            await new Promise((resolve) => setTimeout(resolve, (count - Number(name.slice(4))) * 2));
            if (args[0] === 'view') {
                return JSON.stringify({ name, version: '1.0.0', dist: { shasum: sha1(tarballs[name]) } });
            }
            const dest = args[args.indexOf('--pack-destination') + 1];
            const filename = `${name}-1.0.0.tgz`;
            fs.writeFileSync(path.join(dest, filename), tarballs[name]);
            return JSON.stringify([{ filename }]);
        } finally {
            inFlight -= 1;
        }
    };

    return { root, modulesDir, tmpDir, deps, exec, maxInFlight: () => maxInFlight };
}

async function testDependenciesAreVerifiedConcurrently() {
    const c = concurrentScenario(6);

    const result = await verifyIntegrity({
        workdir: c.root,
        modulesDir: c.modulesDir,
        deps: c.deps,
        exec: c.exec,
        tmpDir: c.tmpDir,
        log: quiet,
        concurrency: 3,
    });

    assert.deepStrictEqual(result.failures, []);
    assert.strictEqual(result.checked.length, 6);
    assert.ok(c.maxInFlight() > 1,
        `deps must be verified concurrently, saw at most ${c.maxInFlight()} registry call(s) in flight`);
    assert.ok(c.maxInFlight() <= 3,
        `concurrency must stay bounded, saw ${c.maxInFlight()} in flight for a limit of 3`);
    // Packages finish out of order here, so this pins reporting to dependency
    // order rather than completion order — the log must not shuffle run to run.
    assert.deepStrictEqual(result.checked.map((c2) => c2.name), Object.keys(c.deps));
    console.log('--- concurrent-verification test passed ---');
}

// Concurrency buys nothing if the default exec blocks the event loop, which is
// exactly what a *Sync child-process call does.
async function testDefaultExecDoesNotBlockTheEventLoop() {
    const order = [];
    const finished = defaultExec('sh', ['-c', 'exit 0']).then(() => order.push('exec'));
    setImmediate(() => order.push('loop'));
    await finished;

    assert.deepStrictEqual(order, ['loop', 'exec'],
        'the default exec must yield to the event loop, or the deps run serially anyway');
    console.log('--- default-exec-is-async test passed ---');
}

function testIsExactVersion() {
    for (const v of ['1.0.0', '0.1.6', '2.3.4-rc.1']) {
        assert.ok(isExactVersion(v), `${v} is exact`);
    }
    // Partial versions are ranges in npm, so they must not be treated as pins.
    for (const v of ['^1.0.0', '~1.0.0', '>=1.0.0', '1.x', '1.0', '1', 'latest', '*', '', undefined]) {
        assert.ok(!isExactVersion(v), `${v} must not be treated as exact`);
    }
    console.log('--- isExactVersion test passed ---');
}

// Long paths arrive via pax/GNU extension records; dropping them would silently
// skip exactly the deeply-nested files a stale build differs in.
function testReadTarGzHandlesLongPaths() {
    const deep = `package/dist/${'nested/'.repeat(20)}index.js`;
    assert.ok(deep.length > 100, 'fixture must exceed the 100-byte tar name field');

    // GNU long-name record ('L') followed by the real entry.
    const nameBody = Buffer.from(deep + '\0');
    const longHeader = Buffer.alloc(512);
    longHeader.write('././@LongLink', 0, 100, 'utf8');
    longHeader.write(nameBody.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf8');
    longHeader.write('L', 156, 1, 'utf8');

    const content = Buffer.from('deep file');
    const entryHeader = Buffer.alloc(512);
    entryHeader.write(deep.slice(0, 100), 0, 100, 'utf8');
    entryHeader.write(content.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf8');
    entryHeader.write('0', 156, 1, 'utf8');

    const pad = (b) => Buffer.alloc((512 - (b.length % 512)) % 512);
    const tar = Buffer.concat([
        longHeader, nameBody, pad(nameBody),
        entryHeader, content, pad(content),
        Buffer.alloc(1024),
    ]);

    const entries = readTarGz(zlib.gzipSync(tar));
    assert.ok(entries.has(deep), `long path should be recovered, got: ${[...entries.keys()]}`);
    assert.strictEqual(entries.get(deep).toString(), 'deep file');
    console.log('--- tar long-path test passed ---');
}

const TESTS = [
    testIsExactVersion,
    testReadTarGzHandlesLongPaths,
    testCleanInstallPasses,
    testCatchesStaleBytesUnderCorrectVersion,
    testCatchesWrongInstalledVersion,
    testTarballIsFetchedFromCacheButMetadataStaysOnline,
    testStaleCachedTarballIsRefetchedOnline,
    testCatchesRegistryShasumMismatch,
    testUnreachableRegistryIsNotAFailure,
    testSkipsNonExactPins,
    testResolveLedgerDir,
    testColdVerificationWritesALedgerEntry,
    testWarmLedgerSkipsTheTarballFetch,
    testLedgerEntryForOtherBytesIsIgnored,
    testWarmLedgerStillCatchesStaleInstalledBytes,
    testUnreadableLedgerEntryFallsBackToTheColdPath,
    testFailedVerificationWritesNoLedgerEntry,
    testDependenciesAreVerifiedConcurrently,
    testDefaultExecDoesNotBlockTheEventLoop,
];

async function main() {
    // ONLY=<substring> narrows the run, so a newly written test can be watched
    // failing on its own before the code that satisfies it exists.
    const only = process.env.ONLY;
    const selected = only ? TESTS.filter((t) => t.name.includes(only)) : TESTS;
    if (only && selected.length === 0) {
        throw new Error(`ONLY=${only} matched no test`);
    }
    for (const test of selected) {
        await test();
    }
    console.log(`--- All verify_integrity tests passed (${selected.length}) ---`);
}

main().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
