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
# NOTE: docker-buildx pins FROM to --platform=$BUILDPLATFORM, so every RUN
# executes on the build arch even when producing the arm64 image. We fetch the
# TARGETARCH-matched binary, but must NOT execute it here: running the arm64
# bun on the amd64 builder fails with ENOEXEC (busybox then parses the ELF as a
# script -> "syntax error"). Verify with test -x, not `bun --version`.
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

RUN npm install -g /usr/local/bin/utils

RUN chmod 777 /usr/local/bin/get_modules; \
    chmod 777 /usr/local/bin/importmap_generator
