#!/usr/bin/env bash
set -euo pipefail

MONOREPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
APP_DIR="$MONOREPO_ROOT/apps/review-desktop"
CHECKOUT="$APP_DIR/code-oss"
REVIEW_PACKAGE="$MONOREPO_ROOT/packages/review"
REVIEW_SERVER="$REVIEW_PACKAGE/dist/server/desktop-host.js"

if (( $# > 0 )); then
  echo "usage: $0" >&2
  exit 2
fi

if [[ ! -f "$CHECKOUT/product.json" ]]; then
  echo "the tracked Code OSS fork is missing; restore the checkout before running Review Desktop" >&2
  exit 1
fi
PACKAGED_ROOT="${DEV_FAST_REVIEW_PACKAGED_ROOT:-}"
if [[ -n "$PACKAGED_ROOT" ]]; then
  PACKAGED_ROOT="$(cd "$PACKAGED_ROOT" && pwd -P)"
  CODE_EXE_NAME="$(
    cd "$CHECKOUT"
    node -p "require('./product.json').applicationName"
  )"
  CODE_BINARY="$PACKAGED_ROOT/$CODE_EXE_NAME"
elif [[ "$OSTYPE" == "darwin"* ]]; then
  CODE_APP_NAME="$(
    cd "$CHECKOUT"
    node -p "require('./product.json').nameShort"
  )"
  CODE_EXE_NAME="$(
    cd "$CHECKOUT"
    node -p "require('./product.json').nameShort"
  )"
  CODE_BINARY="$CHECKOUT/.build/electron/$CODE_APP_NAME.app/Contents/MacOS/$CODE_EXE_NAME"
else
  CODE_APP_NAME="$(
    cd "$CHECKOUT"
    node -p "require('./product.json').applicationName"
  )"
  CODE_BINARY="$CHECKOUT/.build/electron/$CODE_APP_NAME"
fi
if [[ ! -x "$CODE_BINARY" ]]; then
  echo "Review Desktop binary is not built at $CODE_BINARY" >&2
  exit 1
fi

# shellcheck source=freshness.sh
source "$APP_DIR/scripts/freshness.sh"

REVIEW_USER_HOME="$(node -p "require('node:os').homedir()")"
REVIEW_BASE_HOME="${DEV_REVIEW_HOME:-$REVIEW_USER_HOME/.dev}"
STATE_ROOT="${DEV_FAST_REVIEW_DESKTOP_STATE_ROOT:-$REVIEW_BASE_HOME/review-desktop/state}"
mkdir -p "$STATE_ROOT/user-data" "$STATE_ROOT/extensions" "$STATE_ROOT/logs"

# Curated extensions are downloaded, not committed. Materialize the selected
# groups before launch. `all` is the bundled set. Explicit optional groups are
# available for development launches. Set DEV_REVIEW_EXTENSIONS to all
# (default), none, or a comma-separated subset of
# rust,swift,csharp,python,go,vim,emacs. Enablement is a persisted in-app choice.
# `pnpm dev` runs build.sh (which also materializes this selection) right
# before this script; skip the repeat call when the manifest is unchanged and
# the selection matches the one already materialized.
EXTENSIONS_SELECTION="${DEV_REVIEW_EXTENSIONS:-all}"
EXTENSIONS_SELECTION_STAMP="$CHECKOUT/.build/dev-fast/curated-extensions.stamp"
mkdir -p "$(dirname "$EXTENSIONS_SELECTION_STAMP")"
if [[ "$(cat "$EXTENSIONS_SELECTION_STAMP" 2>/dev/null)" != "$EXTENSIONS_SELECTION" ]] ||
  needs_rebuild "$EXTENSIONS_SELECTION_STAMP" "$APP_DIR/scripts/curated-extensions.manifest.mjs"; then
  node "$APP_DIR/scripts/curated-extensions.mjs" --only="$EXTENSIONS_SELECTION"
  echo "$EXTENSIONS_SELECTION" >"$EXTENSIONS_SELECTION_STAMP"
fi

# Development launches use the checkout runtime, not the staged release bundle.
# Check the pinned binary even when all compiled outputs are already current.
# An explicit developer override supplies its own executable.
if [[ -z "$PACKAGED_ROOT" && -z "${REVIEW_DIFFR_BINARY:-}" ]]; then
  pnpm --dir "$MONOREPO_ROOT" --filter @dev.fast/review ensure:diffr --required
fi

rebuild_review_desktop_outputs "$MONOREPO_ROOT" "$REVIEW_PACKAGE"
# Names this Desktop as the checkout's dev instance, packaged or not.
export DEV_FAST_REVIEW_CHECKOUT="$MONOREPO_ROOT"
if [[ -z "$PACKAGED_ROOT" ]]; then
  node "$APP_DIR/scripts/copy-canvas.mjs"
  export DEV_FAST_REVIEW_SERVER_ENTRY="$REVIEW_SERVER"
  export DEV_FAST_REVIEW_TOOLING_ROOT="$MONOREPO_ROOT"
fi

CODE_ARGS=(
  --disable-telemetry
  --skip-welcome
  "--user-data-dir=$STATE_ROOT/user-data"
  "--extensions-dir=$STATE_ROOT/extensions"
)
if [[ -n "${DEV_FAST_REVIEW_SHARED_DATA_DIR:-}" ]]; then
  CODE_ARGS+=("--shared-data-dir=$DEV_FAST_REVIEW_SHARED_DATA_DIR")
fi
if [[ -n "${DEV_FAST_REVIEW_REMOTE_DEBUGGING_PORT:-}" ]]; then
  CODE_ARGS+=(
    "--remote-debugging-port=$DEV_FAST_REVIEW_REMOTE_DEBUGGING_PORT"
  )
fi
if [[ "${DEV_FAST_REVIEW_DISABLE_GPU:-0}" == "1" ]]; then
  CODE_ARGS+=(--disable-gpu)
fi
if [[ "${DEV_FAST_REVIEW_FORCE_ACCESSIBILITY:-0}" == "1" ]]; then
  # Keeps Chromium's renderer accessibility tree alive for the generic Linux
  # AT-SPI Computer Use backend. It is deliberately opt-in outside DevBoxes.
  CODE_ARGS+=(--force-renderer-accessibility)
fi

if [[ -n "$PACKAGED_ROOT" ]]; then
  unset DEV_FAST_REVIEW_TOOLING_ROOT
  unset NODE_ENV VSCODE_DEV VSCODE_CLI
else
  (
    cd "$CHECKOUT"
    node build/lib/preLaunch.ts
  )
  export NODE_ENV=development
  export VSCODE_DEV=1
  export VSCODE_CLI=1
fi
export ELECTRON_ENABLE_STACK_DUMPING=1
export ELECTRON_ENABLE_LOGGING=1
cd "$CHECKOUT"
exec "$CODE_BINARY" \
  --disable-extension=vscode.vscode-api-tests \
  "${CODE_ARGS[@]}" \
  .
