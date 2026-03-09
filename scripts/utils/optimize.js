#!/usr/bin/env node

import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';

async function run() {
    const files = [];

    function walk(dir) {
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

    console.log('--- Discovering source files in node_modules ---');
    if (!fs.existsSync('node_modules')) {
        console.log('node_modules not found, skipping optimization.');
        return;
    }

    const uniqueFiles = Array.from(new Set(files));
    console.log('Found ' + uniqueFiles.length + ' unique files to optimize.');

    for (const file of uniqueFiles) {
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
            console.error("Failed to optimize " + file + ": " + e.message);
            // We allow individual failures but report them
        }
    }
    console.log("--- Optimization complete ---");
}

run().catch(err => {
    console.error("Optimization runner failed:", err);
    process.exit(1);
});
