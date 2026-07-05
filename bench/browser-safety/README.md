# Browser-safety verifier (the pipeline invariant)

**Invariant:** every module reachable through the generated import map must be
browser-safe in every way. This verifies it the only fully authoritative way —
by loading the real import map in **real Chromium** and importing every exposed
specifier.

The browser enforces, for free, exactly the properties the pipeline must
guarantee:

| property | how the browser enforces it |
|---|---|
| module resolution | an unresolved bare import throws at import time |
| valid ESM | a leftover CJS body fails to parse / throws on `require` |
| integrity (SRI) | the import map's `integrity` hashes must match the bytes |
| clean execution | references to `require` / `module` / `process` throw |

If a module isn't ESM, references a specifier the map doesn't expose, or its
bytes don't match the integrity hash, the corresponding `import()` rejects and
the entry is reported `FAIL`.

## What it does

1. Installs the [fixture](../fixture/package.json) into a seed workspace.
2. Runs the **full pipeline** (`optimize` → `generate` → `bundle_cjs`) as
   subprocesses — once with the current serial `optimize`, once with the batched
   prototype ([`../optimize`](../optimize/README.md)).
3. Serves each result over HTTP (`/-/modules/*` → `node_modules/*`) with the real
   import map (including `integrity`), launches headless Chromium, and
   `import()`s every top-level specifier, capturing page errors and failed
   requests.
4. Diffs the import-map-reachable files between the two pipelines and prints a
   verdict.

## Running

```sh
node bench/browser-safety/verify.js      # or: make verify-browser-safety
```

Requires Playwright + Chromium (pre-provisioned in Claude Code web; otherwise
`npm i -g playwright`). If they're absent it **skips** cleanly rather than
failing, so it's safe to wire into any environment.

## Result (this repo, realistic fixture)

Both pipelines pass — all import-map entries load, resolve, integrity-check, and
execute in Chromium — and the import-map-reachable code is identical across the
refactor (some files differ only in the inline sourcemap comment, which the
browser ignores):

```
serial pipeline browser-safe:  yes (6/6)
batched pipeline browser-safe: yes (6/6)
importmap-reachable code identical across refactor: yes
=> invariant HOLDS under the optimize refactor ✅
```

**So the batched `optimize` preserves the invariant** — it changes only *how*
esbuild is driven, not the browser-facing bytes.

### Note on scope (subpaths)

The import map exposes the packages' **main** entries; a real app that imports
`react/jsx-runtime` or `react-dom/client` needs those specifiers exposed too, or
the browser can't resolve them. That's a separate *completeness* question from
this *safety* invariant — this verifier proves everything the map exposes is
safe, and is the natural place to also assert the map exposes everything the app
imports if that requirement is added.
