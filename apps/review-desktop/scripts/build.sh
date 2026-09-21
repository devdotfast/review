#!/usr/bin/env bash
set -euo pipefail

# The macOS release is split: Linux produces the payload, and macOS consumes it.
# New packaged outputs must follow the "Linux-to-macOS build handoff" contract
# in apps/review-desktop/README.md.

MONOREPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
APP_DIR="$MONOREPO_ROOT/apps/review-desktop"
CHECKOUT="$APP_DIR/code-oss"
PROTOCOL_BUNDLER="$MONOREPO_ROOT/packages/review-protocol/scripts/bundle-native-runtime.mjs"
PROTOCOL_OUTPUT="$CHECKOUT/out/vs/review/common/reviewProtocol.js"
EVENT_STREAM_OUTPUT="$CHECKOUT/out/vs/review/common/reviewEventStream.js"

# shellcheck source=code-oss-dependencies.sh
source "$APP_DIR/scripts/code-oss-dependencies.sh"
# shellcheck source=freshness.sh
source "$APP_DIR/scripts/freshness.sh"

DEV_FAST_ACTIVE=0
if [[ "${REVIEW_DESKTOP_CI_FAST:-0}" != "1" && "${REVIEW_DESKTOP_DEV_FAST:-0}" == "1" ]]; then
  DEV_FAST_ACTIVE=1
fi

