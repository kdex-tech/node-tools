// Verify the pipeline invariant: every module reachable through the generated
// importmap must be browser-safe in every way. We prove it the only fully
// authoritative way — by loading the real importmap in real Chromium and
// importing every exposed specifier. The browser enforces, for free:
//   - module resolution via the importmap (unresolved bare imports throw),
//   - ESM parsing (a leftover CJS body fails to parse / throws on require),
//   - Subresource Integrity (the importmap's `integrity` hashes must match),
//   - top-level execution (references to require/module/process throw).
//
// It runs the full pipeline (optimize -> generate -> bundle_cjs) twice — once
// with the current serial optimize and once with the batched prototype — so we
// can answer directly: does the optimize refactor preserve the invariant?

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const UTILS = path.join(REPO_ROOT, 'scripts', 'utils');
const BATCHED = path.join(REPO_ROOT, 'bench', 'optimize', 'optimize-batched.js');
const FIXTURE_PKG = path.join(REPO_ROOT, 'bench', 'fixture', 'package.json');
const MODULE_PATH = '/-/modules';

// Load Playwright from the global install (not a dep of this repo). Returns
// null when it isn't available so the verifier can skip instead of hard-failing
// in environments without a browser (CI, the Docker image).
function loadChromium() {
    try {
        const groot = execSync('npm root -g', { encoding: 'utf8' }).trim();
        const req = createRequire(path.join(groot, 'x.js'));
        return req('playwright').chromium;
    } catch {
        return null;
    }
}

function rmrf(t) { fs.rmSync(t, { recursive: true, force: true }); }

function buildSeed(tmpRoot) {
    const dir = path.join(tmpRoot, 'seed');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(FIXTURE_PKG, path.join(dir, 'package.json'));
    const r = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'ignore' });
    if (r.status !== 0) throw new Error('seed npm install failed');
    return dir;
}

// Run the full pipeline in `dir` as subprocesses with cwd=dir — exactly how
// production invokes these wrappers. (In-process chdir doesn't work: jspm's
// generator latches its base URL from cwd at module-load time.)
function step(argv, dir) {
    const [cmd, ...args] = argv;
    const r = spawnSync(cmd, args, {
        cwd: dir, env: { ...process.env, MODULE_PATH }, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8',
    });
    if (r.status !== 0) {
        throw new Error(`${args.join(' ')} failed (exit ${r.status}): ${(r.stderr || '').split('\n').filter(Boolean).pop() || ''}`);
    }
}

function runPipeline(dir, optimizeArgv) {
    step(optimizeArgv, dir);
    step(['node', path.join(UTILS, 'generate')], dir);
    step(['node', path.join(UTILS, 'bundle_cjs')], dir);
    return JSON.parse(fs.readFileSync(path.join(dir, 'importmap.json'), 'utf8'));
}

// Files the importmap points at, as URL -> absolute path under node_modules.
function reachableFiles(dir, importmap) {
    const prefix = MODULE_PATH.endsWith('/') ? MODULE_PATH : MODULE_PATH + '/';
    const out = new Map();
    const collect = (obj) => {
        for (const url of Object.values(obj || {})) {
            if (typeof url === 'string' && url.startsWith(prefix)) {
                out.set(url, path.join(dir, 'node_modules', url.slice(prefix.length)));
            }
        }
    };
    collect(importmap.imports);
    for (const scope of Object.values(importmap.scopes || {})) collect(scope);
    return out;
}

const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json' };

function serve(dir, importmap) {
    const keys = Object.keys(importmap.imports || {});
    // Page imports every top-level specifier; the browser transitively resolves
    // and integrity-checks everything those modules pull in.
    const html = `<!doctype html><html><head>
<script type="importmap">${JSON.stringify({
        imports: importmap.imports || {},
        scopes: importmap.scopes || {},
        integrity: importmap.integrity || {},
    })}</script></head><body><script type="module">
const keys = ${JSON.stringify(keys)};
const results = {};
for (const k of keys) {
  try { const m = await import(k); results[k] = { ok: true, keys: Object.keys(m).length }; }
  catch (e) { results[k] = { ok: false, error: String(e && e.message || e) }; }
}
window.__results = results;
window.__done = true;
</script></body></html>`;

    const server = http.createServer((req, res) => {
        const url = decodeURIComponent(req.url.split('?')[0]);
        if (url === '/' || url === '/index.html') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            return res.end(html);
        }
        const prefix = MODULE_PATH + '/';
        if (url.startsWith(prefix)) {
            const file = path.join(dir, 'node_modules', url.slice(prefix.length));
            if (fs.existsSync(file) && fs.statSync(file).isFile()) {
                res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
                return res.end(fs.readFileSync(file));
            }
        }
        res.writeHead(404); res.end('not found');
    });
    return server;
}

