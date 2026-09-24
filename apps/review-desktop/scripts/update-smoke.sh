#!/usr/bin/env bash
# Prove a published build updates in place: run it from a throwaway folder,
# let Squirrel download and install the channel's current release, then check
# that the bundle folder kept its name and carries the new version.
#
#   update-smoke.sh <stable|preview> <from-version> <Review|Whiteboard>
#
# The third argument picks which update zip the starting build came from, so
# the folder is named like an install that predates or postdates the rename.
# Squirrel state is keyed by bundle id, so never run this beside a Desktop of
# the same channel.
set -euo pipefail

QUALITY="$1"; FROM_VERSION="$2"; ARTIFACT="$3"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
WORK="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/update-smoke-$ARTIFACT"
UPDATE_URL="https://update.dev.fast"

FOLDER="$(node "$APP_DIR/scripts/release-channel.mjs" "$QUALITY" | awk -F'\t' -v a="$ARTIFACT" '$2 == a { print $1 }')"
[[ -n "$FOLDER" ]] || { echo "no $ARTIFACT zip in the $QUALITY channel" >&2; exit 2; }
case "$QUALITY" in
  stable) BUNDLE_ID="dev.fast.review" ;;
  preview) BUNDLE_ID="dev.fast.review.preview" ;;
esac
SHIPIT="$HOME/Library/Caches/$BUNDLE_ID.ShipIt"
FEED="$UPDATE_URL/api/update/darwin-arm64/$QUALITY/0000000000000000000000000000000000000000"

if pgrep -f "/Contents/MacOS/" | xargs -I{} ps -o command= -p {} 2>/dev/null | grep -q "$BUNDLE_ID\|$FOLDER.app"; then
  echo "a $QUALITY Desktop is already running; Squirrel state is shared by bundle id" >&2
  exit 1
fi

rm -rf "$WORK"; mkdir -p "$WORK/app" "$WORK/state/user-data" "$WORK/state/extensions" "$WORK/home"
ZIP="$ARTIFACT-darwin-arm64-$FROM_VERSION.zip"
echo "Downloading $ZIP"
curl -fsSLo "$WORK/$ZIP" "$UPDATE_URL/releases/$FROM_VERSION/darwin-arm64/$ZIP"
ditto -x -k "$WORK/$ZIP" "$WORK/app"
APP="$WORK/app/$FOLDER.app"
[[ -d "$APP" ]] || { echo "$ZIP did not unpack to $FOLDER.app:"; ls "$WORK/app"; exit 1; }
EXECUTABLE="$(defaults read "$APP/Contents/Info.plist" CFBundleExecutable)"
BEFORE="$(node -p "require('$APP/Contents/Resources/app/product.json').reviewVersion")"

EXPECTED="$(curl -fsS "$FEED?bundle=$(printf %s "$FOLDER" | sed 's/ /%20/g')" | node -p "JSON.parse(require('fs').readFileSync(0, 'utf8')).productVersion")"
echo "Starting from $FOLDER.app ($BEFORE); the feed offers $EXPECTED"
[[ "$BEFORE" != "$EXPECTED" ]] || { echo "nothing to update to; publish a newer $QUALITY build first" >&2; exit 2; }

mkdir -p "$SHIPIT"; touch "$SHIPIT/ShipIt_stderr.log"
LOG_START="$(wc -l < "$SHIPIT/ShipIt_stderr.log")"

DEV_REVIEW_HOME="$WORK/home" DEV_REVIEW_IMPORT_FROM=none ELECTRON_ENABLE_LOGGING=1 \
  "$APP/Contents/MacOS/$EXECUTABLE" \
  "--user-data-dir=$WORK/state/user-data" "--extensions-dir=$WORK/state/extensions" \
  >"$WORK/app.stdout" 2>"$WORK/app.stderr" &
PID=$!

# The updater's first check runs 30 s after launch; "ready" means Squirrel
# has verified the download and handed ShipIt the install request.
MAIN_LOG=""
for _ in $(seq 1 90); do
  MAIN_LOG="$(find "$WORK/state/user-data/logs" -name main.log 2>/dev/null | head -1)"
  [[ -n "$MAIN_LOG" ]] && grep -q "update#setState ready" "$MAIN_LOG" && break
  kill -0 "$PID" 2>/dev/null || { echo "app exited early"; tail -20 "$WORK/app.stderr"; exit 1; }
  sleep 5
done
if [[ -z "$MAIN_LOG" ]] || ! grep -q "update#setState ready" "$MAIN_LOG"; then
  echo "the app never reached the ready state" >&2
  [[ -n "$MAIN_LOG" ]] && grep -i "update" "$MAIN_LOG" | tail -30 >&2
  exit 1
fi
grep -E "update#setState|Update downloaded" "$MAIN_LOG" | sed 's/^/  /'
echo "Squirrel cache:"; find "$SHIPIT" -mindepth 1 -maxdepth 1 -exec basename {} \; | sed 's/^/  /'
[[ -f "$SHIPIT/ShipItState.plist" ]] && plutil -p "$SHIPIT/ShipItState.plist" | grep -E "BundleURL|useUpdateBundleName" | sed 's/^/  /'

# Squirrel installs when the app exits, however it exits.
kill -TERM "$PID"; sleep 15; kill -KILL "$PID" 2>/dev/null || true; wait "$PID" 2>/dev/null || true
for _ in $(seq 1 60); do
  tail -n +"$((LOG_START + 1))" "$SHIPIT/ShipIt_stderr.log" | grep -q -E "Installation completed|Installation error" && break
  sleep 2
done
echo "ShipIt:"; tail -n +"$((LOG_START + 1))" "$SHIPIT/ShipIt_stderr.log" | grep -E "Beginning|Installation|error" | sed 's/^/  /'

BUNDLES="$(find "$WORK/app" -mindepth 1 -maxdepth 1)"
echo "On disk:"; echo "$BUNDLES" | sed 's/^/  /'
[[ -d "$APP" ]] || { echo "FAIL: $FOLDER.app is gone; the install renamed it" >&2; exit 1; }
[[ "$(echo "$BUNDLES" | wc -l)" -eq 1 ]] || { echo "FAIL: more than one bundle in the folder" >&2; exit 1; }
AFTER="$(node -p "require('$APP/Contents/Resources/app/product.json').reviewVersion")"
[[ "$AFTER" == "$EXPECTED" ]] || { echo "FAIL: $FOLDER.app is at $AFTER, expected $EXPECTED" >&2; exit 1; }
tail -n +"$((LOG_START + 1))" "$SHIPIT/ShipIt_stderr.log" | grep -q "Installation completed successfully" || { echo "FAIL: ShipIt did not report success" >&2; exit 1; }
echo "PASS: $FOLDER.app went from $BEFORE to $AFTER in place"
