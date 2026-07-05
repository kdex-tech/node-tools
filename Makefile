REPOSITORY ?=
IMG ?= kdex-tech/node-tools
TAG ?= $(shell git describe --dirty='-d' --tags)

# if REPOSITORY is set make sure it ends with a /
ifneq ($(REPOSITORY),)
override REPOSITORY := $(REPOSITORY)/
endif

# if TAG is set make sure it starts with a :
ifneq ($(TAG),)
override TAG := :$(TAG)
endif

# CONTAINER_TOOL defines the container tool to be used for building images.
# Be aware that the target commands are only tested with Docker which is
# scaffolded by default. However, you might want to replace it to use other
# tools. (i.e. podman)
CONTAINER_TOOL ?= docker

# Setting SHELL to bash allows bash commands to be executed by recipes.
# Options are set to exit when a recipe line exits non-zero or a piped command fails.
SHELL = /usr/bin/env bash -o pipefail
.SHELLFLAGS = -ec

.PHONY: all
all: docker-buildx

##@ General

.PHONY: help
help: ## Display this help.
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage:\n  make \033[36m<target>\033[0m\n"} /^[a-zA-Z_0-9-]+:.*?##/ { printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2 } /^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) } ' $(MAKEFILE_LIST)

.PHONY: lint
lint: ## Run linting and sorting
	@echo "Sorting JSON files..."
	jq --sort-keys . scripts/utils/package.json > scripts/utils/package.json.tmp && mv scripts/utils/package.json.tmp scripts/utils/package.json
	jq --sort-keys . scripts/utils/package-lock.json > scripts/utils/package-lock.json.tmp && mv scripts/utils/package-lock.json.tmp scripts/utils/package-lock.json
	@echo "Linting complete."

##@ Build

.PHONY: docker-build
docker-build: ## Build docker image with the manager.
	$(CONTAINER_TOOL) build -t ${REPOSITORY}${IMG}${TAG} .

.PHONY: docker-buildx
docker-buildx: ## Build and push docker image for the manager for cross-platform support
	# copy existing Dockerfile and insert --platform=${BUILDPLATFORM} into Dockerfile.cross, and preserve the original Dockerfile
	sed -e '1 s/\(^FROM\)/FROM --platform=\$$\{BUILDPLATFORM\}/; t' -e ' 1,// s//FROM --platform=\$$\{BUILDPLATFORM\}/' Dockerfile > Dockerfile.cross
	$(CONTAINER_TOOL) buildx inspect kdex-builder >/dev/null 2>&1 || $(CONTAINER_TOOL) buildx create --name kdex-builder --use
	$(CONTAINER_TOOL) buildx build --push --platform=$(PLATFORMS) --tag ${REPOSITORY}${IMG}${TAG} --tag ${REPOSITORY}${IMG}:latest -f Dockerfile.cross .
	rm Dockerfile.cross

.PHONY: docker-push
docker-push: ## Push docker image with the manager.
	$(CONTAINER_TOOL) push ${REPOSITORY}${IMG}${TAG}

PLATFORMS ?= linux/arm64,linux/amd64

.PHONY: test
test: scripts/utils/node_modules ## Run all tests
	@echo "Running tests..."
	./scripts/utils/test/integration.sh

scripts/utils/node_modules: scripts/utils/package.json scripts/utils/package-lock.json
	@echo "Installing test dependencies..."
	cd scripts/utils && npm ci

##@ Benchmark

.PHONY: bench
bench: ## Run the bun vs npm install benchmark simulation
	@echo "Running install benchmark (bun vs npm)..."
	./bench/simulate $(BENCH_ARGS)

.PHONY: bench-runtime
bench-runtime: ## Run the node/deno/bun runtime benchmark for optimize/generate/bundle_cjs
	@echo "Running runtime benchmark (node vs deno vs bun)..."
	./bench/runtime/run $(BENCH_ARGS)

.PHONY: bench-optimize
bench-optimize: scripts/utils/node_modules ## Run the optimize esbuild-batching prototype benchmark
	@echo "Running optimize batching benchmark..."
	node ./bench/optimize/bench.js $(BENCH_ARGS)

.PHONY: verify-browser-safety
verify-browser-safety: scripts/utils/node_modules ## Verify importmap-reachable code is browser-safe (real Chromium)
	@echo "Verifying browser-safety of the importmap closure..."
	node ./bench/browser-safety/verify.js
