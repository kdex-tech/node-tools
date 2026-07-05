# Batching esbuild in `optimize`

> **Status: integrated.** `scripts/utils/optimize.js` now runs a bounded
> concurrency pool of the same per-file `build()` call (`concurrent-build`
> below), ~2.5x faster with byte-identical output. This directory keeps the
> benchmark and the alternative strategies that informed that choice.

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


| strategy | median | speedup | output vs serial |
|---|---|---|---|
| serial-build (baseline) | 1538ms | 1.00x | (reference) |
| **concurrent-build ×16 [integrated]** | 646ms | **2.4x** | **byte-identical** |
| concurrent-transform ×16 | 460ms | 3.3x | code-identical* |
| single-build (all files) | 347ms | 4.4x | byte-identical |

\* code bodies identical; the inline sourcemap comment can differ (it's a
comment the browser ignores). Reproduce with `node bench/optimize/bench.js`.

## The three strategies

- **`concurrent-build`** *(integrated)* — a bounded worker pool over the **same
  `build()` call** the serial version used. Because the per-file call is
  unchanged, output is byte-for-byte identical (sourcemaps included, so integrity
  hashes never move).
- **`concurrent-transform`** — a pool over esbuild's `transform` API. Faster, but
  it re-emits the sourcemap and can drift by a byte, so integrity hashes would
  change for a few files.
- **`single-build`** — one `build()` call for all files (grouped by extension).
  Fastest, but all-or-nothing on a single unparseable file.

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

It also pins down the key behavioural differences that decided the integration:

| | serial (old) | concurrent-build (integrated) | concurrent-transform | single-build |
|---|---|---|---|---|
| speed | 1.0x | ~2.5x | ~3.3x | ~4.4x |
| output vs serial | — | **byte-identical** | code-identical | byte-identical |
| `.mjs` handling | in place | in place | in place | per-extension grouping |
| one unparseable file | skipped, rest continue | **skipped, rest continue** | skipped, rest continue | **whole batch aborts** |
| memory vs tree size | flat | flat (bounded by N) | flat (bounded by N) | grows with entry count |

## Why `concurrent-build` was integrated

`single-build` and `concurrent-transform` are faster, but for a production
drop-in the deciding factor is **zero output drift**, not the last 15%:

1. **Byte-identical output.** It reuses the exact per-file `build()` call, so
   every file — sourcemap included — is unchanged, and the import map's SRI
   integrity hashes never move. `concurrent-transform` re-emits sourcemaps
   (integrity would change for a few files); `single-build` also changes bytes.
2. **Preserves per-file error isolation.** A file esbuild can't parse is logged
   and skipped, the rest continue — matching the old behaviour. `single-build`
   is all-or-nothing and would fail the whole step on one bad file, which is a
   real risk since real workloads vary wildly.
3. **Still ~2.5x faster**, extension-agnostic (in-place overwrite), and flat in
   memory.

Default concurrency is a small multiple of the core count (esbuild parallelizes
across `GOMAXPROCS`; N in-flight `build()` calls keep it fed); override with
`OPTIMIZE_CONCURRENCY`.

## Files

- `optimize-batched.js` — all strategies + the serial reference (reuses the tooling's esbuild).
- `bench.js` — times each strategy vs the serial baseline and verifies equivalence.
- `test/correctness.test.js` — variable-workload correctness (`.js`/`.mjs`, bad files, nesting).