function listen(server) {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function browserCheck(chromium, dir, importmap) {
    const server = serve(dir, importmap);
    const port = await listen(server);
    const browser = await chromium.launch({ headless: true });
    const pageErrors = [];
    const failedReqs = [];
    try {
        const page = await browser.newPage();
        page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e)));
        page.on('requestfailed', (r) => failedReqs.push(`${r.url()} (${r.failure()?.errorText})`));
        await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
        await page.waitForFunction(() => window.__done === true, { timeout: 30000 });
        const results = await page.evaluate(() => window.__results);
        return { results, pageErrors, failedReqs };
    } finally {
        await browser.close();
        server.close();
    }
}

const VARIANTS = [
    { key: 'production optimize (integrated batching)', argv: ['node', path.join(UTILS, 'optimize')] },
    { key: 'serial reference (pre-integration)', argv: ['node', BATCHED, 'serial'] },
];

async function main() {
    const chromium = loadChromium();
    if (!chromium) {
        console.log('SKIP: playwright/chromium not available — cannot run the browser check here.');
        console.log('Install with `npm i -g playwright` (Chromium is pre-provisioned in this env).');
        return;
    }
    // Confirm the browser actually launches before doing pipeline work.
    try {
        const b = await chromium.launch({ headless: true });
        await b.close();
    } catch (e) {
        console.log(`SKIP: chromium failed to launch (${e.message.split('\n')[0]}).`);
        return;
    }
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-safety-'));
    try {
        process.stdout.write('building seed (npm install)... ');
        const seed = buildSeed(tmpRoot);
        console.log('done\n');

        const perVariant = [];
        for (const variant of VARIANTS) {
            console.log(`=== ${variant.key} ===`);
            const dir = path.join(tmpRoot, variant.key.replace(/\W+/g, '_'));
            fs.cpSync(seed, dir, { recursive: true });
            const importmap = runPipeline(dir, variant.argv);

            const reach = reachableFiles(dir, importmap);
            const { results, pageErrors, failedReqs } = await browserCheck(chromium, dir, importmap);

            const entries = Object.entries(results);
            const ok = entries.filter(([, v]) => v.ok);
            const bad = entries.filter(([, v]) => !v.ok);
            for (const [k, v] of entries) {
                console.log(`  ${v.ok ? 'PASS' : 'FAIL'}  ${k}${v.ok ? ` (${v.keys} named exports)` : `  -> ${v.error}`}`);
            }
            const safe = bad.length === 0 && pageErrors.length === 0;
            console.log(`  importmap entries: ${entries.length}, reachable files: ${reach.size}`);
            if (pageErrors.length) console.log(`  page errors: ${pageErrors.join(' | ')}`);
            if (failedReqs.length) console.log(`  failed requests: ${failedReqs.slice(0, 5).join(' | ')}`);
            console.log(`  => ${safe ? 'BROWSER-SAFE ✅' : 'NOT SAFE ❌'}\n`);
            perVariant.push({ variant: variant.key, dir, importmap, reach, safe, ok: ok.length, total: entries.length });
        }

        // Does the refactor change any browser-facing bytes? Compare the code of
        // every importmap-reachable file between the two pipelines (the inline
        // sourcemap comment is allowed to differ; it is a comment).
        const [a, b] = perVariant;
        console.log('=== refactor equivalence (serial vs batched) ===');
        const stripMap = (c) => c.replace(/\n?\/\/# sourceMappingURL=data:application\/json;[^\n]*\n?$/, '');
        const relKeys = [...a.reach.keys()];
        let exact = 0, codeEqual = 0, diff = 0;
        for (const url of relKeys) {
            const fa = a.reach.get(url), fb = b.reach.get(url);
            if (!fb || !fs.existsSync(fa) || !fs.existsSync(fb)) { diff++; continue; }
            const ca = fs.readFileSync(fa, 'utf8'), cb = fs.readFileSync(fb, 'utf8');
            if (ca === cb) { exact++; codeEqual++; }
            else if (stripMap(ca) === stripMap(cb)) codeEqual++;
            else { diff++; console.log(`  CODE DIFFERS: ${url}`); }
        }
        console.log(`  reachable files: ${relKeys.length}`);
        console.log(`  byte-identical: ${exact}, code-identical (sourcemap aside): ${codeEqual}, code differs: ${diff}`);

        const bothSafe = a.safe && b.safe;
        const invariantHeld = bothSafe && diff === 0;
        console.log(`\n=== VERDICT ===`);
        console.log(`  production (batched) pipeline browser-safe: ${a.safe ? 'yes' : 'no'} (${a.ok}/${a.total})`);
        console.log(`  serial-reference pipeline browser-safe:     ${b.safe ? 'yes' : 'no'} (${b.ok}/${b.total})`);
        console.log(`  importmap-reachable code identical (batched vs serial): ${diff === 0 ? 'yes' : 'no'}`);
        console.log(`  => invariant ${invariantHeld ? 'HOLDS for the integrated pipeline ✅' : 'AT RISK ❌'}`);
        process.exitCode = invariantHeld ? 0 : 1;
    } finally {
        rmrf(tmpRoot);
    }
}

main().catch((err) => { console.error('browser-safety verify failed:', err); process.exit(1); });
