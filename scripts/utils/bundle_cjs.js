// Convert CJS-shipped npm packages into browser-loadable ESM, in place.
//
// Why this exists: K-CNAS resolves every importmap-exposed package to a real
// file under /-/modules/ in the packager OCI image. Many widely-used libs
// (notably React 18/19 - whose published index.js is `module.exports =
// require('./cjs/react.production.js')`) still ship CJS as the entry point.
// Browsers parse those files as ES modules, find zero `export` statements,
// and reject any `import { ... } from 'react'` with "doesn't provide an
// export named: ...". JSPM's `nodemodules` provider (used by generate.js)
// faithfully resolves to the CJS file, so the fix has to happen on disk
// before the importmap is shipped.
//
// Strategy: walk the importmap, bundle every URL whose path ends in `.js`
// and whose body is CJS, using esbuild --bundle --format=esm. Externalize
// every other bare-import key the importmap exposes so the runtime
// importmap still owns cross-package deduplication. Recompute SRI hashes
// for every file we rewrote so the integrity map stays consistent.

import { init as initCjsLexer, parse as parseCjs } from 'cjs-module-lexer';
import { build, transformSync } from 'esbuild';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_MODULE_PATH = '/-/modules';

export async function bundleCjs(options = {}) {
    const importmapPath = options.importmapPath || 'importmap.json';
    const modulesDir = options.modulesDir || 'node_modules';
    const modulePath = options.modulePath || process.env.MODULE_PATH || DEFAULT_MODULE_PATH;

    if (!fs.existsSync(importmapPath)) {
        throw new Error(`bundle_cjs: importmap not found at ${importmapPath}`);
    }
    if (!fs.existsSync(modulesDir)) {
        throw new Error(`bundle_cjs: modules dir not found at ${modulesDir}`);
    }

    await initCjsLexer();

    const importmap = JSON.parse(fs.readFileSync(importmapPath, 'utf8'));

    // Every bare-import key the importmap exposes - top-level `imports`
    // plus every scope. These are the IDs that must stay external in each
    // bundle so the runtime importmap (not the bundler) does cross-package
    // deduplication.
    const externalsSet = new Set();
    for (const k of Object.keys(importmap.imports || {})) externalsSet.add(k);
    for (const scope of Object.values(importmap.scopes || {})) {
        for (const k of Object.keys(scope || {})) externalsSet.add(k);
    }
    const externals = [...externalsSet];

    // Map URL -> filesystem path. Only consider URLs whose path lives under
    // the local module mount; anything served externally is left alone.
    const urlToFile = new Map();
    const prefix = modulePath.endsWith('/') ? modulePath : modulePath + '/';

    function collect(obj) {
        for (const url of Object.values(obj || {})) {
            if (typeof url !== 'string') continue;
            if (!url.startsWith(prefix)) continue;
            const rel = url.slice(prefix.length);
            urlToFile.set(url, path.join(modulesDir, rel));
        }
    }
    collect(importmap.imports);
    for (const scope of Object.values(importmap.scopes || {})) collect(scope);

    const rewritten = [];
    for (const [url, filePath] of urlToFile) {
        if (!filePath.endsWith('.js')) continue;       // .mjs is already ESM
        if (!fs.existsSync(filePath)) {
            console.warn(`[bundle_cjs] missing on-disk file: ${filePath}`);
            continue;
        }
        const body = fs.readFileSync(filePath, 'utf8');
        if (!isCommonJS(body)) continue;

        // Statically lex the CJS export surface so we can synthesize named
        // re-exports alongside the default. esbuild bundling a CJS entry to
        // ESM only emits `export default require_X()` by itself - callers
        // like `import { useState } from "react"` would still fail.
        // cjs-module-lexer follows the same conservative rules Node.js
        // uses for `require(esm)` interop. We chase `module.exports =
        // require('./x')` re-exports to their roots so wrapper shims like
        // react's index.js still surface the underlying named exports.
        const absPath = path.resolve(filePath);
        const named = collectNamedExportsRecursive(absPath, new Set());

        const wrapperLines = [`import __cjs from ${JSON.stringify(absPath)};`, `export default __cjs;`];
        for (const name of named) {
            wrapperLines.push(`export const ${name} = __cjs?.${name};`);
        }
        const wrapper = wrapperLines.join('\n') + '\n';

        console.log(`[bundle_cjs] CJS -> ESM: ${url} (${named.length} named exports)`);

        const result = await build({
            stdin: {
                contents: wrapper,
                loader: 'js',
                resolveDir: path.dirname(absPath),
                sourcefile: '__esm_wrapper__.js',
            },
            bundle: true,
            format: 'esm',
            platform: 'browser',
            external: externals,
            write: false,
            define: { 'process.env.NODE_ENV': '"production"' },
            sourcemap: 'inline',
            logLevel: 'error',
        });
        const patched = rewireRuntimeRequires(result.outputFiles[0].text, externals);
        fs.writeFileSync(filePath, patched);
        rewritten.push({ url, filePath });
    }

    if (rewritten.length === 0) {
        console.log('[bundle_cjs] no CJS entries needed bundling');
        return;
    }

    // Recompute SRI hashes for every file we touched. The hash format
    // matches what @jspm/generator wrote: sha384, base64 (standard, not
    // base64url), prefixed with the algorithm name.
    if (importmap.integrity) {
        for (const { url, filePath } of rewritten) {
            if (!(url in importmap.integrity)) continue;
            const buf = fs.readFileSync(filePath);
            const digest = crypto.createHash('sha384').update(buf).digest('base64');
            importmap.integrity[url] = `sha384-${digest}`;
        }
    }

    fs.writeFileSync(importmapPath, JSON.stringify(importmap, null, 2));
    console.log(`[bundle_cjs] rewrote ${rewritten.length} entries; updated integrity hashes`);
}