if (( $# > 0 )); then
  echo "usage: $0" >&2
  exit 2
fi

ensure_code_oss_dependencies "$APP_DIR" "$CHECKOUT"
cd "$CHECKOUT"

mkdir -p "$CHECKOUT/out/vs/base/browser/dompurify"
cp \
  "$CHECKOUT/src/vs/base/browser/dompurify/cgmanifest.json" \
  "$CHECKOUT/out/vs/base/browser/dompurify/cgmanifest.json"
if [[ -n "${REVIEW_DESKTOP_CURATED_EXTENSION_TARGET:-}" ]]; then
  node "$APP_DIR/scripts/curated-extensions.mjs" \
    "--target=$REVIEW_DESKTOP_CURATED_EXTENSION_TARGET"
elif [[ "$DEV_FAST_ACTIVE" == "1" ]]; then
  DEV_FAST_EXTENSIONS_SELECTION="${DEV_REVIEW_EXTENSIONS:-all}"
  node "$APP_DIR/scripts/curated-extensions.mjs" \
    "--only=$DEV_FAST_EXTENSIONS_SELECTION"
  # run.sh follows this script in `pnpm dev`; leave the selection it
  # materialized so run.sh's own freshness check can skip the repeat call.
  mkdir -p "$CHECKOUT/.build/dev-fast"
  echo "$DEV_FAST_EXTENSIONS_SELECTION" \
    >"$CHECKOUT/.build/dev-fast/curated-extensions.stamp"
else
  node "$APP_DIR/scripts/curated-extensions.mjs"
fi
if [[ "${REVIEW_DESKTOP_COMPILE_ONLY:-0}" != "1" ]]; then
  if [[ "$OSTYPE" == "darwin"* ]]; then
    PRODUCT_APP="$(node -p "require('./product.json').nameShort")"
    PRODUCT_EXE="$(node -p "require('./product.json').nameShort")"
    EXPECTED_BINARY="$CHECKOUT/.build/electron/$PRODUCT_APP.app/Contents/MacOS/$PRODUCT_EXE"
  else
    PRODUCT_APP="$(node -p "require('./product.json').applicationName")"
    EXPECTED_BINARY="$CHECKOUT/.build/electron/$PRODUCT_APP"
  fi
  if [[ ! -x "$EXPECTED_BINARY" ]]; then
    npm run electron
  fi
  if [[ "$OSTYPE" == "darwin"* && "$DEV_FAST_ACTIVE" != "1" ]]; then
    # Dev launches use Electron's packaged static .icns. Install the adaptive
    # asset catalog only for full builds, avoiding actool and signing on restart.
    node "$APP_DIR/scripts/apply-app-icon.mjs" "$CHECKOUT/.build/electron/$PRODUCT_APP.app"
  fi
fi
npm --prefix "$APP_DIR" run protocol:sync
TYPECHECK_PID=""
if [[ "${REVIEW_DESKTOP_CI_FAST:-0}" == "1" ]]; then
  # Transpile-only build with the tsgo typecheck running in the background;
  # the wait at the end of this script keeps type errors fatal. copy-codicons
  # must finish before transpile copies non-TS files.
  npm run typecheck-client &
  TYPECHECK_PID=$!
  npm run gulp copy-codicons
  npm run transpile-client
  npm run gulp compile-extensions compile-extension-media
  node "$PROTOCOL_BUNDLER" "$PROTOCOL_OUTPUT" "$PROTOCOL_OUTPUT"
  node "$PROTOCOL_BUNDLER" "$EVENT_STREAM_OUTPUT" "$EVENT_STREAM_OUTPUT"
elif [[ "$DEV_FAST_ACTIVE" == "1" ]]; then
  STAMP_DIR="$CHECKOUT/.build/dev-fast"
  CLIENT_STAMP="$STAMP_DIR/client.stamp"
  EXTENSIONS_STAMP="$STAMP_DIR/extensions.stamp"
  DEPENDENCY_STAMP="$CHECKOUT/node_modules/.dev-fast-package-lock.sha256"
  EXTENSIONS_OUTPUT="$CHECKOUT/extensions/git-base/out/extension.js"
  mkdir -p "$STAMP_DIR"

  if [[ ! -f "$CHECKOUT/out/main.js" || ! -f "$PROTOCOL_OUTPUT" || ! -f "$EVENT_STREAM_OUTPUT" ]] || \
    needs_rebuild "$CLIENT_STAMP" \
      "$CHECKOUT/src" \
      "$CHECKOUT/build" \
      "$CHECKOUT/product.json" \
      "$DEPENDENCY_STAMP" \
      "$MONOREPO_ROOT/packages/review-protocol/src" \
      "$PROTOCOL_BUNDLER"; then
    npm run gulp copy-codicons
    npm run transpile-client
    node "$PROTOCOL_BUNDLER" "$PROTOCOL_OUTPUT" "$PROTOCOL_OUTPUT"
    node "$PROTOCOL_BUNDLER" "$EVENT_STREAM_OUTPUT" "$EVENT_STREAM_OUTPUT"
    date > "$CLIENT_STAMP"
  else
    echo "Code OSS client output is current."
  fi

  if [[ ! -f "$EXTENSIONS_OUTPUT" ]] || \
    needs_rebuild "$EXTENSIONS_STAMP" \
      "$CHECKOUT/extensions" \
      "$CHECKOUT/build" \
      "$DEPENDENCY_STAMP"; then
    npm run gulp compile-extensions compile-extension-media
    date > "$EXTENSIONS_STAMP"
  else
    echo "Code OSS extensions output is current."
  fi
else
  npm run compile
  node "$PROTOCOL_BUNDLER" "$PROTOCOL_OUTPUT" "$PROTOCOL_OUTPUT"
  node "$PROTOCOL_BUNDLER" "$EVENT_STREAM_OUTPUT" "$EVENT_STREAM_OUTPUT"
fi
if [[ "$DEV_FAST_ACTIVE" != "1" ]]; then
  if [[ -n "${REVIEW_POSTHOG_KEY:-}" ]]; then
    node "$MONOREPO_ROOT/packages/review/scripts/embed-posthog-key.mjs"
  fi
  rebuild_review_desktop_outputs "$MONOREPO_ROOT" "$MONOREPO_ROOT/packages/review"
  node "$APP_DIR/scripts/copy-canvas.mjs"
fi
if [[ -n "$TYPECHECK_PID" ]]; then
  wait "$TYPECHECK_PID"
fi
