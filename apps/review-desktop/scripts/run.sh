#!/usr/bin/env bash
set -euo pipefail

MONOREPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
APP_DIR="$MONOREPO_ROOT/apps/review-desktop"
CHECKOUT="$APP_DIR/code-oss"
REVIEW_PACKAGE="$MONOREPO_ROOT/packages/progressive-review"
REVIEW_SERVER="$REVIEW_PACKAGE/dist/server/desktop-host.js"
DEVELOPMENT_MODULE_PACKAGE="$MONOREPO_ROOT/packages/review-agent-session-host"
DEVELOPMENT_MODULE="$DEVELOPMENT_MODULE_PACKAGE/dist/index.js"
CANVAS_MANIFEST="$REVIEW_PACKAGE/app/dist/desktop/.vite/manifest.json"

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
node "$APP_DIR/scripts/curated-extensions.mjs" --only="${DEV_REVIEW_EXTENSIONS:-all}"

if needs_rebuild \
  "$REVIEW_SERVER" \
  "$REVIEW_PACKAGE/src" \
  "$REVIEW_PACKAGE/tsdown.config.ts" \
  "$REVIEW_PACKAGE/package.json" \
  "$MONOREPO_ROOT/packages/review-protocol/src"; then
  pnpm --dir "$MONOREPO_ROOT" --filter @dev.fast/review build
fi
if needs_rebuild \
  "$CANVAS_MANIFEST" \
  "$REVIEW_PACKAGE/app/src" \
  "$REVIEW_PACKAGE/app/desktop.vite.config.ts" \
  "$REVIEW_PACKAGE/package.json" \
  "$MONOREPO_ROOT/packages/review-protocol/src"; then
  pnpm --dir "$MONOREPO_ROOT" --filter @dev.fast/review app:desktop:build
fi
TUTORIAL_OUTPUT="$REVIEW_PACKAGE/tutorial/.bundle/document/review-document.js"
if needs_rebuild \
  "$TUTORIAL_OUTPUT" \
  "$REVIEW_PACKAGE/scripts/build-tutorial-assets.ts" ||
  [[ -n "$(
    find "$REVIEW_PACKAGE/tutorial" \
      \( -path "$REVIEW_PACKAGE/tutorial/.bundle" -o -path "$REVIEW_PACKAGE/tutorial/git-stub" \) -prune \
      -o -type f -newer "$TUTORIAL_OUTPUT" -print -quit
  )" ]]; then
  pnpm --dir "$MONOREPO_ROOT" --filter @dev.fast/review build:tutorial-assets
fi
# A packaged app is immutable and self-contained: its canvas and Review server
# runtime are staged before signing, and the main process mints the server
# endpoint and credentials itself. Only a development checkout is pointed at
# monorepo build output here.
if [[ -z "$PACKAGED_ROOT" ]]; then
  # The agent-session development module is optional: checkouts without the
  # package (the open-source carve-out) run without it.
  if [[ -d "$DEVELOPMENT_MODULE_PACKAGE" ]]; then
    if needs_rebuild \
      "$DEVELOPMENT_MODULE" \
      "$DEVELOPMENT_MODULE_PACKAGE/src" \
      "$DEVELOPMENT_MODULE_PACKAGE/package.json" \
      "$MONOREPO_ROOT/packages/agent-session/src" \
      "$MONOREPO_ROOT/packages/review-protocol/src"; then
      pnpm --dir "$MONOREPO_ROOT" --filter @dev.fast/review-agent-session-host build
    fi
    export DEV_FAST_REVIEW_DEVELOPMENT_MODULE="$DEVELOPMENT_MODULE"
  fi
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
  unset DEV_FAST_REVIEW_DEVELOPMENT_MODULE DEV_FAST_REVIEW_TOOLING_ROOT
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
