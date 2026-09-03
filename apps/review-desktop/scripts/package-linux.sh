#!/usr/bin/env bash
set -euo pipefail

MONOREPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
APP_DIR="$MONOREPO_ROOT/apps/review-desktop"
CHECKOUT="$APP_DIR/code-oss"
PACKAGED_ROOT="$APP_DIR/VSCode-linux-x64"

if (( $# > 0 )); then
  echo "usage: $0" >&2
  exit 2
fi
if [[ "$(uname -s)" != "Linux" ]]; then
  echo "Review Desktop Linux packaging must run on Linux" >&2
  exit 1
fi
if [[ ! -f "$CHECKOUT/node_modules/gulp/bin/gulp.js" ]]; then
  echo "code-oss dependencies are missing; run pnpm --filter @dev.fast/review-desktop app:build first" >&2
  exit 1
fi

node "$APP_DIR/scripts/curated-extensions.mjs" --target=linux-x64

npm --prefix "$CHECKOUT" run gulp -- vscode-linux-x64

if [[ ! -x "$PACKAGED_ROOT/review" ]]; then
  echo "Review Desktop packaging did not create $PACKAGED_ROOT/review" >&2
  exit 1
fi
node "$APP_DIR/scripts/copy-canvas.mjs" --packaged-root "$PACKAGED_ROOT"
node "$APP_DIR/scripts/curated-extensions.mjs" \
  --target=linux-x64 \
  --copy-to "$PACKAGED_ROOT/resources/app/extensions"

# The installed app embeds its own Review server runtime (server, CLI, and
# agent skills) so it never reaches back into this checkout.
pnpm --dir "$MONOREPO_ROOT" --filter @dev.fast/review build
node "$APP_DIR/scripts/stage-review-runtime.mjs" --packaged-root "$PACKAGED_ROOT"

node "$APP_DIR/scripts/stage-review-runtime.mjs" --verify --packaged-root "$PACKAGED_ROOT"
