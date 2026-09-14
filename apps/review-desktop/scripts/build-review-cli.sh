#!/usr/bin/env bash
set -euo pipefail

MONOREPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
source "$MONOREPO_ROOT/apps/review-desktop/scripts/freshness.sh"
REVIEW_PACKAGE="$MONOREPO_ROOT/packages/progressive-review"
CLI_STAMP="$REVIEW_PACKAGE/dist/.dev-build-stamp"
CLI_IDENTITY="$REVIEW_PACKAGE/dist/.dev-build-identity"
CURRENT_IDENTITY="$(git -C "$MONOREPO_ROOT" rev-parse HEAD):$(git -C "$MONOREPO_ROOT" status --porcelain)"
PREVIOUS_IDENTITY=""
if [[ -f "$CLI_IDENTITY" ]]; then
  PREVIOUS_IDENTITY="$(< "$CLI_IDENTITY")"
fi

if [[ ! -f "$REVIEW_PACKAGE/dist/cli.js" || ! -f "$REVIEW_PACKAGE/dist/build-info.json" || "$CURRENT_IDENTITY" != "$PREVIOUS_IDENTITY" ]] || \
  needs_rebuild "$CLI_STAMP" \
    "$REVIEW_PACKAGE/src" \
    "$REVIEW_PACKAGE/tsdown.config.ts" \
    "$REVIEW_PACKAGE/tsconfig.json" \
    "$REVIEW_PACKAGE/package.json" \
    "$MONOREPO_ROOT/packages/local-vcs" \
    "$MONOREPO_ROOT/packages/review-protocol" \
    "$MONOREPO_ROOT/packages/trace-shared" \
    "$MONOREPO_ROOT/pnpm-lock.yaml" \
    "$MONOREPO_ROOT/pnpm-workspace.yaml" \
    "$MONOREPO_ROOT/package.json" \
    "$MONOREPO_ROOT/.nvmrc" \
    "${BASH_SOURCE[0]}"; then
  pnpm --dir "$MONOREPO_ROOT" --filter @dev.fast/review build
  printf '%s\n' "$CURRENT_IDENTITY" > "$CLI_IDENTITY"
  touch "$CLI_STAMP"
else
  echo "Review CLI output is current."
fi
