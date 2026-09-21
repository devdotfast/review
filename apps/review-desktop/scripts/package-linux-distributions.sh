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
  echo 'Fedora packages must be built on Linux x86_64' >&2; exit 1;
}

node "$APP_DIR/scripts/stage-review-runtime.mjs" --verify --packaged-root "$APP_DIR/VSCode-linux-x64"
npm --prefix "$CHECKOUT" run gulp -- vscode-linux-x64-prepare-rpm
npm --prefix "$CHECKOUT" run gulp -- vscode-linux-x64-build-rpm
mkdir -p "$DIST"
cp "$CHECKOUT/.build/linux/rpm/x86_64/dev-fast-review-${VERSION}-${REVISION}.x86_64.rpm" "$DIST/"
echo "Fedora RPM is in $DIST"
