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
# and assert the generated import map is valid. This proves both installers are
# compatible with the downstream optimize / generate / bundle_cjs steps.
run_flow_for_installer() {
    installer="$1"
    echo ""
    echo "=== Integration flow with INSTALLER=${installer} ==="

    export INSTALLER="${installer}"
    export WORKDIR="$(pwd)/test_workdir_${installer}"
    export PACKAGING_DIR="$(pwd)/test_packaging_dir_${installer}"
    export MODULE_PATH="/custom_node_modules"

    echo "--- Running shell integration test: get_modules (${installer}) ---"
    /tmp/get_modules_test

    if [ ! -f "${WORKDIR}/package.json" ]; then
        echo "Fail: package.json not copied to WORKDIR"
        exit 1
    fi

    echo "--- Running shell integration test: importmap_generator (${installer}) ---"
    ./scripts/importmap_generator

    if [ ! -f "${PACKAGING_DIR}/importmap.json" ]; then
        echo "Fail: importmap.json not copied to PACKAGING_DIR"
        exit 1
    fi

    # Every declared dependency must be present in the generated import map,
    # regardless of which installer populated node_modules.
    for dep in lit lodash-es preact; do
        if ! grep -q "${dep}" "${PACKAGING_DIR}/importmap.json"; then
            echo "Fail: ${dep} not found in import map generated via ${installer}"
            exit 1
        fi
    done

    echo "--- Integration flow with ${installer} passed ---"

    # Cleanup for this installer
    rm -rf "${WORKDIR}" "${PACKAGING_DIR}"
    unset INSTALLER WORKDIR PACKAGING_DIR MODULE_PATH
}

# npm is always expected to be present.
run_flow_for_installer npm

# bun is optional: exercise it when available so we prove installer parity,
# but don't fail the suite on hosts without bun installed.
if command -v bun >/dev/null 2>&1; then
    run_flow_for_installer bun
else
    echo ""
    echo "=== Skipping bun flow: 'bun' not found on PATH ==="
fi

# Cleanup shared fixtures
rm -rf /tmp/get_modules_test /tmp/scripts_mock

echo ""
echo "--- Shell integration tests passed ---"
