import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { optimize } from '../optimize.js';

// bun installs packages by HARDLINKING them out of its global install cache, so
// node_modules/<pkg>/x.js and the cache's copy can be the same inode. esbuild
// writes optimize's output in place, and an in-place write follows a hardlink —
// so optimizing used to rewrite the cache's copy too.
//
// That poisons every later install of that package: it starts from
// already-optimized sources and gets optimized again. In the packager,
// BUN_INSTALL_CACHE_DIR lives on a persistent volume (CacheClaim), so the
// corruption outlives the Job and compounds build over build. It also trips the
// integrity verification added for kdex-tech/host-manager#161, since the
// installed bytes no longer match the published tarball.
async function testOptimizeDoesNotWriteThroughHardlinks() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'optimize-hardlink-'));
    const cacheDir = path.join(root, 'cache');
    const pkgDir = path.join(root, 'node_modules', 'demo');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.mkdirSync(pkgDir, { recursive: true });

    const original = 'export const answer = 42;\n';
    const cached = path.join(cacheDir, 'index.js');
    const installed = path.join(pkgDir, 'index.js');
    fs.writeFileSync(cached, original);
    fs.linkSync(cached, installed); // exactly what bun does

    assert.strictEqual(fs.statSync(installed).nlink, 2, 'fixture must start as a hardlink');

    console.log('--- Running optimize hardlink test ---');
    await optimize(path.join(root, 'node_modules'));

    const installedAfter = fs.readFileSync(installed, 'utf8');
    const cachedAfter = fs.readFileSync(cached, 'utf8');

    assert.ok(
        installedAfter.includes('sourceMappingURL='),
        'the installed copy must still be optimized'
    );
    assert.strictEqual(
        cachedAfter, original,
        'the CACHE copy must be untouched — writing through the hardlink poisons every later install'
    );
    assert.strictEqual(
        fs.statSync(installed).nlink, 1,
        'the installed path must have its own inode after optimize'
    );

    fs.rmSync(root, { recursive: true, force: true });
    console.log('--- Optimize hardlink test passed ---');
}

// A plain, unshared file must still be optimized in place with no extra copy.
async function testUnsharedFileStillOptimized() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'optimize-plain-'));
    const pkgDir = path.join(root, 'node_modules', 'demo');
    fs.mkdirSync(pkgDir, { recursive: true });
    const file = path.join(pkgDir, 'index.js');
    fs.writeFileSync(file, 'export const answer = 42;\n');

    await optimize(path.join(root, 'node_modules'));

    assert.ok(fs.readFileSync(file, 'utf8').includes('sourceMappingURL='));
    assert.ok(!fs.existsSync(`${file}.optimize-unlink`), 'no temp file may be left behind');

    fs.rmSync(root, { recursive: true, force: true });
    console.log('--- Optimize unshared-file test passed ---');
}

async function main() {
    await testOptimizeDoesNotWriteThroughHardlinks();
    await testUnsharedFileStillOptimized();
    console.log('--- All optimize hardlink tests passed ---');
}

main().catch((err) => {
    console.error('Test failed:', err);
    process.exit(1);
});
