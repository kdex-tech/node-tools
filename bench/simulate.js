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
        frozen: (cacheDir) => ({
            cmd: 'npm',
            args: ['ci', '--no-audit', '--no-fund', '--cache', cacheDir],
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
        frozen: (cacheDir) => ({
            cmd: 'bun',
            args: ['install', '--no-progress', '--frozen-lockfile'],
            env: { BUN_INSTALL_CACHE_DIR: cacheDir },
        }),
    },
};

/**
 * Scenarios model the three states an install commonly happens from:
 *   - cold      : empty cache, no lockfile   -> full resolve + network download
 *   - warm      : populated cache, no lockfile -> resolve + link from cache
 *   - frozen    : lockfile present, warm cache -> reproducible install (npm ci / --frozen-lockfile)
 */
const SCENARIOS = {
    cold: {
        label: 'cold (empty cache, no lockfile)',
        clearCache: true,
        keepLockfile: false,
        frozen: false,
    },
    warm: {
        label: 'warm (cached, no lockfile)',
        clearCache: false,
        keepLockfile: false,
        frozen: false,
    },
    frozen: {
        label: 'frozen (lockfile + cache)',
        clearCache: false,
        keepLockfile: true,
        frozen: true,
    },
};

function parseArgs(argv) {
    const opts = {
        iterations: 3,
        warmup: 1,
        installers: ['npm', 'bun'],
        scenarios: ['cold', 'warm', 'frozen'],
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
  -n, --iterations <n>    Measured runs per scenario (default: 3)
      --warmup <n>        Unmeasured warmup runs per scenario (default: 1)
      --installers <list> Comma-separated: npm,bun (default: npm,bun)
      --scenarios <list>  Comma-separated: cold,warm,frozen (default: all)
      --json              Emit machine-readable JSON instead of a table
  -h, --help              Show this help

Scenarios:
  cold    empty cache, no lockfile   (full resolve + download)
  warm    populated cache, no lockfile (resolve + link from cache)
  frozen  lockfile present + cache    (npm ci / bun install --frozen-lockfile)

The fixture installed is react + react-dom + i18next + react-i18next
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
 * Prepare per-run state according to the scenario, then execute one measured
 * install. `cacheDir` is stable across a scenario's runs so warm/frozen can
 * reuse it; cold clears it up front (handled by the caller).
 */
function runOnce(installer, scenario, workdir, cacheDir) {
    // node_modules is always removed so every run does real install work.
    rmrf(path.join(workdir, 'node_modules'));

    // A cold measurement must start from an empty cache on *every* run,
    // otherwise a prior run (or warmup) silently turns it into a warm install.
    if (scenario.clearCache) {
        rmrf(cacheDir);
        fs.mkdirSync(cacheDir, { recursive: true });
    }

    if (!scenario.keepLockfile) {
        removeLockfiles(workdir);
    }

    const spec = scenario.frozen
        ? installer.frozen(cacheDir)
        : installer.install(cacheDir);
    return timedInstall(spec, workdir);
}

/**
 * Run one unmeasured install to prime state. This populates the (isolated)
 * cache for warm/frozen scenarios and produces the lockfile the frozen
 * scenario needs. Any lockfile it leaves behind is stripped again before
 * measured non-frozen runs by runOnce().
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
                // Each (installer, scenario) pair gets an isolated cache dir.
                const cacheDir = path.join(tmpRoot, `cache-${installerKey}-${scenarioKey}`);
                resetWorkdir(workdir);

                if (scenario.clearCache) {
                    rmrf(cacheDir);
                }
                fs.mkdirSync(cacheDir, { recursive: true });

                if (!scenario.clearCache) {
                    // warm/frozen measure installs against a populated cache (and
                    // frozen needs a lockfile); prime both so results don't depend
                    // on the warmup count.
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
