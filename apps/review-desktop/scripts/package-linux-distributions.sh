#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
CHECKOUT="$APP_DIR/code-oss"
DIST="$APP_DIR/dist/linux"
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || {
  echo 'Linux packages must be built on Linux x86_64' >&2; exit 1;
}

node "$APP_DIR/scripts/stage-review-runtime.mjs" --verify --packaged-root "$APP_DIR/VSCode-linux-x64"
# The package name and version come from the stamped channel (review-package.ts).
# The RPM is the supported Fedora package; the deb is a manual download.
npm --prefix "$CHECKOUT" run gulp -- vscode-linux-x64-prepare-rpm
npm --prefix "$CHECKOUT" run gulp -- vscode-linux-x64-build-rpm
npm --prefix "$CHECKOUT" run gulp -- vscode-linux-x64-prepare-deb
npm --prefix "$CHECKOUT" run gulp -- vscode-linux-x64-build-deb
mkdir -p "$DIST"
cp "$CHECKOUT"/.build/linux/rpm/x86_64/dev-fast-review*.x86_64.rpm "$DIST/"
cp "$CHECKOUT"/.build/linux/deb/amd64/dev-fast-review*_amd64.deb "$DIST/"
echo "Fedora RPM and Debian package are in $DIST"
