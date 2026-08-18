#!/usr/bin/env bash
set -euo pipefail

# The macOS release is split: Linux produces this payload, and macOS consumes it.
# New packaged outputs must follow the "Linux-to-macOS build handoff" contract
# in apps/review-desktop/README.md.

MONOREPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
APP_DIR="$MONOREPO_ROOT/apps/review-desktop"
CHECKOUT="$APP_DIR/code-oss"
PAYLOAD="$APP_DIR/dist/darwin-payload.tar.zst"

# shellcheck source=darwin-payload-manifest.sh
source "$APP_DIR/scripts/darwin-payload-manifest.sh"
CURATED_EXTENSIONS_PAYLOAD="$MONOREPO_ROOT/$DARWIN_PAYLOAD_CURATED_EXTENSIONS_PATH"

if (( $# > 0 )); then
  echo "usage: $0" >&2
  exit 2
fi

# The compile host is Linux, but curated extensions contain target-native
# servers. Materialize the Darwin variants that the final app will execute.
REVIEW_DESKTOP_COMPILE_ONLY=1 \
  REVIEW_DESKTOP_CURATED_EXTENSION_TARGET=darwin-arm64 \
  bash "$APP_DIR/scripts/build.sh"

if git -C "$MONOREPO_ROOT" rev-parse HEAD >/dev/null 2>&1; then
  BUILD_SOURCEVERSION="$(git -C "$MONOREPO_ROOT" rev-parse HEAD)"
else
  BUILD_SOURCEVERSION="$(jj --repository "$MONOREPO_ROOT" --ignore-working-copy log --no-graph -r @ -T 'commit_id')"
fi
export BUILD_SOURCEVERSION
npm --prefix "$CHECKOUT" run gulp -- vscode-darwin-arm64-min-prepare

rm -rf -- "$CURATED_EXTENSIONS_PAYLOAD"
node "$APP_DIR/scripts/curated-extensions.mjs" \
  --target=darwin-arm64 \
  --copy-to "$CURATED_EXTENSIONS_PAYLOAD"

mkdir -p "$APP_DIR/dist"
rm -f -- "$PAYLOAD"
# Keep every Linux-built workspace output that pnpm deploy consumes in this
# payload. The precompiled macOS job disables lifecycle scripts, so it cannot
# rebuild a missing dist directory.
tar -cf - -C "$MONOREPO_ROOT" \
  "${DARWIN_PAYLOAD_ARCHIVE_ONLY_PATHS[@]}" \
  "${DARWIN_PAYLOAD_REQUIRED_PATHS[@]}" \
  | zstd -T0 -o "$PAYLOAD"

echo "Wrote $PAYLOAD"
