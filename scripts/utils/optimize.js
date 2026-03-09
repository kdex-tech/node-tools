import { build } from 'esbuild';
import fs from 'fs';
import path from 'path';

export async function optimize(targetDir = 'node_modules') {
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
        }
    }
    console.log("--- Optimization complete ---");
}
