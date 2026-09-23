#!/usr/bin/env bash
# Build a disposable review home for live-testing legacy review import, then
# print how to launch the Desktop on it. The live ~/.dev is never modified.
#
#   bash apps/whiteboard-desktop/scripts/legacy-import-live-home.sh [home-dir]
#
# The home gets:
#   - a copy of ~/.dev/reviews (schema-5 reviews with sealed JSON, "old JSON")
#   - the three schema-4 legacy fixtures (never upgraded; legacy JS bundles)
#   - repos/review-scratch: a clone of this repository holding every commit
#     the reviews pin, used as the worktree for any review whose own worktree
#     is gone (its review.json is patched in the copy only)
#   - TESTER-README.md with the inventory and the CLI environment
set -euo pipefail

WORKSPACE=$(cd "$(dirname "$0")/../../.." && pwd)
FIXTURES="$WORKSPACE/packages/whiteboard/src/fixtures/legacy-reviews"
HOME_DIR=${1:-$(mktemp -d /tmp/review-live-XXXX)}
SCRATCH="$HOME_DIR/repos/review-scratch"
LIVE="${DEV_WHITEBOARD_HOME:-$HOME/.dev}"

if [ "$(cd "$HOME_DIR" && pwd -P)" = "$(cd "$LIVE" 2>/dev/null && pwd -P)" ]; then
  echo "refusing to build inside the live review home $LIVE" >&2
  exit 1
fi

mkdir -p "$HOME_DIR/reviews" "$HOME_DIR/repos"

if [ -d "$LIVE/reviews" ]; then
  cp -R "$LIVE/reviews/." "$HOME_DIR/reviews/"
fi

for archive in "$FIXTURES"/*.tgz; do
  name=$(basename "$archive" .tgz)
  uuid=$(python3 -c "import json;print(json.load(open('$FIXTURES/$name.json'))['sourceUuid'])")
  mkdir -p "$HOME_DIR/reviews/$uuid"
  tar -xzf "$archive" -C "$HOME_DIR/reviews/$uuid"
done

git clone --no-hardlinks --no-checkout --quiet "$WORKSPACE" "$SCRATCH"

# Fetch every pinned commit the reviews name; commits from other repositories
# simply fail to fetch and those reviews stay legacy, which is a valid state.
python3 - "$HOME_DIR/reviews" "$SCRATCH" "$WORKSPACE" <<'EOF'
import json, os, subprocess, sys

reviews, scratch, workspace = sys.argv[1:4]
patched = []

for uuid in sorted(os.listdir(reviews)):
    record_path = os.path.join(reviews, uuid, "review.json")

    if not os.path.isfile(record_path):
        continue

    record = json.load(open(record_path))
    commits = {record.get("baseCommit"), record.get("sourceCommit")}

    for commit in filter(None, commits):
        subprocess.run(
            ["git", "-C", scratch, "fetch", "--quiet", workspace, commit],
            check=False,
            stderr=subprocess.DEVNULL,
        )

    worktree = record.get("worktreePath") or ""

    if not os.path.isdir(worktree):
        record["worktreePath"] = scratch
        json.dump(record, open(record_path, "w"), indent=2)
        patched.append(uuid)

print(f"patched worktreePath on {len(patched)} review(s): {' '.join(patched)}", file=sys.stderr)
EOF

first=$(git -C "$SCRATCH" rev-list --all --max-count=1 2>/dev/null || true)

if [ -n "$first" ]; then
  git -C "$SCRATCH" checkout --quiet --detach "$first"
fi

{
  echo "# Live test home for legacy review import"
  echo
  echo "Home: $HOME_DIR (a copy; the live review home is untouched)"
  echo "Repository for reviews whose worktree was gone: $SCRATCH"
  echo "Test plan: $WORKSPACE/docs/superpowers/plans/2026-09-16-legacy-import-live-test-plan.md"
  echo
  echo "Launch the Desktop:"
  echo
  echo "    cd $WORKSPACE"
  echo "    DEV_WHITEBOARD_HOME=\"$HOME_DIR\" DEV_FAST_WHITEBOARD_TELEMETRY_DISABLED=1 DEV_FAST_WHITEBOARD_CLI_NO_DELEGATE=1 DEV_WHITEBOARD_EXTENSIONS=none pnpm dev"
  echo
  echo "CLI in a second terminal (run \`review\` from inside $SCRATCH):"
  echo
  echo "    export DEV_WHITEBOARD_HOME=\"$HOME_DIR\" DEV_FAST_WHITEBOARD_CLI_NO_DELEGATE=1 DEV_FAST_WHITEBOARD_TELEMETRY_DISABLED=1"
  echo "    alias review='pnpm --filter @dev.fast/whiteboard review'"
  echo
  echo "Inventory (state before the Desktop lists Home):"
  echo
  echo "| uuid | schema | sealed bundle | published | system | title |"
  echo "|---|---|---|---|---|---|"
  for dir in "$HOME_DIR"/reviews/*/; do
    python3 - "$dir" <<'EOF'
import json, os, sys

directory = sys.argv[1]
record = json.load(open(os.path.join(directory, "review.json")))
document = os.path.join(directory, ".bundle/document/whiteboard-document.json")
legacy = os.path.join(directory, ".bundle/whiteboard-document.js")
bundle = "json" if os.path.exists(document) else "js" if os.path.exists(legacy) else "in git only"
print(
    f"| {os.path.basename(directory.rstrip('/'))} | {record['schemaVersion']} | {bundle} | "
    f"{bool(record.get('presentedDocumentRevision'))} | {record.get('visibility') == 'system'} | {record['title']} |"
)
EOF
  done
  echo
  echo "Expected: schema-4 reviews with an existing worktree are migrated to sealed JSON on read and then imported; schema-5 JSON reviews are imported directly; the system review is skipped; a review whose worktree is still missing stays legacy."
  echo "Watch dev.log for \`[Review import] <uuid>: imported as version N\` or \`skipped (<reason>)\`."
} > "$HOME_DIR/TESTER-README.md"

echo "$HOME_DIR"
cat "$HOME_DIR/TESTER-README.md"
