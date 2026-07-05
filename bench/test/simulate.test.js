import assert from 'node:assert';
import { stats, parseArgs, INSTALLERS, SCENARIOS } from '../simulate.js';

function testStats() {
    console.log('--- Running stats test ---');
    const s = stats([10, 20, 30]);
    assert.strictEqual(s.n, 3, 'n should count all samples');
    assert.strictEqual(s.min, 10, 'min');
    assert.strictEqual(s.max, 30, 'max');
    assert.strictEqual(s.mean, 20, 'mean');
    assert.strictEqual(s.median, 20, 'median (odd length)');

    const even = stats([10, 20, 30, 40]);
    assert.strictEqual(even.median, 25, 'median (even length averages middle two)');
    console.log('--- stats test passed ---');
}

function testParseArgs() {
    console.log('--- Running parseArgs test ---');
    const def = parseArgs([]);
    assert.strictEqual(def.iterations, 3, 'default iterations');
    assert.deepStrictEqual(def.installers, ['npm', 'bun'], 'default installers');

    const custom = parseArgs(['-n', '5', '--installers', 'bun', '--scenarios', 'cold,warm', '--json']);
    assert.strictEqual(custom.iterations, 5, 'iterations override');
    assert.deepStrictEqual(custom.installers, ['bun'], 'installers override');
    assert.deepStrictEqual(custom.scenarios, ['cold', 'warm'], 'scenarios override');
    assert.strictEqual(custom.json, true, 'json flag');

    assert.throws(() => parseArgs(['--bogus']), /Unknown argument/, 'rejects unknown args');
    console.log('--- parseArgs test passed ---');
}

function testDefinitions() {
    console.log('--- Running definitions test ---');
    assert.ok(INSTALLERS.npm && INSTALLERS.bun, 'both installers defined');
    const npmSpec = INSTALLERS.npm.install('/tmp/cache');
    assert.ok(npmSpec.args.includes('--cache'), 'npm uses isolated cache dir');
    const bunSpec = INSTALLERS.bun.install('/tmp/cache');
    assert.strictEqual(bunSpec.env.BUN_INSTALL_CACHE_DIR, '/tmp/cache', 'bun uses isolated cache dir');
    assert.ok(SCENARIOS.frozen.frozen, 'frozen scenario runs a frozen install');
    console.log('--- definitions test passed ---');
}

testStats();
testParseArgs();
testDefinitions();
console.log('--- All simulate unit tests passed ---');
