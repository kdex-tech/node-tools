import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, 'fixture');

/**
 * Lockfiles that any of the installers may produce. We remove all of them
 * between runs so that each installer starts from an equivalent state and
 * one installer's lockfile can never bias another.
 */
const ALL_LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'bun.lockb', 'bun.lock'];

/**
 * Installer definitions. `resolve()` returns the absolute path to the binary
 * or null when it is not available on the current machine, letting us skip
 * gracefully instead of failing the whole simulation.
 */
const INSTALLERS = {
    npm: {
        label: 'npm',
        bin: 'npm',
        lockfile: 'package-lock.json',
        // A private, per-installer cache keeps the simulation hermetic and
        // avoids polluting (or being sped up by) the developer's real cache.
        install: (cacheDir) => ({
            cmd: 'npm',
            args: ['install', '--no-audit', '--no-fund', '--cache', cacheDir],
            env: {},
        }),
    },
    bun: {
        label: 'bun',
        bin: 'bun',
        lockfile: 'bun.lock',
        install: (cacheDir) => ({
            cmd: 'bun',
            args: ['install', '--no-progress'],
            env: { BUN_INSTALL_CACHE_DIR: cacheDir },
        }),
    },
};

/**
 * Two branches per installer model the two states an install commonly happens
 * from:
 *   - cold : empty cache   -> full resolve + network download
 *   - warm : populated cache -> resolve + link from cache
 */
const SCENARIOS = {
    cold: {
        label: 'cold (empty cache)',
        clearCache: true,
    },
    warm: {
        label: 'warm (populated cache)',
        clearCache: false,
    },
};

function parseArgs(argv) {
    const opts = {
        iterations: 3,
        warmup: 1,
        installers: ['npm', 'bun'],
        scenarios: ['cold', 'warm'],
        json: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = () => argv[++i];
        switch (arg) {
            case '--iterations':
            case '-n':
                opts.iterations = Number(next());
                break;
            case '--warmup':
                opts.warmup = Number(next());
                break;
            case '--installers':
                opts.installers = next().split(',').map((s) => s.trim()).filter(Boolean);
                break;
            case '--scenarios':
                opts.scenarios = next().split(',').map((s) => s.trim()).filter(Boolean);
                break;
            case '--json':
                opts.json = true;
                break;
            case '--help':
            case '-h':
                opts.help = true;
                break;
            default:
                throw new Error(`Unknown argument: ${arg}`);
        }
    }
    return opts;
}

function printHelp() {
    console.log(`bun-vs-npm install benchmark simulation

Usage: simulate [options]

Options:
  -n, --iterations <n>    Measured runs per branch (default: 3)
      --warmup <n>        Unmeasured warmup runs per branch (default: 1)
      --installers <list> Comma-separated: npm,bun (default: npm,bun)
      --scenarios <list>  Comma-separated: cold,warm (default: both)
      --json              Emit machine-readable JSON instead of a table
  -h, --help              Show this help

Branches (run for each installer):
  cold    empty cache   (full resolve + download)
  warm    populated cache (resolve + link from cache)

The fixture installed is a realistic React + i18next set: react, react-dom,
i18next, react-i18next, html-parse-stringify, void-elements
(see bench/fixture/package.json).`);
}

function isAvailable(bin) {
    const probe = spawnSync(bin, ['--version'], { stdio: 'ignore' });
    return !probe.error && probe.status === 0;
}

function rmrf(target) {
    fs.rmSync(target, { recursive: true, force: true });
}

/** Reset the working dir to a pristine copy of the fixture package.json. */
function resetWorkdir(workdir) {
    rmrf(workdir);
    fs.mkdirSync(workdir, { recursive: true });
    fs.copyFileSync(
        path.join(FIXTURE_DIR, 'package.json'),
        path.join(workdir, 'package.json'),
    );
}

function removeLockfiles(workdir) {
    for (const name of ALL_LOCKFILES) {
        rmrf(path.join(workdir, name));
    }
}

/** Run a single install command, returning elapsed milliseconds. */
function timedInstall(spec, workdir) {
    const start = process.hrtime.bigint();
    const result = spawnSync(spec.cmd, spec.args, {
        cwd: workdir,
        env: { ...process.env, ...spec.env },
        stdio: 'ignore',
    });
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    if (result.error) {
        throw new Error(`${spec.cmd} failed to spawn: ${result.error.message}`);
    }
    if (result.status !== 0) {
        throw new Error(`${spec.cmd} ${spec.args.join(' ')} exited with code ${result.status}`);
    }
    return elapsedMs;
}

function stats(samples) {
    const sorted = [...samples].sort((a, b) => a - b);
    const n = sorted.length;
    const sum = sorted.reduce((a, b) => a + b, 0);
    const mean = sum / n;
    const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
    const variance = sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
    return {
        n,
        min: sorted[0],
        max: sorted[n - 1],
        mean,
        median,
        stddev: Math.sqrt(variance),
    };
}

/**
 * Prepare per-run state according to the branch, then execute one measured
 * install. `cacheDir` is stable across a branch's runs so warm can reuse it;
 * cold clears it before every run.
 */
function runOnce(installer, scenario, workdir, cacheDir) {
    // node_modules and lockfiles are always removed so every run does real,
    // equivalent install work regardless of installer.
    rmrf(path.join(workdir, 'node_modules'));
    removeLockfiles(workdir);

    // A cold measurement must start from an empty cache on *every* run,
    // otherwise a prior run (or warmup) silently turns it into a warm install.
    if (scenario.clearCache) {
        rmrf(cacheDir);
        fs.mkdirSync(cacheDir, { recursive: true });
    }

    return timedInstall(installer.install(cacheDir), workdir);
}

