#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
CHECKOUT="$APP_DIR/code-oss"
DIST="$APP_DIR/dist/linux"
VERSION="$(node -p "require('$APP_DIR/package.json').version")"
REVISION="${REVIEW_LINUX_PACKAGE_REVISION:-1}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$REVISION" =~ ^[1-9][0-9]*$ ]] || {
  echo 'Expected a stable version and positive REVIEW_LINUX_PACKAGE_REVISION' >&2; exit 1;
}
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || {
  echo 'Linux distributions must be packaged on Linux x86_64' >&2; exit 1;
}

node "$APP_DIR/scripts/stage-review-runtime.mjs" --verify --packaged-root "$APP_DIR/VSCode-linux-x64"
npm --prefix "$CHECKOUT" run gulp -- vscode-linux-x64-prepare-deb
npm --prefix "$CHECKOUT" run gulp -- vscode-linux-x64-build-deb
mkdir -p "$DIST/arch-source"
cp "$CHECKOUT/.build/linux/deb/amd64/deb/dev-fast-review_${VERSION}-${REVISION}_amd64.deb" "$DIST/"

# The Arch builder consumes exactly the staged DEB filesystem, without its
# Debian metadata/hooks. It does not download or rebuild any application code.
tar --zstd --owner=0 --group=0 -cf "$DIST/arch-source/review-root.tar.zst" \
  -C "$CHECKOUT/.build/linux/deb/amd64/review-amd64" usr
ROOT_SHA="$(sha256sum "$DIST/arch-source/review-root.tar.zst" | cut -d ' ' -f1)"
sed -e "s/@VERSION@/$VERSION/g" -e "s/@REVISION@/$REVISION/g" -e "s/@ROOT_SHA@/$ROOT_SHA/g" \
  "$APP_DIR/scripts/linux/PKGBUILD" > "$DIST/arch-source/PKGBUILD"
echo "DEB and Arch package input are in $DIST"
