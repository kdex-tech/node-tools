# Runtime benchmark: `optimize` / `generate` / `bundle_cjs`

Answers a specific question: **is there a faster JavaScript runtime for executing
the three packaging commands** (`optimize`, `generate`, `bundle_cjs`)? It measures
each command under **node**, **deno**, and **bun** for both compatibility and
speed, and writes a short markdown report.

The latest run's results and takeaways live in [`REPORT.md`](./REPORT.md).

> **Wired into the pipeline.** `get_modules` and `importmap_generator` now honor a
> `RUNTIME` env var (`node` default, or `bun`/`deno`) that selects the runtime for
> the packaging commands — the runtime counterpart to `INSTALLER`. All three are
> verified compatible by the integration test. The image ships `node` + `bun`;
> `deno` works when installed.

## Running

```sh
cd bench/runtime
./run                              # all runtimes, all commands
./run -n 8 --warmup 2              # more iterations for stable medians
./run --runtimes node,bun          # subset of runtimes
./run --commands generate,bundle_cjs
./run --report REPORT.md           # (re)write the markdown report
./run --json                       # machine-readable output
```

From the repo root: `make bench-runtime`. A runtime that isn't installed is
skipped (not failed).

## What it does

- Builds one **seed** workspace: installs the react + i18next fixture
  (`bench/fixture/package.json`) and pre-generates an import map with node for
  `bundle_cjs` to consume.
- For every `(runtime, command)`, copies the seed to a fresh working directory
  (so the mutating commands `optimize`/`bundle_cjs` never see each other's
  changes), runs the command's `scripts/utils` wrapper under that runtime, and
  times the subprocess with `process.hrtime.bigint()` — **including runtime
  startup**, since that's part of real command-execution cost.
- Marks a cell **compatible** only when the process exits `0` *and* its output
  verifies (optimize inlined a sourcemap, generate produced an import map with
  the deps, bundle_cjs rewrote the CJS entry to ESM).

### Runtime invocation

| runtime | command |
|---------|---------|
| node    | `node <wrapper>` |
| bun     | `bun <wrapper>` |
| deno    | `deno run -A --node-modules-dir=manual <wrapper>` |

deno needs `-A` (the commands read/write files, spawn the esbuild binary, and
read env) and `--node-modules-dir=manual` so it resolves the existing
`node_modules` instead of managing its own.

## Tests

`node test/run.test.js` covers the pure logic (stats, arg parsing, runtime/command
definitions) without spawning runtimes.
