# Prototype: batching esbuild in `optimize`

`optimize` (scripts/utils/optimize.js) is the slowest packaging command by an
order of magnitude — and unlike `generate`/`bundle_cjs`, it's **not** helped by
switching JS runtime (see [`../runtime/REPORT.md`](../runtime/REPORT.md)),
because it's dominated by esbuild. The reason is *how* it calls esbuild:

```js
for (const file of uniqueFiles) {
    await build({ entryPoints: [file], ... });   // one round-trip, awaited, per file
}
```

Each file is a separate, serial round-trip to the esbuild service. On a 4-core
box that pins one core and idles the other three. This directory prototypes
feeding esbuild in **batches** so its internal worker pool stays saturated, with
the identical per-file transform (`define` NODE_ENV, inline sourcemap).

## Results (realistic React + i18next fixture, 376 files, 4 cores)

The fixture (`bench/fixture/package.json`) is the real closure behind a typical
import surface — including the CJS subpath entries an app actually imports
(`react/jsx-runtime`, `react-dom/client`, ...), all of which `optimize` walks and
transforms.


| strategy | median | speedup | output identical* |
|---|---|---|---|
| serial-build (current) | 1521ms | 1.00x | (reference) |
| concurrent-transform ×4 | 596ms | 2.55x | yes |
| concurrent-transform ×16 | 499ms | 3.05x | yes |
| concurrent-transform ×64 | 484ms | 3.14x | yes |
| single-build (all files) | 420ms | **3.62x** | yes |

\* code bodies byte-for-byte identical to the current implementation (the inline
sourcemap comment is stripped before comparison); all 376 files still receive a
sourcemap. Reproduce with `node bench/optimize/bench.js`.

## The two strategies

- **`concurrent-transform`** — a bounded worker pool over esbuild's `transform`
  API. Reads and writes each file itself, keeping N transforms in flight.
- **`single-build`** — one `build()` call for all files (grouped by extension),
  esbuild parallelizes internally. Fewest round-trips, so the fastest here.

## Why the file mix matters (and why the fixture isn't enough)

The number and mix of `.js`/`.mjs` files **varies wildly per real workload** — the
fixture is just a fixed simulation and happens to be 100% `.js` with no malformed
files. The prototypes are therefore covered by
[`test/correctness.test.js`](./test/correctness.test.js), which builds a synthetic
tree (mixed `.js`/`.mjs`, a file esbuild can't parse, a nested `node_modules`) and
asserts:

- `.mjs` files stay `.mjs` and get a sourcemap — **no stray `.js` sibling**.
  (esbuild rewrites `.mjs`→`.js` by default; `single-build` avoids this only by
  grouping entries per extension and setting `outExtension`. `concurrent-transform`
  is immune because it overwrites in place.)
- nested `node_modules` is skipped, matching the current walk.

It also pins down the key behavioural difference:

| | current (serial) | concurrent-transform | single-build |
|---|---|---|---|
| speed | 1.0x | ~3.1x | ~3.6x |
| `.mjs` handling | in place | in place | per-extension grouping |
| one unparseable file | skipped, rest continue | **skipped, rest continue** | **whole batch aborts** |
| memory vs tree size | flat | flat (bounded by N) | grows with entry count |

## Recommendation

**`concurrent-transform`** is the production-worthy choice, not the marginally
faster `single-build`. Because runtime workloads change wildly, the deciding
factors are robustness, not the last 15%:

1. It preserves the current **per-file error isolation** — a single file esbuild
   can't parse is skipped and the rest still optimize. `single-build` is
   all-or-nothing and would fail the entire step on one bad file.
2. It's **extension-agnostic** (in-place overwrite) regardless of the `.js`/`.mjs`
   mix, with no reliance on esbuild's output-path/extension rules.
3. It's **~3x faster** and produces byte-identical output.

A reasonable default concurrency is a small multiple of the core count (esbuild's
service parallelizes across `GOMAXPROCS` internally; N in-flight requests just
keep it fed). ×16 already captures most of the win here.

## Files

- `optimize-batched.js` — both prototype strategies (reuses the tooling's esbuild).
- `bench.js` — times each strategy vs the current one and verifies equivalence.
- `test/correctness.test.js` — variable-workload correctness (`.js`/`.mjs`, bad files, nesting).
