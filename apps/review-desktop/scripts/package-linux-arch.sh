#!/usr/bin/env bash
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
DIST="$APP_DIR/dist/linux"
ARCH_IMAGE='archlinux:base-devel@sha256:61f7de2dd88cc4ba1fe36c24cfe1a503c3936984492d6405eeab013ce6ac68c5'
docker run --rm --platform linux/amd64 --network none \
  -v "$DIST/arch-source:/input:ro" -v "$DIST:/output" "$ARCH_IMAGE" bash -euc '
    useradd --create-home builder
    install -d -o builder -g builder /build
    cp /input/* /build/
    chown -R builder:builder /build
    su builder -c "cd /build && makepkg --nodeps --noconfirm"
    cp /build/dev-fast-review-*.pkg.tar.zst /output/
  '