// Return the deduplicated list of named export identifiers cjs-module-lexer
// can statically prove on the given CJS module, transitively following
// `module.exports = require('./x')` reexport patterns. Filters reserved
// words and `default` so the generated wrapper is valid ESM.
//
// Follows reexports because typical npm CJS entries (react, react-dom)
// look like `if (NODE_ENV==='production') module.exports = require('./cjs/
// react.production.js')` - lex'ing just the entry returns no exports,
// while the production file has the actual surface area.
function collectNamedExportsRecursive(absPath, visited) {
    if (visited.has(absPath)) return [];
    visited.add(absPath);
    let body;
    try {
        body = fs.readFileSync(absPath, 'utf8');
    } catch {
        return [];
    }
    // The `optimize` step in get_modules runs esbuild with bundle:false +
    // define { NODE_ENV: production } over every file. That substitutes
    // process.env.NODE_ENV but leaves the resulting `if (true) { ... } else
    // { ... }` intact - cjs-module-lexer doesn't follow dead branches and
    // returns zero reexports for the canonical React wrapper. Run the body
    // through esbuild's transform with tree-shaking + minifySyntax to drop
    // the dead `else` so the lexer sees the surviving `module.exports =
    // require('./x')` cleanly.
    body = simplifyForLex(body);
    let lex;
    try {
        lex = parseCjs(body);
    } catch {
        return [];
    }
    const seen = new Set();
    for (const name of lex.exports || []) {
        if (name === 'default' || name === '__esModule') continue;
        if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) continue;
        if (RESERVED.has(name)) continue;
        seen.add(name);
    }
    for (const reexport of lex.reexports || []) {
        const childPath = resolveCjsRequire(reexport, path.dirname(absPath));
        if (!childPath) continue;
        for (const name of collectNamedExportsRecursive(childPath, visited)) {
            seen.add(name);
        }
    }
    return [...seen];
}

