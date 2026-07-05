# Install benchmark: bun vs npm

> There are three benchmarks in this directory:
> - **This one** — install speed (`bun` vs `npm`), below.
> - **[`runtime/`](./runtime/README.md)** — execution speed of the `optimize` /
>   `generate` / `bundle_cjs` commands under node vs deno vs bun.
> - **[`optimize/`](./optimize/README.md)** — prototype batching esbuild in
>   `optimize` (~3x faster, byte-identical output).

A self-contained simulation that measures how long it takes to install a fixed
set of dependencies with [bun](https://bun.sh) versus npm. It is relevant to
this repo because the packaging pipeline (`get_modules`) starts by running an
`npm install`, so the installer's speed directly affects end-to-end throughput.

The fixture is a realistic React + i18n front-end dependency set — the closure
behind a typical import surface (`react`, `react-dom/client`, `react/jsx-runtime`,
`react-i18next`, `i18next`, ...):

- `react`, `react-dom`
- `i18next`, `react-i18next`
- `html-parse-stringify`, `void-elements`

See [`fixture/package.json`](./fixture/package.json).

## Running

```sh
cd bench
./simulate                       # both installers, both branches
./simulate -n 5                  # 5 measured runs per branch
./simulate --installers bun      # only bun
./simulate --scenarios cold      # only the cold branch
./simulate --json                # machine-readable output
```

From the repo root you can also run `make bench`.

If `bun` (or `npm`) is not on `PATH`, that installer is skipped rather than
failing the run.

## Branches

Each installer is measured on two branches:

| Branch | Cache           | Measures |
|--------|-----------------|----------|
| `cold` | empty (per run) | full resolve + download |
| `warm` | populated       | resolve + link from cache |

## How it stays fair

- Each `(installer, branch)` pair runs in its own temp working directory that is
  reset to a pristine copy of the fixture `package.json`.
- Each installer uses an **isolated cache directory** (`npm --cache`,
  `BUN_INSTALL_CACHE_DIR`) so the developer's global cache neither biases nor is
  polluted by the benchmark.
- `node_modules` and any lockfile are removed before every run, so each run does
  real, equivalent install work and one installer's lockfile can never influence
  another.
- For `cold`, the cache is emptied before **every** measured run (a warmup would
  otherwise turn it into a warm install).
- For `warm`, the cache is primed once up front so results don't depend on the
  warmup count.
- Timings use `process.hrtime.bigint()` around the install subprocess.

## Interpreting output

The table reports mean/median/min/max/stddev per branch, followed by a
head-to-head median speedup. Absolute numbers depend heavily on machine, disk,
and network; the **ratio between installers on the same machine** is the
meaningful signal.

## Tests

`node test/simulate.test.js` exercises the pure logic (stats, argument parsing,
installer/scenario definitions) without touching the network.
