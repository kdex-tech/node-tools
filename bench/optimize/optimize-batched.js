// Prototype: batched variants of scripts/utils/optimize.js.
//
// The production optimize() awaits one esbuild build() per file, serially, so
// 376 files become 376 round-trips to the esbuild service one at a time — on a
// multi-core box that leaves every core but one idle. These prototypes keep the
// exact same per-file transform (define NODE_ENV, inline sourcemap) but feed
// esbuild in batches so its internal worker pool stays saturated.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Resolve esbuild from the tooling package (scripts/utils/node_modules), the
// same install the production optimize.js uses — the prototype adds no deps of
// its own. Requires `scripts/utils` deps to be installed (e.g. `make test`).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.resolve(__dirname, '..', '..', 'scripts', 'utils', 'package.json'));
const { build, transform } = require('esbuild');

// Identical file-discovery walk to scripts/utils/optimize.js (kept in sync by
// hand so the prototype measures the same workload).
export function collectFiles(targetDir) {
    const files = [];
    (function walk(dir) {
        if (!fs.existsSync(dir)) return;
        for (const file of fs.readdirSync(dir)) {
            const fullPath = path.join(dir, file);
            if (file.startsWith('.') || file === 'node_modules' || file === 'bin'
                || file === 'test' || file === '__tests__') continue;
            let stat;
            try { stat = fs.statSync(fullPath); } catch { continue; }
            if (stat.isDirectory()) walk(fullPath);
            else if (file.endsWith('.js') || file.endsWith('.mjs')) files.push(fullPath);
        }
    })(targetDir);
    return Array.from(new Set(files));
}

const DEFINE = { 'process.env.NODE_ENV': '"production"' };

/**
 * Strategy A — concurrency pool over the `transform` API.
 * Reads/writes each file itself and keeps `concurrency` transforms in flight, so
 * esbuild processes them across all its worker threads. In-place overwrite is
 * explicit, so file extensions (.js/.mjs) are always preserved.
 */
export async function optimizeConcurrent(targetDir = 'node_modules', { concurrency = 16 } = {}) {
    const files = collectFiles(targetDir);
    let next = 0;
    let failed = 0;

    async function worker() {
        for (;;) {
            const i = next++;
            if (i >= files.length) return;
            const file = files[i];
            try {
                const code = fs.readFileSync(file, 'utf8');
                const out = await transform(code, {
                    loader: 'js',
                    define: DEFINE,
                    sourcemap: 'inline',
                    sourcesContent: true,
                    sourcefile: path.basename(file),
                    logLevel: 'error',
                });
                fs.writeFileSync(file, out.code);
            } catch (e) {
                failed++;
                console.error(`Failed to optimize ${file}: ${e.message}`);
            }
        }
    }

    const workers = Math.max(1, Math.min(concurrency, files.length));
    await Promise.all(Array.from({ length: workers }, worker));
    return { count: files.length, failed };
}

/**
 * Strategy B — a single `build` call for all files.
 * One round-trip; esbuild parallelizes internally. Files are grouped by
 * extension so the output extension matches the input (esbuild would otherwise
 * rewrite .mjs -> .js). outbase === outdir === targetDir maps every output back
 * onto its source path; allowOverwrite lets it write in place.
 */
export async function optimizeSingleBuild(targetDir = 'node_modules') {
    const files = collectFiles(targetDir).map((f) => path.resolve(f));
    const base = path.resolve(targetDir);
    const groups = { js: [], mjs: [] };
    for (const f of files) groups[f.endsWith('.mjs') ? 'mjs' : 'js'].push(f);

    for (const [ext, list] of Object.entries(groups)) {
        if (list.length === 0) continue;
        await build({
            entryPoints: list,
            bundle: false,
            write: true,
            outdir: base,
            outbase: base,
            allowOverwrite: true,
            outExtension: ext === 'mjs' ? { '.js': '.mjs' } : undefined,
            define: DEFINE,
            sourcemap: 'inline',
            sourcesContent: true,
            logLevel: 'error',
        });
    }
    return { count: files.length };
}

// CLI: `node optimize-batched.js <concurrent|single> [targetDir]` — lets the
// prototype run as a subprocess (e.g. from the browser-safety pipeline) the
// same way the production `optimize` wrapper does.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const strategy = process.argv[2] || 'concurrent';
    const target = process.argv[3] || 'node_modules';
    const run = strategy === 'single' ? optimizeSingleBuild : optimizeConcurrent;
    run(target).catch((err) => { console.error(err); process.exit(1); });
}
