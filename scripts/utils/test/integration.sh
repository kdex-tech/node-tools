#!/bin/sh

set -e

# Setup test environment
export WORKDIR="$(pwd)/test_workdir"
export PACKAGING_DIR="$(pwd)/test_packaging_dir"
export MODULE_PATH="/custom_node_modules"

# Mock /scripts/package.json
mkdir -p /tmp/scripts_mock
echo '{"name": "test-pkg", "dependencies": {"lit": "^3.3.2", "lodash-es": "^4.17.23", "preact": "^10.23.1"}}' > /tmp/scripts_mock/package.json

# Export local scripts to PATH for testing
export PATH="$(pwd)/scripts/utils:$PATH"

# Prepare test copy of get_modules with mock source path
cp scripts/get_modules /tmp/get_modules_test
sed -i 's|/scripts/package.json|/tmp/scripts_mock/package.json|g' /tmp/get_modules_test
chmod +x /tmp/get_modules_test

echo "--- Running shell integration test: get_modules ---"
/tmp/get_modules_test

if [ ! -f "${WORKDIR}/package.json" ]; then
    echo "Fail: package.json not copied to WORKDIR"
    exit 1
fi

echo "--- Running shell integration test: importmap_generator ---"
./scripts/importmap_generator

if [ ! -f "${PACKAGING_DIR}/importmap.json" ]; then
    echo "Fail: importmap.json not copied to PACKAGING_DIR"
    exit 1
fi

# Verify import map contains the dependency
if ! grep -q "preact" "${PACKAGING_DIR}/importmap.json"; then
    echo "Fail: preact not found in generated import map"
    exit 1
fi

# Cleanup
rm -rf "${WORKDIR}" "${PACKAGING_DIR}" /tmp/get_modules_test /tmp/scripts_mock
echo "--- Shell integration tests passed ---"