/**
 * Run one unmeasured install to populate the (isolated) cache. Used by the
 * warm branch so its measurements never depend on the warmup count. Any
 * lockfile it leaves behind is stripped again before measured runs by runOnce().
 */
function seedInstall(installer, workdir, cacheDir) {
    rmrf(path.join(workdir, 'node_modules'));
    removeLockfiles(workdir);
    timedInstall(installer.install(cacheDir), workdir);
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        printHelp();
        return;
    }

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'install-bench-'));
    const report = {
        fixture: JSON.parse(
            fs.readFileSync(path.join(FIXTURE_DIR, 'package.json'), 'utf8'),
        ).dependencies,
        iterations: opts.iterations,
        warmup: opts.warmup,
        node: process.version,
        results: [],
        skipped: [],
    };

    try {
        for (const installerKey of opts.installers) {
            const installer = INSTALLERS[installerKey];
            if (!installer) {
                throw new Error(`Unknown installer: ${installerKey}`);
            }
            if (!isAvailable(installer.bin)) {
                report.skipped.push({ installer: installerKey, reason: 'binary not found' });
                if (!opts.json) {
                    console.error(`! skipping ${installer.label}: '${installer.bin}' not found on PATH`);
                }
                continue;
            }

            report.version = report.version || {};
            report.version[installerKey] = spawnSync(installer.bin, ['--version'], { encoding: 'utf8' })
                .stdout.trim();

            for (const scenarioKey of opts.scenarios) {
                const scenario = SCENARIOS[scenarioKey];
                if (!scenario) {
                    throw new Error(`Unknown scenario: ${scenarioKey}`);
                }

                const workdir = path.join(tmpRoot, `${installerKey}-${scenarioKey}`);
                // Each (installer, branch) pair gets an isolated cache dir.
                const cacheDir = path.join(tmpRoot, `cache-${installerKey}-${scenarioKey}`);
                resetWorkdir(workdir);
                fs.mkdirSync(cacheDir, { recursive: true });

                if (!scenario.clearCache) {
                    // The warm branch measures installs against a populated cache;
                    // prime it once so results don't depend on the warmup count.
                    seedInstall(installer, workdir, cacheDir);
                }

                if (!opts.json) {
                    process.stdout.write(`> ${installer.label} :: ${scenario.label} `);
                }

                // Warmup runs populate caches / OS file buffers and are discarded.
                for (let w = 0; w < opts.warmup; w++) {
                    runOnce(installer, scenario, workdir, cacheDir);
                    if (!opts.json) process.stdout.write('.');
                }

                const samples = [];
                for (let i = 0; i < opts.iterations; i++) {
                    samples.push(runOnce(installer, scenario, workdir, cacheDir));
                    if (!opts.json) process.stdout.write('#');
                }

                const s = stats(samples);
                report.results.push({
                    installer: installerKey,
                    scenario: scenarioKey,
                    samples,
                    stats: s,
                });
                if (!opts.json) {
                    console.log(` ${s.mean.toFixed(0)}ms (median ${s.median.toFixed(0)}ms)`);
                }
            }
        }
    } finally {
        rmrf(tmpRoot);
    }

    if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        printTable(report);
    }
}

function printTable(report) {
    console.log('\n=== install benchmark: bun vs npm ===');
    console.log(`node ${report.node}` + (report.version
        ? '  ' + Object.entries(report.version).map(([k, v]) => `${k} ${v}`).join('  ')
        : ''));
    console.log(`fixture: ${Object.entries(report.fixture).map(([k, v]) => `${k}@${v}`).join(', ')}`);
    console.log(`iterations: ${report.iterations} (warmup ${report.warmup})\n`);

    const cols = ['scenario', 'installer', 'mean', 'median', 'min', 'max', 'stddev'];
    const rows = report.results.map((r) => ({
        scenario: r.scenario,
        installer: r.installer,
        mean: `${r.stats.mean.toFixed(0)}ms`,
        median: `${r.stats.median.toFixed(0)}ms`,
        min: `${r.stats.min.toFixed(0)}ms`,
        max: `${r.stats.max.toFixed(0)}ms`,
        stddev: `${r.stats.stddev.toFixed(0)}ms`,
    }));
    const widths = {};
    for (const c of cols) {
        widths[c] = Math.max(c.length, ...rows.map((r) => String(r[c]).length));
    }
    const fmtRow = (r) => cols.map((c) => String(r[c]).padEnd(widths[c])).join('  ');
    console.log(fmtRow(Object.fromEntries(cols.map((c) => [c, c]))));
    console.log(cols.map((c) => '-'.repeat(widths[c])).join('  '));
    for (const r of rows) console.log(fmtRow(r));

    // Head-to-head speedup per scenario when both installers ran.
    const byScenario = {};
    for (const r of report.results) {
        (byScenario[r.scenario] ||= {})[r.installer] = r.stats.median;
    }
    const comparisons = Object.entries(byScenario).filter(
        ([, m]) => m.npm != null && m.bun != null,
    );
    if (comparisons.length) {
        console.log('\nhead-to-head (median, lower is faster):');
        for (const [scenario, m] of comparisons) {
            const faster = m.bun < m.npm ? 'bun' : 'npm';
            const ratio = Math.max(m.npm, m.bun) / Math.min(m.npm, m.bun);
            console.log(`  ${scenario}: ${faster} is ${ratio.toFixed(2)}x faster ` +
                `(npm ${m.npm.toFixed(0)}ms vs bun ${m.bun.toFixed(0)}ms)`);
        }
    }
    if (report.skipped.length) {
        console.log('\nskipped: ' + report.skipped
            .map((s) => `${s.installer} (${s.reason})`).join(', '));
    }
}

export { main, stats, INSTALLERS, SCENARIOS, parseArgs };
