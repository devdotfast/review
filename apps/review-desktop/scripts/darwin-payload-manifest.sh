# shellcheck shell=bash
# This file exports variables to the scripts that source it.
# shellcheck disable=SC2034

# Paths are relative to the monorepo root. macOS packaging checks every
# required path after it extracts the Linux-built Darwin payload.
DARWIN_PAYLOAD_CURATED_EXTENSIONS_PATH="apps/review-desktop/code-oss/.build/review-curated-extensions/darwin-arm64"

DARWIN_PAYLOAD_REQUIRED_PATHS=(
  "apps/review-desktop/code-oss/out-vscode-min"
  "apps/review-desktop/code-oss/.build/extensions"
  "$DARWIN_PAYLOAD_CURATED_EXTENSIONS_PATH"
  "packages/progressive-review/app/dist/desktop"
  "packages/progressive-review/dist"
  "packages/progressive-review/tutorial"
  "packages/local-vcs/dist"
)

# These build intermediates belong in the archive, but the macOS wrapper does
# not read them directly before Gulp assembles the application.
DARWIN_PAYLOAD_ARCHIVE_ONLY_PATHS=(
  "apps/review-desktop/code-oss/out-build"
  "apps/review-desktop/code-oss/out"
)
