import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { optimize as optimizeSerial } from '../../scripts/utils/optimize.js';
import { optimizeConcurrent, optimizeSingleBuild, collectFiles } from './optimize-batched.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE_PKG = path.join(REPO_ROOT, 'bench', 'fixture', 'package.json');

/**
 * Strategies under test. Each mutates node_modules under `dir` in place. The
 * first is the current production implementation (the baseline); the rest are
 * the prototypes.
 */
const STRATEGIES = [
    { key: 'serial-build (current)', run: (dir) => optimizeSerial(path.join(dir, 'node_modules')) },
    { key: 'concurrent-transform x4', run: (dir) => optimizeConcurrent(path.join(dir, 'node_modules'), { concurrency: 4 }) },
    { key: 'concurrent-transform x16', run: (dir) => optimizeConcurrent(path.join(dir, 'node_modules'), { concurrency: 16 }) },
    { key: 'concurrent-transform x64', run: (dir) => optimizeConcurrent(path.join(dir, 'node_modules'), { concurrency: 64 }) },
    { key: 'single-build (all files)', run: (dir) => optimizeSingleBuild(path.join(dir, 'node_modules')) },
];

function parseArgs(argv) {
    const opts = { iterations: 4, warmup: 1 };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-n' || a === '--iterations') opts.iterations = Number(argv[++i]);
        else if (a === '--warmup') opts.warmup = Number(argv[++i]);
        else if (a === '-h' || a === '--help') opts.help = true;
        else throw new Error(`Unknown argument: ${a}`);
    }
    return opts;
}

function rmrf(t) { fs.rmSync(t, { recursive: true, force: true }); }

function median(xs) {
    const s = [...xs].sort((a, b) => a - b);
    const n = s.length;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

// Compare optimizer output independent of the inline sourcemap: two strategies
// applying the same esbuild transform must yield identical code bodies. The
// sourcemap comment can legitimately differ (source-name field), so strip it.
function stripSourceMap(code) {
    return code.replace(/\n?\/\/# sourceMappingURL=data:application\/json;[^\n]*\n?$/, '');
}

function buildSeed(tmpRoot) {
    const dir = path.join(tmpRoot, 'seed');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(FIXTURE_PKG, path.join(dir, 'package.json'));
    const install = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'ignore' });
    if (install.status !== 0) throw new Error('seed npm install failed');
    return dir;
}

function freshCopy(seedDir, dest) {
    rmrf(dest);
    fs.cpSync(seedDir, dest, { recursive: true });
    return dest;
}

// Every discovered file must carry an inline sourcemap after optimization.
function verify(dir) {
    const files = collectFiles(path.join(dir, 'node_modules'));
    let missing = 0;
    for (const f of files) {
        if (!fs.readFileSync(f, 'utf8').includes('sourceMappingURL=')) missing++;
    }
    return { total: files.length, missing };
}

// Byte-compare code bodies (sans sourcemap) of two optimized trees.
function equivalent(dirA, dirB) {
    const rel = (dir) => collectFiles(path.join(dir, 'node_modules'))
        .map((f) => path.relative(dir, f)).sort();
    const a = rel(dirA);
    const b = rel(dirB);
    if (a.length !== b.length) return { ok: false, reason: `file count ${a.length} vs ${b.length}` };
    let diffs = 0;
    for (const r of a) {
        const ca = stripSourceMap(fs.readFileSync(path.join(dirA, r), 'utf8'));
        const cb = stripSourceMap(fs.readFileSync(path.join(dirB, r), 'utf8'));
        if (ca !== cb) diffs++;
    }
    return { ok: diffs === 0, diffs };
}

async function timeStrategy(strategy, seedDir, tmpRoot, tag) {
    const dir = freshCopy(seedDir, path.join(tmpRoot, `run-${tag}`));
    const start = process.hrtime.bigint();
    await strategy.run(dir);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    return { ms, dir };
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        console.log('Usage: node bench.js [-n iterations] [--warmup n]\n\n' +
            'Compares the current serial optimize() against batched prototypes on the\n' +
            'react + i18next fixture, verifying identical output.');
        return;
    }

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'optimize-bench-'));
    try {
        process.stdout.write('building seed (npm install)... ');
        const seedDir = buildSeed(tmpRoot);
        const fileCount = collectFiles(path.join(seedDir, 'node_modules')).length;
        console.log(`done (${fileCount} files)\n`);

        // Reference output from the current implementation, kept for equivalence checks.
        const ref = await timeStrategy(STRATEGIES[0], seedDir, tmpRoot, 'reference');
        const refVerify = verify(ref.dir);

        const results = [];
        for (const strategy of STRATEGIES) {
            process.stdout.write(`> ${strategy.key.padEnd(26)} `);
            for (let w = 0; w < opts.warmup; w++) {
                const r = await timeStrategy(strategy, seedDir, tmpRoot, `${strategy.key}-w${w}`);
                rmrf(r.dir);
                process.stdout.write('.');
            }
            const samples = [];
            let lastDir = null;
            for (let i = 0; i < opts.iterations; i++) {
                const r = await timeStrategy(strategy, seedDir, tmpRoot, `${strategy.key}-${i}`);
                samples.push(r.ms);
                if (lastDir) rmrf(lastDir);
                lastDir = r.dir;
                process.stdout.write('#');
            }
            const v = verify(lastDir);
            const eq = equivalent(ref.dir, lastDir);
            rmrf(lastDir);
            const med = median(samples);
            results.push({ key: strategy.key, median: med, verify: v, equivalent: eq });
            console.log(` ${med.toFixed(0)}ms`);
        }
        rmrf(ref.dir);

        printTable(results, refVerify);
    } finally {
        rmrf(tmpRoot);
    }
}

function printTable(results, refVerify) {
    const base = results[0].median;
    console.log('\n=== optimize batching prototype ===');
    console.log(`baseline files: ${refVerify.total} (missing sourcemap: ${refVerify.missing})\n`);
    const rows = results.map((r) => ({
        strategy: r.key,
        median: `${r.median.toFixed(0)}ms`,
        speedup: `${(base / r.median).toFixed(2)}x`,
        sourcemaps: `${r.verify.total - r.verify.missing}/${r.verify.total}`,
        equal: r.key === results[0].key ? '(ref)' : (r.equivalent.ok ? 'yes' : `NO (${r.equivalent.diffs ?? r.equivalent.reason})`),
    }));
    const cols = ['strategy', 'median', 'speedup', 'sourcemaps', 'equal'];
    const w = {};
    for (const c of cols) w[c] = Math.max(c.length, ...rows.map((r) => String(r[c]).length));
    const fmt = (r) => cols.map((c) => String(r[c]).padEnd(w[c])).join('  ');
    console.log(fmt(Object.fromEntries(cols.map((c) => [c, c]))));
    console.log(cols.map((c) => '-'.repeat(w[c])).join('  '));
    for (const r of rows) console.log(fmt(r));
    console.log('\nspeedup = current serial median / strategy median (higher is better)');
}

main().catch((err) => { console.error('optimize bench failed:', err); process.exit(1); });
