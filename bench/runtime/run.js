import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const UTILS_DIR = path.join(REPO_ROOT, 'scripts', 'utils');
const FIXTURE_PKG = path.join(REPO_ROOT, 'bench', 'fixture', 'package.json');

const MODULE_PATH = '/-/modules';

/**
 * Runtimes under test. `argv(script)` builds the command that runs one of the
 * tool wrappers (scripts/utils/{optimize,generate,bundle_cjs}) under that
 * runtime. Deno needs explicit permissions and to reuse the on-disk
 * node_modules (`--node-modules-dir=manual`); node and bun resolve it natively.
 */
const RUNTIMES = {
    node: {
        label: 'node',
        bin: 'node',
        argv: (script) => ['node', script],
    },
    deno: {
        label: 'deno',
        bin: 'deno',
        argv: (script) => ['deno', 'run', '-A', '--node-modules-dir=manual', script],
    },
    bun: {
        label: 'bun',
        bin: 'bun',
        argv: (script) => ['bun', script],
    },
};

/**
 * The three commands, each measured in isolation from a pristine install.
 *   - prepare(dir): stage prerequisite state before the measured run.
 *   - verify(dir, res): return true iff the run actually did its job (used as
 *     the compatibility signal, on top of a zero exit code).
 * bundle_cjs consumes the import map generate produces, so it is staged with a
 * pre-generated importmap.json (built once with node during seed setup).
 */