// Esbuild emits a runtime `__require(spec)` polyfill that throws "Dynamic
// require of X is not supported" - that fires the moment a CJS-wrapped
// body executes `require("react")` etc. inside the bundle, even when those
// IDs are in the externals list. Externalization only avoids inlining the
// dependency's code; the call site still goes through __require, and the
// polyfill never resolves the bare specifier.
//
// Replace that polyfill with one that looks up the specifier in a static
// table populated from hoisted `import * as ... from "<spec>"` statements,
// so externalized requires actually return the imported namespace at
// runtime. Only the externals the bundle actually references are imported,
// keeping the importmap-served chunks tight.
function rewireRuntimeRequires(bundle, externals) {
    // Collect every external the CJS body references via __require("X").
    // Anything not referenced doesn't need an import statement.
    const referenced = new Set();
    const reqRegex = /__require\(\s*(["'])([^"']+)\1\s*\)/g;
    let m;
    while ((m = reqRegex.exec(bundle)) !== null) {
        if (externals.includes(m[2])) referenced.add(m[2]);
    }
    if (referenced.size === 0) return bundle;

    const list = [...referenced];
    const importLines = list.map((spec, i) => `import * as __ext_${i} from ${JSON.stringify(spec)};`);
    const mapEntries = list.map((spec, i) => `  ${JSON.stringify(spec)}: __ext_${i}`).join(',\n');
    const shim = [
        '',
        '// bundle_cjs: rewired __require to dispatch to hoisted importmap externals',
        'var __externals_table = Object.assign(Object.create(null), {',
        mapEntries,
        '});',
        '',
    ].join('\n');

    // Esbuild's __require polyfill spans the var declaration through the
    // trailing `});` of its IIFE. The regex matches the whole block plus
    // the throw-stub it invokes.
    const polyfillRegex = /var __require = \/\* @__PURE__ \*\/ \(\(x\) => typeof require !== "undefined" \? require : typeof Proxy[\s\S]*?'Dynamic require of "' \+ x \+ '" is not supported'[\s\S]*?\}\);\n/;
    if (!polyfillRegex.test(bundle)) return bundle;

    // For wrappers we wrote (react/react-dom), the namespace has a `default`
    // that is the raw CJS module.exports object - return that so callers
    // who did `var X = require("react"); X.useState(...)` see module.exports
    // directly. For ESM-native externals (no `default`), return the
    // namespace itself - callers see named exports as properties.
    const replacement = [
        'var __require = (spec) => {',
        '  if (spec in __externals_table) {',
        '    const ns = __externals_table[spec];',
        '    return ns.default !== void 0 ? ns.default : ns;',
        '  }',
        '  throw new Error(\'Dynamic require of "\' + spec + \'" is not supported\');',
        '};',
        '',
    ].join('\n');

    return importLines.join('\n') + '\n' + shim + bundle.replace(polyfillRegex, replacement);
}

// Pre-process a CJS body into a form cjs-module-lexer can read past dead
// branches. esbuild's transform with treeShaking + minifySyntax collapses
// `if (true) { A } else { B }` to `A` and `if (false) ...` to nothing while
// still emitting CJS - cheap, in-memory, no file I/O.
function simplifyForLex(body) {
    try {
        const out = transformSync(body, {
            loader: 'js',
            format: 'cjs',
            treeShaking: true,
            minifySyntax: true,
            define: { 'process.env.NODE_ENV': '"production"' },
            logLevel: 'silent',
        });
        return out.code;
    } catch {
        return body;
    }
}

// Resolve a `require(...)` spec the way Node does for CJS. Only handles
// relative paths + the small set of extensions we care about - bare specifiers
// don't appear inside the npm packages we bundle (cjs-module-lexer wouldn't
// surface them as reexports anyway).
function resolveCjsRequire(spec, fromDir) {
    if (!spec.startsWith('./') && !spec.startsWith('../') && !spec.startsWith('/')) return null;
    const base = path.resolve(fromDir, spec);
    const candidates = [
        base,
        base + '.js',
        base + '.cjs',
        path.join(base, 'index.js'),
        path.join(base, 'index.cjs'),
    ];
    for (const c of candidates) {
        try {
            if (fs.statSync(c).isFile()) return c;
        } catch { /* missing - try next */ }
    }
    return null;
}

const RESERVED = new Set([
    'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
    'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false',
    'finally', 'for', 'function', 'if', 'implements', 'import', 'in',
    'instanceof', 'interface', 'let', 'new', 'null', 'package', 'private',
    'protected', 'public', 'return', 'super', 'switch', 'static', 'this',
    'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
]);

function isCommonJS(body) {
    // Reject anything with explicit ESM exports - those are already module-
    // safe and bundling them would force esbuild to re-resolve their bare
    // imports through node_modules, which loses the importmap externalization.
    if (/^\s*export\s+(default|const|let|var|function|class|async|\{|\*)/m.test(body)) return false;
    // Heuristic for CJS: at least one of the two canonical CJS shapes.
    return /\bmodule\.exports\b|\bexports\.[A-Za-z_$]/.test(body) ||
           /\brequire\s*\(/.test(body);
}
