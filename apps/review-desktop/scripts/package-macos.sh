#!/usr/bin/env bash
set -euo pipefail

# The macOS release is split: Linux produces the payload, and macOS consumes it.
# New packaged outputs must follow the "Linux-to-macOS build handoff" contract
# in apps/review-desktop/README.md.

MONOREPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
APP_DIR="$MONOREPO_ROOT/apps/review-desktop"
CHECKOUT="$APP_DIR/code-oss"
PRODUCT_NAME="$(node -p "require('$CHECKOUT/product.json').nameShort")"
PACKAGED_APP="$APP_DIR/VSCode-darwin-arm64/$PRODUCT_NAME.app"
PACKAGED_BINARY="$PACKAGED_APP/Contents/MacOS/$PRODUCT_NAME"

# shellcheck source=darwin-payload-manifest.sh
source "$APP_DIR/scripts/darwin-payload-manifest.sh"
CURATED_EXTENSIONS_PAYLOAD="$MONOREPO_ROOT/$DARWIN_PAYLOAD_CURATED_EXTENSIONS_PATH"

# shellcheck source=code-oss-dependencies.sh
source "$APP_DIR/scripts/code-oss-dependencies.sh"

if (( $# > 0 )); then
  echo "usage: $0" >&2
  exit 2
fi
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Review Desktop macOS packaging must run on macOS" >&2
  exit 1
fi
if [[ "$(uname -m)" != "arm64" ]]; then
  echo "Review Desktop macOS packaging requires arm64" >&2
  exit 1
fi

PRECOMPILED="${REVIEW_DESKTOP_PRECOMPILED:-0}"
if [[ "$PRECOMPILED" == "1" ]]; then
  # The compile payload from compile-darwin-payload.sh is already extracted
  # into the checkout. Run only the darwin-side packaging.
  for relative in "${DARWIN_PAYLOAD_REQUIRED_PATHS[@]}"; do
    required="$MONOREPO_ROOT/$relative"
    if [[ ! -d "$required" ]]; then
      echo "REVIEW_DESKTOP_PRECOMPILED=1 but $required does not exist" >&2
      exit 1
    fi
  done
  CURATED_EXTENSIONS_SOURCE="$CURATED_EXTENSIONS_PAYLOAD"
else
  bash "$APP_DIR/scripts/build.sh"
  CURATED_EXTENSIONS_SOURCE="$CHECKOUT/extensions"
fi

if git -C "$MONOREPO_ROOT" rev-parse HEAD >/dev/null 2>&1; then
  BUILD_SOURCEVERSION="$(git -C "$MONOREPO_ROOT" rev-parse HEAD)"
else
  BUILD_SOURCEVERSION="$(jj --repository "$MONOREPO_ROOT" --ignore-working-copy log --no-graph -r @ -T 'commit_id')"
fi
export BUILD_SOURCEVERSION

if [[ "$PRECOMPILED" == "1" ]]; then
  ensure_code_oss_dependencies "$APP_DIR" "$CHECKOUT"
  npm --prefix "$CHECKOUT" run gulp -- vscode-darwin-arm64-min-ci
else
  npm --prefix "$CHECKOUT" run gulp -- vscode-darwin-arm64-min
fi

if [[ ! -x "$PACKAGED_BINARY" ]]; then
  echo "Review Desktop packaging did not create $PACKAGED_BINARY" >&2
  exit 1
fi
node "$APP_DIR/scripts/copy-canvas.mjs" --packaged-root "$PACKAGED_APP"
node "$APP_DIR/scripts/curated-extensions.mjs" \
  --target=darwin-arm64 \
  --source-root "$CURATED_EXTENSIONS_SOURCE" \
  --copy-to "$PACKAGED_APP/Contents/Resources/app/extensions"

# The installed app embeds its own Review server runtime so it never reaches
# back into this checkout. Stage it before signing so it is covered by the
# signature and the app stays immutable once installed.
#
# build.sh produces the server dist in local mode. In precompiled mode, the
# server dist arrives in the darwin payload.
node "$APP_DIR/scripts/stage-review-runtime.mjs" --packaged-root "$PACKAGED_APP"

# Installs Assets.car and rewrites CFBundleIconName, which invalidates any
# existing signature. It must therefore run after every other bundle mutation
# and before notarize-macos.sh signs, or the app ships a broken seal or the
# stock Code OSS icon.
node "$APP_DIR/scripts/apply-app-icon.mjs" "$PACKAGED_APP"

node "$APP_DIR/scripts/stage-review-runtime.mjs" --verify --packaged-root "$PACKAGED_APP"

bash "$APP_DIR/scripts/notarize-macos.sh"
