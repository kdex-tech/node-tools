// Correctness under a *variable* workload. The perf fixture (react + i18next)
// happens to be all .js with no malformed files, but real node_modules trees
// vary wildly: mixed .js/.mjs, occasional files esbuild can't parse, and nested
// node_modules. This builds a synthetic tree covering those cases and asserts
// each batched strategy behaves correctly — especially that .mjs stays .mjs.

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { optimizeConcurrent, optimizeSingleBuild, collectFiles } from '../optimize-batched.js';

function makeTree(root) {
    const nm = path.join(root, 'node_modules');
    const w = (p, c) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); };
    // CJS .js that reads NODE_ENV (should be define-substituted + get a sourcemap)
    w(path.join(nm, 'pkga', 'index.js'),
        'const env = process.env.NODE_ENV;\nmodule.exports = { env };\n');
    // ESM .mjs — must remain .mjs, must NOT spawn a sibling .js
    w(path.join(nm, 'pkga', 'esm.mjs'),
        'export const answer = 42;\nexport function hi() { return "hi"; }\n');
    w(path.join(nm, 'pkgc', 'util.mjs'),
        'export default function () { return process.env.NODE_ENV; }\n');
    // A file esbuild cannot parse — used to probe error resilience
    w(path.join(nm, 'pkgb', 'broken.js'),
        'this is (((not valid javascript @@@\n');
    // Nested node_modules — collectFiles must skip it entirely
    w(path.join(nm, 'pkgb', 'node_modules', 'dep', 'index.js'),
        'module.exports = 1;\n');
    return nm;
}

function hasSourceMap(p) { return fs.readFileSync(p, 'utf8').includes('sourceMappingURL='); }

function freshTree() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opt-correctness-'));
    makeTree(root);
    return root;
}

async function testConcurrentHandlesMixedTree() {
    console.log('--- concurrent-transform: mixed .js/.mjs + broken + nested ---');
    const root = freshTree();
    const nm = path.join(root, 'node_modules');
    try {
        const res = await optimizeConcurrent(nm, { concurrency: 8 });

        // .mjs preserved as .mjs, optimized, and no sibling .js created.
        const esm = path.join(nm, 'pkga', 'esm.mjs');
        assert.ok(fs.existsSync(esm), '.mjs still exists');
        assert.ok(hasSourceMap(esm), '.mjs got an inline sourcemap');
        assert.ok(!fs.existsSync(path.join(nm, 'pkga', 'esm.js')), 'no stray .js sibling for .mjs');
        assert.ok(hasSourceMap(path.join(nm, 'pkgc', 'util.mjs')), 'second .mjs optimized');

        // .js optimized and NODE_ENV substituted.
        const js = path.join(nm, 'pkga', 'index.js');
        assert.ok(hasSourceMap(js), '.js got a sourcemap');
        assert.ok(fs.readFileSync(js, 'utf8').includes('"production"'), 'NODE_ENV define applied');

        // Broken file: counted as a failure but did not abort the run.
        assert.strictEqual(res.failed, 1, 'exactly one file failed');
        assert.ok(!hasSourceMap(path.join(nm, 'pkgb', 'broken.js')), 'broken file left untouched');

        // Nested node_modules skipped entirely.
        assert.ok(!hasSourceMap(path.join(nm, 'pkgb', 'node_modules', 'dep', 'index.js')),
            'nested node_modules not walked');
        assert.strictEqual(res.count, 4, 'discovered 4 files (nested node_modules excluded)');

        console.log('--- passed: concurrent-transform is extension-safe and resilient ---');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

async function testSingleBuildPreservesMjs() {
    console.log('--- single-build: .mjs preserved on a clean tree ---');
    const root = freshTree();
    const nm = path.join(root, 'node_modules');
    // Remove the broken file so the single build() can complete (see resilience note).
    fs.rmSync(path.join(nm, 'pkgb'), { recursive: true, force: true });
    try {
        await optimizeSingleBuild(nm);
        const esm = path.join(nm, 'pkga', 'esm.mjs');
        assert.ok(fs.existsSync(esm) && hasSourceMap(esm), '.mjs preserved and optimized');
        assert.ok(!fs.existsSync(path.join(nm, 'pkga', 'esm.js')), 'no stray .js sibling for .mjs');
        assert.ok(hasSourceMap(path.join(nm, 'pkga', 'index.js')), '.js optimized');
        console.log('--- passed: single-build preserves .mjs via per-extension grouping ---');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

async function testSingleBuildAbortsOnBadFile() {
    console.log('--- single-build: one bad file aborts the whole batch (resilience tradeoff) ---');
    const root = freshTree();
    const nm = path.join(root, 'node_modules');
    try {
        await assert.rejects(() => optimizeSingleBuild(nm),
            'single build() rejects when any entry fails to parse');
        console.log('--- passed: documented single-build all-or-nothing failure mode ---');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

async function testCollectFilesSkips() {
    console.log('--- collectFiles skip rules ---');
    const root = freshTree();
    const nm = path.join(root, 'node_modules');
    try {
        const files = collectFiles(nm).map((f) => path.relative(nm, f)).sort();
        assert.ok(!files.some((f) => f.includes(`node_modules${path.sep}`)), 'nested node_modules excluded');
        assert.strictEqual(files.length, 4, 'four source files discovered');
        console.log('--- passed ---');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

async function run() {
    await testCollectFilesSkips();
    await testConcurrentHandlesMixedTree();
    await testSingleBuildPreservesMjs();
    await testSingleBuildAbortsOnBadFile();
    console.log('\n--- All optimize prototype correctness tests passed ---');
}

run().catch((err) => { console.error('correctness test failed:', err); process.exit(1); });
