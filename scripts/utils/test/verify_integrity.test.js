import assert from 'assert';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';

import { isExactVersion, readTarGz, verifyIntegrity } from '../verify_integrity.js';

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

// Builds a workdir with an installed node_modules tree, plus a fake npm that
// answers `view` from the registry metadata and `pack` with a prepared tarball.
function scenario({ pinned, installedFiles, publishedFiles, installedVersion }) {
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

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-pack-'));

    const exec = (file, args) => {
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
            assert.ok(args.includes('--prefer-online'), 'the tarball must be fetched fresh too');
            const dest = args[args.indexOf('--pack-destination') + 1];
            const filename = `demo-pkg-${pinned}.tgz`;
            fs.writeFileSync(path.join(dest, filename), tarball);
            return JSON.stringify([{ filename }]);
        }
        throw new Error(`unexpected npm invocation: ${args.join(' ')}`);
    };

    return { root, modulesDir, exec, tmpDir, tarball };
}

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

async function main() {
    testIsExactVersion();
    testReadTarGzHandlesLongPaths();
    await testCleanInstallPasses();
    await testCatchesStaleBytesUnderCorrectVersion();
    await testCatchesWrongInstalledVersion();
    await testCatchesRegistryShasumMismatch();
    await testUnreachableRegistryIsNotAFailure();
    await testSkipsNonExactPins();
    console.log('--- All verify_integrity tests passed ---');
}

main().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
