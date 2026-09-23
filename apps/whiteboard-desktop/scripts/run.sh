#!/usr/bin/env bash
set -euo pipefail

MONOREPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
APP_DIR="$MONOREPO_ROOT/apps/whiteboard-desktop"
CHECKOUT="$APP_DIR/code-oss"
WHITEBOARD_PACKAGE="$MONOREPO_ROOT/packages/whiteboard"
WHITEBOARD_SERVER="$WHITEBOARD_PACKAGE/dist/server/desktop-host.js"

if (( $# > 0 )); then
  echo "usage: $0" >&2
  exit 2
fi

if [[ ! -f "$CHECKOUT/product.json" ]]; then
  echo "the tracked Code OSS fork is missing; restore the checkout before running Review Desktop" >&2
  exit 1
fi
PACKAGED_ROOT="${DEV_FAST_WHITEBOARD_PACKAGED_ROOT:-}"
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

WHITEBOARD_USER_HOME="$(node -p "require('node:os').homedir()")"
WHITEBOARD_BASE_HOME="${DEV_WHITEBOARD_HOME:-$WHITEBOARD_USER_HOME/.dev}"
STATE_ROOT="${DEV_FAST_WHITEBOARD_DESKTOP_STATE_ROOT:-$WHITEBOARD_BASE_HOME/review-desktop/state}"
mkdir -p "$STATE_ROOT/user-data" "$STATE_ROOT/extensions" "$STATE_ROOT/logs"

# Curated extensions are downloaded, not committed. Materialize the selected
# groups before launch. `all` is the bundled set. Explicit optional groups are
# available for development launches. Set DEV_WHITEBOARD_EXTENSIONS to all
# (default), none, or a comma-separated subset of
# rust,swift,csharp,python,go,vim,emacs. Enablement is a persisted in-app choice.
# `pnpm dev` runs build.sh (which also materializes this selection) right
# before this script; skip the repeat call when the manifest is unchanged and
# the selection matches the one already materialized.
EXTENSIONS_SELECTION="${DEV_WHITEBOARD_EXTENSIONS:-all}"
EXTENSIONS_SELECTION_STAMP="$CHECKOUT/.build/dev-fast/curated-extensions.stamp"
mkdir -p "$(dirname "$EXTENSIONS_SELECTION_STAMP")"
if [[ "$(cat "$EXTENSIONS_SELECTION_STAMP" 2>/dev/null)" != "$EXTENSIONS_SELECTION" ]] ||
  needs_rebuild "$EXTENSIONS_SELECTION_STAMP" "$APP_DIR/scripts/curated-extensions.manifest.mjs"; then
  node "$APP_DIR/scripts/curated-extensions.mjs" --only="$EXTENSIONS_SELECTION"
  echo "$EXTENSIONS_SELECTION" >"$EXTENSIONS_SELECTION_STAMP"
fi

rebuild_review_desktop_outputs "$MONOREPO_ROOT" "$WHITEBOARD_PACKAGE"
if [[ -z "$PACKAGED_ROOT" ]]; then
  node "$APP_DIR/scripts/copy-canvas.mjs"
  export DEV_FAST_WHITEBOARD_SERVER_ENTRY="$WHITEBOARD_SERVER"
  export DEV_FAST_WHITEBOARD_TOOLING_ROOT="$MONOREPO_ROOT"
fi

CODE_ARGS=(
  --disable-telemetry
  --skip-welcome
  "--user-data-dir=$STATE_ROOT/user-data"
  "--extensions-dir=$STATE_ROOT/extensions"
)
if [[ -n "${DEV_FAST_WHITEBOARD_SHARED_DATA_DIR:-}" ]]; then
  CODE_ARGS+=("--shared-data-dir=$DEV_FAST_WHITEBOARD_SHARED_DATA_DIR")
fi
if [[ -n "${DEV_FAST_WHITEBOARD_REMOTE_DEBUGGING_PORT:-}" ]]; then
  CODE_ARGS+=(
    "--remote-debugging-port=$DEV_FAST_WHITEBOARD_REMOTE_DEBUGGING_PORT"
  )
fi
if [[ "${DEV_FAST_WHITEBOARD_DISABLE_GPU:-0}" == "1" ]]; then
  CODE_ARGS+=(--disable-gpu)
fi
if [[ "${DEV_FAST_WHITEBOARD_FORCE_ACCESSIBILITY:-0}" == "1" ]]; then
  # Keeps Chromium's renderer accessibility tree alive for the generic Linux
  # AT-SPI Computer Use backend. It is deliberately opt-in outside DevBoxes.
  CODE_ARGS+=(--force-renderer-accessibility)
fi

if [[ -n "$PACKAGED_ROOT" ]]; then
  unset DEV_FAST_WHITEBOARD_TOOLING_ROOT
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