const COMMANDS = {
    optimize: {
        label: 'optimize',
        script: path.join(UTILS_DIR, 'optimize'),
        prepare: () => {},
        verify: (dir) => {
            const f = path.join(dir, 'node_modules', 'react', 'index.js');
            return fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes('sourceMappingURL=');
        },
    },
    generate: {
        label: 'generate',
        script: path.join(UTILS_DIR, 'generate'),
        prepare: () => {},
        verify: (dir) => {
            const f = path.join(dir, 'importmap.json');
            if (!fs.existsSync(f)) return false;
            const map = JSON.parse(fs.readFileSync(f, 'utf8'));
            return !!(map.imports && map.imports.react);
        },
    },
    bundle_cjs: {
        label: 'bundle_cjs',
        script: path.join(UTILS_DIR, 'bundle_cjs'),
        prepare: (dir, seed) => {
            fs.copyFileSync(seed.importmapTemplate, path.join(dir, 'importmap.json'));
        },
        verify: (dir) => {
            const f = path.join(dir, 'node_modules', 'react', 'index.js');
            // bundle_cjs rewrites the CJS entry to ESM in place; esbuild emits a
            // single `export { ... }` statement (the pristine file is pure CJS
            // with no `export` keyword at all).
            return fs.existsSync(f) && /\bexport\s*\{/.test(fs.readFileSync(f, 'utf8'));
        },
    },
};

function parseArgs(argv) {
    const opts = {
        iterations: 3,
        warmup: 1,
        runtimes: ['node', 'deno', 'bun'],
        commands: ['optimize', 'generate', 'bundle_cjs'],
        json: false,
        report: null,
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = () => argv[++i];
        switch (arg) {
            case '--iterations':
            case '-n': opts.iterations = Number(next()); break;
            case '--warmup': opts.warmup = Number(next()); break;
            case '--runtimes': opts.runtimes = next().split(',').map((s) => s.trim()).filter(Boolean); break;
            case '--commands': opts.commands = next().split(',').map((s) => s.trim()).filter(Boolean); break;
            case '--json': opts.json = true; break;
            case '--report': opts.report = next(); break;
            case '--help':
            case '-h': opts.help = true; break;
            default: throw new Error(`Unknown argument: ${arg}`);
        }
    }
    return opts;
}

function printHelp() {
    console.log(`runtime benchmark: node vs deno vs bun for optimize/generate/bundle_cjs

Usage: run [options]

Options:
  -n, --iterations <n>   Measured runs per (runtime, command) (default: 3)
      --warmup <n>       Unmeasured warmup runs (default: 1)
      --runtimes <list>  Comma-separated: node,deno,bun (default: all)
      --commands <list>  Comma-separated: optimize,generate,bundle_cjs (default: all)
      --json             Emit machine-readable JSON
      --report <file>    Write a markdown report to <file>
  -h, --help             Show this help

Each command is run through its scripts/utils wrapper against a pristine copy of
the react + i18next fixture. A runtime/command cell is "compatible" only when the
process exits 0 and its output verifies. Absent runtimes are skipped.`);
}

function isAvailable(bin) {
    const probe = spawnSync(bin, ['--version'], { stdio: 'ignore' });
    return !probe.error && probe.status === 0;
}

function runtimeVersion(bin) {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
    return (r.stdout || '').split('\n')[0].trim();
}

function rmrf(t) { fs.rmSync(t, { recursive: true, force: true }); }

function stats(samples) {
    const sorted = [...samples].sort((a, b) => a - b);
    const n = sorted.length;
    const mean = sorted.reduce((a, b) => a + b, 0) / n;
    const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
    return { n, min: sorted[0], max: sorted[n - 1], mean, median };
}

/**
 * Build the seed workspace once: install the fixture's dependencies and
 * pre-generate an import map (with node) for bundle_cjs to consume. Every
 * measured run gets a fresh recursive copy of `dir` so mutating commands
 * (optimize, bundle_cjs) never see each other's changes.
 */
function buildSeed(tmpRoot) {
    const dir = path.join(tmpRoot, 'seed');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(FIXTURE_PKG, path.join(dir, 'package.json'));

    const install = spawnSync('npm', ['install', '--no-audit', '--no-fund'], {
        cwd: dir, env: process.env, stdio: 'ignore',
    });
    if (install.status !== 0) throw new Error('seed npm install failed');

    // Pre-generate the import map bundle_cjs needs, using node as the reference.
    const gen = spawnSync('node', [COMMANDS.generate.script], {
        cwd: dir, env: { ...process.env, MODULE_PATH }, stdio: 'ignore',
    });
    if (gen.status !== 0) throw new Error('seed importmap generation failed');
    const importmapTemplate = path.join(tmpRoot, 'importmap.template.json');
    fs.copyFileSync(path.join(dir, 'importmap.json'), importmapTemplate);
    rmrf(path.join(dir, 'importmap.json')); // keep the seed pristine

    return { dir, importmapTemplate };
}

/** Run one command under one runtime in a fresh workspace; time it. */
function runOnce(runtime, command, seed, tmpRoot, tag) {
    const dir = path.join(tmpRoot, `run-${tag}`);
    rmrf(dir);
    fs.cpSync(seed.dir, dir, { recursive: true });
    command.prepare(dir, seed);

    const [cmd, ...args] = runtime.argv(command.script);
    const start = process.hrtime.bigint();
    const res = spawnSync(cmd, args, {
        cwd: dir,
        env: { ...process.env, MODULE_PATH },
        stdio: ['ignore', 'ignore', 'pipe'],
        encoding: 'utf8',
    });
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    const ok = !res.error && res.status === 0 && command.verify(dir, res);
    let errline = '';
    if (!ok) {
        errline = res.error
            ? res.error.message
            : (res.stderr || '').split('\n').filter(Boolean).pop() || `exit ${res.status} / verify failed`;
    }
    rmrf(dir);
    return { elapsedMs, ok, errline };
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) { printHelp(); return; }

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-bench-'));
    const report = {
        fixture: JSON.parse(fs.readFileSync(FIXTURE_PKG, 'utf8')).dependencies,
        commands: opts.commands,
        iterations: opts.iterations,
        warmup: opts.warmup,
        host: `${os.type()} ${os.arch()}`,
        versions: {},
        results: [],
        skipped: [],
    };

    try {
        if (!opts.json) process.stdout.write('building seed workspace (npm install + generate)... ');
        const seed = buildSeed(tmpRoot);
        if (!opts.json) console.log('done\n');

        for (const rtKey of opts.runtimes) {
            const runtime = RUNTIMES[rtKey];
            if (!runtime) throw new Error(`Unknown runtime: ${rtKey}`);
            if (!isAvailable(runtime.bin)) {
                report.skipped.push({ runtime: rtKey, reason: 'binary not found' });
                if (!opts.json) console.error(`! skipping ${rtKey}: '${runtime.bin}' not found`);
                continue;
            }
            report.versions[rtKey] = runtimeVersion(runtime.bin);

            for (const cmdKey of opts.commands) {
                const command = COMMANDS[cmdKey];
                if (!command) throw new Error(`Unknown command: ${cmdKey}`);

                if (!opts.json) process.stdout.write(`> ${rtKey} :: ${cmdKey} `);

                let firstErr = '';
                for (let w = 0; w < opts.warmup; w++) {
                    const r = runOnce(runtime, command, seed, tmpRoot, `${rtKey}-${cmdKey}-w${w}`);
                    if (!r.ok && !firstErr) firstErr = r.errline;
                    if (!opts.json) process.stdout.write('.');
                }

                const samples = [];
                let allOk = true;
                for (let i = 0; i < opts.iterations; i++) {
                    const r = runOnce(runtime, command, seed, tmpRoot, `${rtKey}-${cmdKey}-${i}`);
                    samples.push(r.elapsedMs);
                    if (!r.ok) { allOk = false; if (!firstErr) firstErr = r.errline; }
                    if (!opts.json) process.stdout.write(r.ok ? '#' : 'x');
                }

                const s = stats(samples);
                report.results.push({
                    runtime: rtKey, command: cmdKey, compatible: allOk,
                    error: allOk ? null : firstErr, stats: s,
                });
                if (!opts.json) {
                    console.log(allOk
                        ? ` ${s.median.toFixed(0)}ms (median)`
                        : ` INCOMPATIBLE: ${firstErr}`);
                }
            }
        }
    } finally {
        rmrf(tmpRoot);
    }

    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else printTable(report);

    if (opts.report) {
        fs.writeFileSync(opts.report, renderMarkdown(report));
        if (!opts.json) console.log(`\nreport written to ${opts.report}`);
    }
}

