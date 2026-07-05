import assert from 'node:assert';
import { stats, parseArgs, RUNTIMES, COMMANDS } from '../run.js';

function testStats() {
    console.log('--- Running stats test ---');
    const s = stats([10, 20, 30]);
    assert.strictEqual(s.n, 3);
    assert.strictEqual(s.min, 10);
    assert.strictEqual(s.max, 30);
    assert.strictEqual(s.mean, 20);
    assert.strictEqual(s.median, 20);
    assert.strictEqual(stats([10, 20, 30, 40]).median, 25, 'even-length median');
    console.log('--- stats test passed ---');
}

function testParseArgs() {
    console.log('--- Running parseArgs test ---');
    const def = parseArgs([]);
    assert.strictEqual(def.iterations, 3);
    assert.deepStrictEqual(def.runtimes, ['node', 'deno', 'bun']);
    assert.deepStrictEqual(def.commands, ['optimize', 'generate', 'bundle_cjs']);

    const custom = parseArgs(['-n', '5', '--runtimes', 'node,bun', '--commands', 'generate', '--report', 'r.md']);
    assert.strictEqual(custom.iterations, 5);
    assert.deepStrictEqual(custom.runtimes, ['node', 'bun']);
    assert.deepStrictEqual(custom.commands, ['generate']);
    assert.strictEqual(custom.report, 'r.md');

    assert.throws(() => parseArgs(['--nope']), /Unknown argument/);
    console.log('--- parseArgs test passed ---');
}

function testDefinitions() {
    console.log('--- Running definitions test ---');
    assert.deepStrictEqual(Object.keys(RUNTIMES), ['node', 'deno', 'bun']);
    assert.deepStrictEqual(Object.keys(COMMANDS), ['optimize', 'generate', 'bundle_cjs']);

    // node/bun invoke the wrapper directly; deno needs permissions + node_modules.
    assert.deepStrictEqual(RUNTIMES.node.argv('/x'), ['node', '/x']);
    assert.deepStrictEqual(RUNTIMES.bun.argv('/x'), ['bun', '/x']);
    const denoArgv = RUNTIMES.deno.argv('/x');
    assert.ok(denoArgv.includes('-A'), 'deno passes -A');
    assert.ok(denoArgv.includes('--node-modules-dir=manual'), 'deno reuses on-disk node_modules');
    console.log('--- definitions test passed ---');
}

testStats();
testParseArgs();
testDefinitions();
console.log('--- All runtime-bench unit tests passed ---');
