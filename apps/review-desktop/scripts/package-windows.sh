#!/usr/bin/env bash
set -euo pipefail
MONOREPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
APP_DIR="$MONOREPO_ROOT/apps/review-desktop"
CHECKOUT="$APP_DIR/code-oss"
PACKAGED_ROOT="$APP_DIR/VSCode-win32-x64"
[[ "$(node -p 'process.platform + "-" + process.arch')" == "win32-x64" ]] || { echo 'Windows x64 is required' >&2; exit 1; }
export BUILD_SOURCEVERSION="${BUILD_SOURCEVERSION:-$(git -C "$MONOREPO_ROOT" rev-parse HEAD)}"
node "$APP_DIR/scripts/curated-extensions.mjs" --target=win32-x64
cp "$MONOREPO_ROOT/packages/review/app/icons/review.ico" "$CHECKOUT/resources/win32/code.ico"
npm --prefix "$CHECKOUT" run gulp -- vscode-win32-x64
# Code OSS puts an editor-opening bin\<applicationName> on PATH; the installer's PATH command is the Whiteboard CLI instead.
node "$APP_DIR/scripts/windows-path-command.mjs" "$PACKAGED_ROOT"
node "$APP_DIR/scripts/copy-canvas.mjs" --packaged-root "$PACKAGED_ROOT"
node "$APP_DIR/scripts/curated-extensions.mjs" --target=win32-x64 --copy-to "$PACKAGED_ROOT/resources/app/extensions"
# ty links the Visual C++ runtime dynamically and a clean Windows install has none, so ship it beside ty.
cp "$(cygpath -u "$SYSTEMROOT")/System32/vcruntime140.dll" "$PACKAGED_ROOT/resources/app/extensions/astral-sh.ty/bundled/libs/bin/"
node "$APP_DIR/scripts/windows-diffr.mjs"
node "$APP_DIR/scripts/stage-review-runtime.mjs" --packaged-root "$PACKAGED_ROOT"
node "$APP_DIR/scripts/stage-review-runtime.mjs" --verify --packaged-root "$PACKAGED_ROOT"
npm --prefix "$CHECKOUT" run gulp -- vscode-win32-x64-inno-updater
SETUP_ARGS=()
# CI provides Azure Artifact Signing; local and fork builds stay unsigned.
if [[ -n "${REVIEW_WINDOWS_SIGNING_METADATA:-}" ]]; then
  node "$APP_DIR/scripts/sign-windows.mjs" "$PACKAGED_ROOT"
  # Inno Setup runs this signing command itself, so it needs a Windows path.
  export REVIEW_WIN32_SIGN_SCRIPT="$(cygpath -w "$APP_DIR/scripts/sign-windows.mjs")"
  SETUP_ARGS+=(--sign)
fi
npm --prefix "$CHECKOUT" run gulp -- vscode-win32-x64-user-setup vscode-win32-x64-system-setup "${SETUP_ARGS[@]}"
mkdir -p "$APP_DIR/dist/windows"
cp "$CHECKOUT/.build/win32-x64/user-setup/VSCodeSetup.exe" "$APP_DIR/dist/windows/Whiteboard-win32-x64-user.exe"
cp "$CHECKOUT/.build/win32-x64/system-setup/VSCodeSetup.exe" "$APP_DIR/dist/windows/Whiteboard-win32-x64-system.exe"
(cd "$PACKAGED_ROOT" && 7z a -tzip "$APP_DIR/dist/windows/Whiteboard-win32-x64.zip" .)