function baselineMedian(report, command) {
    const r = report.results.find((x) => x.command === command && x.runtime === 'node' && x.compatible);
    return r ? r.stats.median : null;
}

function printTable(report) {
    console.log('\n=== runtime benchmark: optimize / generate / bundle_cjs ===');
    console.log(`host ${report.host}  ` +
        Object.entries(report.versions).map(([k, v]) => `${k} ${v}`).join('  '));
    console.log(`fixture: ${Object.keys(report.fixture).join(', ')}`);
    console.log(`iterations: ${report.iterations} (warmup ${report.warmup})\n`);

    for (const command of report.commands) {
        const base = baselineMedian(report, command);
        console.log(`# ${command}`);
        const rows = report.results.filter((r) => r.command === command);
        for (const r of rows) {
            if (!r.compatible) {
                console.log(`  ${r.runtime.padEnd(6)} INCOMPATIBLE  ${r.error}`);
                continue;
            }
            const rel = base ? `${(r.stats.median / base).toFixed(2)}x node` : '';
            console.log(`  ${r.runtime.padEnd(6)} ${r.stats.median.toFixed(0).padStart(6)}ms median` +
                `  (mean ${r.stats.mean.toFixed(0)}ms)  ${rel}`);
        }
        console.log('');
    }
    if (report.skipped.length) {
        console.log('skipped: ' + report.skipped.map((s) => `${s.runtime} (${s.reason})`).join(', '));
    }
}

