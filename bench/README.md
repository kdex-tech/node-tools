# Install benchmark: bun vs npm

A self-contained simulation that measures how long it takes to install a fixed
set of dependencies with [bun](https://bun.sh) versus npm. It is relevant to
this repo because the packaging pipeline (`get_modules`) starts by running an
`npm install`, so the installer's speed directly affects end-to-end throughput.

The fixture is a typical React + i18n front-end dependency set:

- `react`, `react-dom`
- `i18next`, `react-i18next`

See [`fixture/package.json`](./fixture/package.json).

## Running

```sh
cd bench
./simulate                       # both installers, all scenarios
./simulate -n 5                  # 5 measured runs per scenario
./simulate --installers bun      # only bun
./simulate --scenarios cold,warm # subset of scenarios
./simulate --json                # machine-readable output
```

From the repo root you can also run `make bench`.

If `bun` (or `npm`) is not on `PATH`, that installer is skipped rather than
failing the run.

## Scenarios

| Scenario | Cache        | Lockfile | Command                          | Measures |
|----------|--------------|----------|----------------------------------|----------|
| `cold`   | empty (per run) | none  | `install`                        | full resolve + download |
| `warm`   | populated    | none     | `install`                        | resolve + link from cache |
| `frozen` | populated    | present  | `npm ci` / `bun install --frozen-lockfile` | reproducible CI-style install |

## How it stays fair

- Each `(installer, scenario)` pair runs in its own temp working directory that
  is reset to a pristine copy of the fixture `package.json`.
- Each installer uses an **isolated cache directory** (`npm --cache`,
  `BUN_INSTALL_CACHE_DIR`) so the developer's global cache neither biases nor is
  polluted by the benchmark.
- `node_modules` is removed before every run so each run does real install work.
- For `cold`, the cache is emptied before **every** measured run (a warmup would
  otherwise turn it into a warm install).
- All known lockfiles are removed between non-frozen runs so one installer's
  lockfile can never influence another.
- Timings use `process.hrtime.bigint()` around the install subprocess.

## Interpreting output

The table reports mean/median/min/max/stddev per scenario, followed by a
head-to-head median speedup. Absolute numbers depend heavily on machine, disk,
and network; the **ratio between installers on the same machine** is the
meaningful signal.

## Tests

`node test/simulate.test.js` exercises the pure logic (stats, argument parsing,
installer/scenario definitions) without touching the network.
