#!/usr/bin/env bash
# Validate a downloadable Review deb in clean, pinned Ubuntu LTS containers.
# The deb is a manual download: there is no apt repository to verify.
set -euo pipefail
PACKAGES="$(cd "${1:?usage: verify-deb-package.sh package-directory [24.04|26.04|all]}" && pwd -P)"
TARGET="${2:-all}"
case "$TARGET" in all|24.04|26.04) ;; *) echo "Unknown Ubuntu test target: $TARGET" >&2; exit 2 ;; esac
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DEB="$(basename "$(ls "$PACKAGES"/dev-fast-review*_amd64.deb)")"
# A build carries exactly one channel; the package name says which.
case "$DEB" in
  dev-fast-review-preview_*) PACKAGE=dev-fast-review-preview; APP=review-preview ;;
  *) PACKAGE=dev-fast-review; APP=review ;;
esac
for VERSION in 24.04 26.04; do
  if [[ "$TARGET" != all && "$TARGET" != "$VERSION" ]]; then continue; fi
  case "$VERSION" in
    24.04) IMAGE='ubuntu:24.04@sha256:008173c23f95b170204355c12626cb5a965d779a7e1283b09e9cffbb1bf33ca3' ;;
    26.04) IMAGE='ubuntu:26.04@sha256:da6fc2be547864451aa253836dd926da33623312df4a9a243e35dc877c378a78' ;;
  esac
  # Each fresh container would otherwise report `review --help` as an install.
  docker run --rm --platform linux/amd64 \
    -v "$PACKAGES:/packages:ro" -v "$SCRIPT_DIR:/test:ro" \
    -e DEB="$DEB" -e PACKAGE="$PACKAGE" -e APP="$APP" \
    -e DEBIAN_FRONTEND=noninteractive -e DO_NOT_TRACK=1 \
    "$IMAGE" bash /test/verify-ubuntu-container.sh
  echo "Ubuntu $VERSION ($PACKAGE): install, dependency resolution, sandbox permissions and retained-data removal passed"
done
