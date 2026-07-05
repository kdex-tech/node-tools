#!/bin/sh

set -e

# Export local scripts to PATH for testing
export PATH="$(pwd)/scripts/utils:$PATH"

# Mock /scripts/package.json
mkdir -p /tmp/scripts_mock
echo '{"name": "test-pkg", "dependencies": {"lit": "^3.3.2", "lodash-es": "^4.17.23", "preact": "^10.23.1"}}' > /tmp/scripts_mock/package.json

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

    echo "--- Running shell integration test: get_modules (${tag}) ---"
    /tmp/get_modules_test

    if [ ! -f "${WORKDIR}/package.json" ]; then
        echo "Fail: package.json not copied to WORKDIR"
        exit 1
    fi

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
rm -rf /tmp/get_modules_test /tmp/scripts_mock

echo ""
echo "--- Shell integration tests passed ---"
