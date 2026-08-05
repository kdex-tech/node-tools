#!/bin/sh

set -e

# Export local scripts to PATH for testing
export PATH="$(pwd)/scripts/utils:$PATH"

# Unit tests first: they are fast and pinpoint a broken unit, whereas an
# integration failure only says "the flow broke somewhere". These were not
# reached by `make test` before, so nothing ran them in CI.
echo "--- Running unit tests ---"
for unit_test in scripts/utils/test/*.test.js; do
    [ -e "${unit_test}" ] || continue
    echo "  -> ${unit_test}"
    (cd scripts/utils && node "test/$(basename "${unit_test}")")
done
echo "--- Unit tests passed ---"

# The verification ledger persists on the packager's cache claim, which
# host-manager mounts at /cache. Point it at a scratch dir so the flows below
# exercise the real cold-then-warm path end to end against a live registry.
export KDEX_CACHE_DIR="$(pwd)/test_cache_dir"
rm -rf "${KDEX_CACHE_DIR}"

# Mock /scripts/package.json
mkdir -p /tmp/scripts_mock
# preact is pinned EXACTLY on purpose: it is the only dependency verify_integrity
# will actually check (ranges are skipped), so this exercises the real
# registry->tarball->installed-tree comparison against a genuinely published
# package rather than only synthetic fixtures. See kdex-tech/host-manager#161.
echo '{"name": "test-pkg", "dependencies": {"lit": "^3.3.2", "lodash-es": "^4.17.23", "preact": "10.23.1"}}' > /tmp/scripts_mock/package.json

# Prepare test copy of get_modules with mock source path
cp scripts/get_modules /tmp/get_modules_test
sed -i 's|/scripts/package.json|/tmp/scripts_mock/package.json|g' /tmp/get_modules_test
chmod +x /tmp/get_modules_test

# Run the full get_modules -> importmap_generator flow with a given installer
# and runtime, and assert the generated import map is valid. This proves each
# INSTALLER (npm/bun) and each RUNTIME (node/bun/deno) is compatible with the
# downstream optimize / generate / bundle_cjs steps.
run_flow() {
    installer="$1"
    runtime="$2"
    tag="${installer}_${runtime}"
    echo ""
    echo "=== Integration flow with INSTALLER=${installer} RUNTIME=${runtime} ==="

    export INSTALLER="${installer}"
    export RUNTIME="${runtime}"
    export WORKDIR="$(pwd)/test_workdir_${tag}"
    export PACKAGING_DIR="$(pwd)/test_packaging_dir_${tag}"
    export MODULE_PATH="/custom_node_modules"

    # Start from a clean tree. Cleanup at the END of the flow is not enough: an
    # interrupted run leaves a node_modules that `optimize` already rewrote in
    # place, and the next run's installer sees the dependency as satisfied and
    # keeps those bytes -- which verify_integrity then correctly reports as not
    # matching the published tarball. Production is unaffected (the packager's
    # WORKDIR is a per-Job EmptyDir), so this is a test-hygiene fix, not a
    # behaviour change.
    rm -rf "${WORKDIR}" "${PACKAGING_DIR}"

    echo "--- Running shell integration test: get_modules (${tag}) ---"
    # Captured rather than piped: `sh` has no pipefail, so `cmd | tee` would
    # report tee's status and a failed verification would pass silently.
    if ! /tmp/get_modules_test > "/tmp/get_modules_${tag}.log" 2>&1; then
        cat "/tmp/get_modules_${tag}.log"
        echo "Fail: get_modules exited non-zero (${tag})"
        exit 1
    fi
    cat "/tmp/get_modules_${tag}.log"

    if [ ! -f "${WORKDIR}/package.json" ]; then
        echo "Fail: package.json not copied to WORKDIR"
        exit 1
    fi

    # preact is the only exact pin, so it is the only package verified — and
    # therefore the only one recorded. The entry proves the ledger reached the
    # claim through the real runner, not just the unit fixtures.
    if [ ! -f "${KDEX_CACHE_DIR}/verify/preact/10.23.1.json" ]; then
        echo "Fail: no ledger entry written for preact@10.23.1 (${tag})"
        exit 1
    fi

    # The FIRST flow verifies cold; every later one must hit the ledger the
    # earlier flow left behind. That is the whole point of putting it on the
    # persistent claim, so assert it rather than assuming it.
    if [ -n "${LEDGER_WARMED}" ]; then
        if ! grep -q "preact@10.23.1 matches the published tarball.*from cache" "/tmp/get_modules_${tag}.log"; then
            echo "Fail: preact was re-fetched despite a ledger entry from an earlier flow (${tag})"
            exit 1
        fi
        echo "--- Ledger hit confirmed for ${tag} ---"
    fi
    LEDGER_WARMED=1

    echo "--- Running shell integration test: importmap_generator (${tag}) ---"
    ./scripts/importmap_generator

    if [ ! -f "${PACKAGING_DIR}/importmap.json" ]; then
        echo "Fail: importmap.json not copied to PACKAGING_DIR"
        exit 1
    fi

    # Every declared dependency must be present in the generated import map,
    # regardless of which installer/runtime produced it.
    for dep in lit lodash-es preact; do
        if ! grep -q "${dep}" "${PACKAGING_DIR}/importmap.json"; then
            echo "Fail: ${dep} not found in import map (INSTALLER=${installer} RUNTIME=${runtime})"
            exit 1
        fi
    done

    echo "--- Integration flow ${tag} passed ---"

    # Cleanup for this combination
    rm -rf "${WORKDIR}" "${PACKAGING_DIR}"
    unset INSTALLER RUNTIME WORKDIR PACKAGING_DIR MODULE_PATH
}

# Baseline: npm installer, node runtime (always available).
run_flow npm node

# Same flow again, against the ledger the first one left on the cache dir. Run
# unconditionally: the bun/deno flows below would also prove the warm path, but
# they are skipped wherever those runtimes are absent, and a warm-path assertion
# that only runs on some machines is not an assertion.
run_flow npm node

# bun is optional: prove it as both an installer and a runtime when available.
if command -v bun >/dev/null 2>&1; then
    run_flow bun node
    run_flow npm bun
else
    echo ""
    echo "=== Skipping bun flows: 'bun' not found on PATH ==="
fi

# deno is optional: prove it as a runtime when available.
if command -v deno >/dev/null 2>&1; then
    run_flow npm deno
else
    echo ""
    echo "=== Skipping deno flow: 'deno' not found on PATH ==="
fi

# Cleanup shared fixtures
rm -rf /tmp/get_modules_test /tmp/scripts_mock /tmp/get_modules_*.log "${KDEX_CACHE_DIR}"

echo ""
echo "--- Shell integration tests passed ---"
