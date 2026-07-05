import { build } from 'esbuild';
import fs from 'fs';
import os from 'os';
import path from 'path';

// How many esbuild build() calls to keep in flight at once. optimize() awaited
// one build() per file serially, which pins a single core while esbuild's
// worker pool sits idle; running a bounded pool concurrently saturates it and
// is ~2.5x faster on the react + i18next fixture. Each build() call is
// unchanged, so the output is byte-for-byte identical to the serial version
// (see bench/optimize). Override with OPTIMIZE_CONCURRENCY.
const DEFAULT_CONCURRENCY = Math.max(4, (os.availableParallelism?.() ?? os.cpus().length) * 4);

export async function optimize(targetDir = 'node_modules', options = {}) {
    const files = [];

    function walk(dir) {
        if (!fs.existsSync(dir)) return;
        const list = fs.readdirSync(dir);
        for (const file of list) {
            const fullPath = path.join(dir, file);

            // Skip hidden directories, node_modules sub-repos, and common garbage
            if (file.startsWith('.') || file === 'node_modules' || file === 'bin' || file === 'test' || file === '__tests__') continue;

            let stat;
            try {
                stat = fs.statSync(fullPath);
            } catch (e) { continue; }

            if (stat.isDirectory()) {
                walk(fullPath);
            } else if (file.endsWith('.js') || file.endsWith('.mjs')) {
                files.push(fullPath);
            }
        }
    }

    console.log(`--- Discovering source files in ${targetDir} ---`);
    if (!fs.existsSync(targetDir)) {
        console.log(`${targetDir} not found, skipping optimization.`);
        return;
    }

    walk(targetDir);

    const uniqueFiles = Array.from(new Set(files));
    console.log('Found ' + uniqueFiles.length + ' unique files to optimize.');

    async function optimizeFile(file) {
        try {
            await build({
                entryPoints: [file],
                bundle: false,
                allowOverwrite: true,
                outfile: file,
                define: { 'process.env.NODE_ENV': '"production"' },
                sourcemap: 'inline',
                sourcesContent: true,
                logLevel: 'error',
            });
        } catch (e) {
            // Isolate per-file failures exactly as the serial loop did: a file
            // esbuild can't parse is logged and skipped, the rest continue.
            console.error("Failed to optimize " + file + ": " + e.message);
        }
    }

    // Bounded worker pool over the file list. Each worker pulls the next index
    // until the list is exhausted, keeping `concurrency` build() calls in flight.
    const concurrency = options.concurrency
        || Number(process.env.OPTIMIZE_CONCURRENCY)
        || DEFAULT_CONCURRENCY;
    let next = 0;
    async function worker() {
        for (;;) {
            const i = next++;
            if (i >= uniqueFiles.length) return;
            await optimizeFile(uniqueFiles[i]);
        }
    }
    const workerCount = Math.max(1, Math.min(concurrency, uniqueFiles.length));
    await Promise.all(Array.from({ length: workerCount }, worker));

    console.log("--- Optimization complete ---");
}
