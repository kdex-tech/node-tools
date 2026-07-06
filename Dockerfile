FROM node:24-alpine

# Build platform provided automatically by buildx (e.g. amd64, arm64).
ARG TARGETARCH
# Bun version to install. Bump here to upgrade.
ARG BUN_VERSION=1.3.11

# libstdc++ / libgcc are the runtime libs the musl bun build links against.
RUN apk add --no-cache curl jq tree unzip libstdc++ libgcc

# Install bun matching the image architecture. The image is Alpine (musl), so
# pull the musl build; use the baseline x64 build for portability across CPUs
# that lack AVX2. Fails the build on an unsupported architecture rather than
# silently producing an image without bun.
#
# NOTE: FROM is no longer pinned to $BUILDPLATFORM (see kdex-tech/node-tools#5),
# so this RUN executes under the TARGET platform — natively for the build arch,
# under QEMU/binfmt for the other. TARGETARCH still selects the matching bun.
# We verify with `test -x` rather than executing bun (`bun --version`): a plain
# executability check avoids depending on QEMU correctly emulating the heavy bun
# binary during the build, and is sufficient here — bun runs for real at runtime
# on native hardware.
RUN set -eux; \
    case "${TARGETARCH}" in \
        amd64) BUN_PKG='bun-linux-x64-musl-baseline' ;; \
        arm64) BUN_PKG='bun-linux-aarch64-musl' ;; \
        *) echo "Unsupported TARGETARCH for bun: '${TARGETARCH}'" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${BUN_PKG}.zip" -o /tmp/bun.zip; \
    unzip -q /tmp/bun.zip -d /tmp; \
    install -m 0755 "/tmp/${BUN_PKG}/bun" /usr/local/bin/bun; \
    rm -rf /tmp/bun.zip "/tmp/${BUN_PKG}"; \
    test -x /usr/local/bin/bun

WORKDIR /

COPY scripts/ /usr/local/bin/

# Install the utils toolchain's deps FRESH, under the TARGET platform, into the
# tree the runtime resolves them from (/usr/local/bin/utils/node_modules). The
# build context excludes node_modules (.dockerignore), so the host-resolved
# amd64 tree is never copied in — esbuild ships its native binary as a per-arch
# optional dep (@esbuild/linux-<arch>), and a copied amd64 tree makes
# importmap_generator / bundle_cjs fail on real arm64 nodes. See
# kdex-tech/node-tools#6. Under buildx this RUN executes on the target platform
# (native for amd64, QEMU for arm64), so npm resolves the matching @esbuild.
RUN cd /usr/local/bin/utils && npm ci

RUN npm install -g /usr/local/bin/utils

# Guard: fail the build if the arch-correct esbuild native binary is missing, so
# a future context/cache slip can't silently reship the wrong-arch esbuild
# (node-tools#6). esbuild names the package linux-x64 for amd64 and linux-arm64
# for arm64, so map TARGETARCH (mirrors the bun TARGETARCH case above).
RUN set -eux; \
    case "${TARGETARCH}" in \
        amd64) ESBUILD_ARCH='x64' ;; \
        arm64) ESBUILD_ARCH='arm64' ;; \
        *) echo "Unsupported TARGETARCH for esbuild check: '${TARGETARCH}'" >&2; exit 1 ;; \
    esac; \
    test -d "/usr/local/bin/utils/node_modules/@esbuild/linux-${ESBUILD_ARCH}"

RUN chmod 777 /usr/local/bin/get_modules; \
    chmod 777 /usr/local/bin/importmap_generator