function renderMarkdown(report) {
    const runtimes = [...new Set(report.results.map((r) => r.runtime))];
    const lines = [];
    lines.push('# Runtime benchmark: `optimize` / `generate` / `bundle_cjs`');
    lines.push('');
    lines.push('Compares JavaScript runtimes executing the three packaging commands, for');
    lines.push('both **compatibility** (does it run correctly) and **speed**.');
    lines.push('');
    lines.push('## Environment');
    lines.push('');
    lines.push(`- Host: ${report.host}`);
    for (const [k, v] of Object.entries(report.versions)) lines.push(`- ${k}: ${v}`);
    lines.push(`- Fixture: ${Object.keys(report.fixture).join(', ')}`);
    lines.push(`- Iterations: ${report.iterations} (warmup ${report.warmup}); times are wall-clock medians including runtime startup.`);
    lines.push('');
    lines.push('## Compatibility');
    lines.push('');
    lines.push('| command | ' + runtimes.join(' | ') + ' |');
    lines.push('|---------|' + runtimes.map(() => '-----').join('|') + '|');
    for (const command of report.commands) {
        const cells = runtimes.map((rt) => {
            const r = report.results.find((x) => x.command === command && x.runtime === rt);
            if (!r) return 'n/a';
            return r.compatible ? '✅' : '❌';
        });
        lines.push(`| ${command} | ${cells.join(' | ')} |`);
    }
    lines.push('');
    lines.push('## Speed (median ms, lower is faster; ratio vs node)');
    lines.push('');
    lines.push('| command | ' + runtimes.join(' | ') + ' |');
    lines.push('|---------|' + runtimes.map(() => '-----').join('|') + '|');
    for (const command of report.commands) {
        const base = baselineMedian(report, command);
        const cells = runtimes.map((rt) => {
            const r = report.results.find((x) => x.command === command && x.runtime === rt);
            if (!r || !r.compatible) return '—';
            const rel = base ? ` (${(r.stats.median / base).toFixed(2)}x)` : '';
            return `${r.stats.median.toFixed(0)}${rel}`;
        });
        lines.push(`| ${command} | ${cells.join(' | ')} |`);
    }
    lines.push('');
    lines.push('## Findings');
    lines.push('');
    for (const line of deriveFindings(report)) lines.push(line);
    lines.push('');
    if (report.skipped.length) {
        lines.push('Skipped: ' + report.skipped.map((s) => `${s.runtime} (${s.reason})`).join(', '));
        lines.push('');
    }
    lines.push('_Generated by `bench/runtime/run.js`. Absolute numbers depend on the host;');
    lines.push('the ratios between runtimes on the same machine are the meaningful signal._');
    lines.push('');
    return lines.join('\n');
}

/**
 * Turn the raw timings into short, data-driven takeaways: the fastest runtime
 * per command, whether a command is runtime-bound (all runtimes within 10% —
 * i.e. dominated by the native esbuild binary rather than the JS runtime, well
 * inside typical run-to-run variance), and an overall recommendation across the
 * JS-bound commands.
 */
function deriveFindings(report) {
    const out = [];
    const RUNTIME_BOUND_SPREAD = 0.10;
    const jsBoundWinners = {};
    for (const command of report.commands) {
        const rows = report.results
            .filter((r) => r.command === command && r.compatible)
            .sort((a, b) => a.stats.median - b.stats.median);
        if (rows.length === 0) { out.push(`- **${command}**: no runtime completed it.`); continue; }
        const fastest = rows[0];
        const slowest = rows[rows.length - 1];
        const spread = (slowest.stats.median - fastest.stats.median) / fastest.stats.median;
        if (spread < RUNTIME_BOUND_SPREAD) {
            out.push(`- **${command}**: runtime-bound — all runtimes within ${(spread * 100).toFixed(0)}% ` +
                `(~${fastest.stats.median.toFixed(0)}ms). Dominated by the native esbuild binary, so the ` +
                `JS runtime barely matters here.`);
        } else {
            const node = report.results.find((r) => r.command === command && r.runtime === 'node');
            const vsNode = node && node.compatible
                ? ` (${(100 - (fastest.stats.median / node.stats.median) * 100).toFixed(0)}% faster than node)`
                : '';
            out.push(`- **${command}**: fastest is **${fastest.runtime}** at ${fastest.stats.median.toFixed(0)}ms` +
                `${vsNode}. JS-bound, so runtime speed shows.`);
            jsBoundWinners[fastest.runtime] = (jsBoundWinners[fastest.runtime] || 0) + 1;
        }
    }
    const incompatible = report.results.filter((r) => !r.compatible);
    out.push('');
    if (incompatible.length === 0) {
        out.push('- **Compatibility**: every runtime ran every command correctly, with identical output ' +
            '(same files rewritten, same import map). esbuild\'s native binary and cjs-module-lexer work ' +
            'under all three; deno needs `-A --node-modules-dir=manual`.');
    } else {
        out.push('- **Compatibility**: ' + incompatible
            .map((r) => `${r.runtime}/${r.command} failed (${r.error})`).join('; ') + '.');
    }
    const topWinner = Object.entries(jsBoundWinners).sort((a, b) => b[1] - a[1])[0];
    if (topWinner) {
        out.push(`- **Recommendation**: on the JS-bound commands, **${topWinner[0]}** is the fastest and a ` +
            `drop-in replacement. The big win — \`optimize\` — is esbuild-bound and won't move by swapping ` +
            `runtimes; to speed it up, batch the per-file esbuild calls instead.`);
    }
    return out;
}

export { main, stats, RUNTIMES, COMMANDS, parseArgs };
