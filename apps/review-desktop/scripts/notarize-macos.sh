#!/usr/bin/env bash
set -euo pipefail

MONOREPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
APP_DIR="$MONOREPO_ROOT/apps/review-desktop"
CHECKOUT="$APP_DIR/code-oss"
PRODUCT_NAME="$(node -p "require('$CHECKOUT/product.json').nameShort")"
PACKAGED_APP="$APP_DIR/VSCode-darwin-arm64/$PRODUCT_NAME.app"
VERSION="$(node -p "require('$APP_DIR/package.json').version")"
ARTIFACT_DIR="${DEV_FAST_REVIEW_ARTIFACT_DIR:-$APP_DIR/dist}"
UPDATE_ZIP="$ARTIFACT_DIR/Review-darwin-arm64-$VERSION.zip"
DMG="$ARTIFACT_DIR/Review-darwin-arm64-$VERSION.dmg"

if (( $# > 0 )); then
  echo "usage: $0" >&2
  exit 2
fi
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Review Desktop macOS notarization must run on macOS" >&2
  exit 1
fi
if [[ "$(uname -m)" != "arm64" ]]; then
  echo "Review Desktop macOS notarization requires arm64" >&2
  exit 1
fi
if [[ "${SKIP_NOTARIZE:-0}" == "1" ]]; then
  echo "SKIP_NOTARIZE=1: leaving Review Desktop unsigned and unnotarized"
  exit 0
fi
if [[ ! -d "$PACKAGED_APP" ]]; then
  echo "Review Desktop package does not exist at $PACKAGED_APP" >&2
  exit 1
fi

# The signing identity sits with the other Apple credentials as
# $APPLE_SIGN_IDENTITY, while upstream's sign.ts reads $CODESIGN_IDENTITY.
# Accept either name so sourcing the Apple credentials is enough to notarize.
# sign.ts runs as a child process below, so this has to be exported.
if [[ -z "${CODESIGN_IDENTITY:-}" && -n "${APPLE_SIGN_IDENTITY:-}" ]]; then
  export CODESIGN_IDENTITY="$APPLE_SIGN_IDENTITY"
fi

# Credentials come either from a stored notarytool keychain profile, which is
# how a developer notarizes locally, or from the individual variables CI sets.
# The profile is preferred: an App Store Connect key or app-specific password
# then never reaches the environment, the process table, or a log.
NOTARY_ARGS=()
if [[ -n "${NOTARY_KEYCHAIN_PROFILE:-}" ]]; then
  NOTARY_ARGS=(--keychain-profile "$NOTARY_KEYCHAIN_PROFILE")
  REQUIRED_VARIABLES=(CODESIGN_IDENTITY)
elif [[ -n "${APPLE_API_KEY_PATH:-}" ]]; then
  # An App Store Connect team key is how CI authenticates. It outlives the
  # Apple ID's password and 2FA changes that an app-specific password does
  # not, and the private key stays a file rather than an environment value.
  REQUIRED_VARIABLES=(
    CODESIGN_IDENTITY
    APPLE_API_KEY_ID
    APPLE_API_ISSUER_ID
  )
else
  REQUIRED_VARIABLES=(
    CODESIGN_IDENTITY
    APPLE_ID
    APPLE_TEAM_ID
    APPLE_ID_PASSWORD
  )
fi

for required_variable in "${REQUIRED_VARIABLES[@]}"; do
  if [[ -z "${!required_variable:-}" ]]; then
    if [[ "$required_variable" != CODESIGN_IDENTITY ]]; then
      if [[ -n "${APPLE_API_KEY_PATH:-}" ]]; then
        echo "\$$required_variable must be set alongside \$APPLE_API_KEY_PATH" >&2
      else
        echo "\$$required_variable must be set (or set \$APPLE_API_KEY_PATH for" \
          "an App Store Connect key, or \$NOTARY_KEYCHAIN_PROFILE to use a" \
          "stored notarytool profile)" >&2
      fi
    else
      echo "\$CODESIGN_IDENTITY or \$APPLE_SIGN_IDENTITY must be set" >&2
    fi
    exit 1
  fi
done

if (( ${#NOTARY_ARGS[@]} == 0 )); then
  if [[ -n "${APPLE_API_KEY_PATH:-}" ]]; then
    if [[ ! -f "$APPLE_API_KEY_PATH" ]]; then
      echo "\$APPLE_API_KEY_PATH is not a file: $APPLE_API_KEY_PATH" >&2
      exit 1
    fi
    NOTARY_ARGS=(
      --key "$APPLE_API_KEY_PATH"
      --key-id "$APPLE_API_KEY_ID"
      --issuer "$APPLE_API_ISSUER_ID"
    )
  else
    NOTARY_ARGS=(
      --apple-id "$APPLE_ID"
      --team-id "$APPLE_TEAM_ID"
      --password "$APPLE_ID_PASSWORD"
    )
  fi
fi

TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/dev-fast-review-notarize.XXXXXX")"
trap 'rm -rf -- "$TEMP_ROOT"' EXIT
DMG_STAGE="$TEMP_ROOT/dmg"

submit_notarization() {
  local artifact="$1"
  local label="$2"
  local response="$TEMP_ROOT/$label-notary-response.json"

  if ! xcrun notarytool submit "$artifact" \
    "${NOTARY_ARGS[@]}" \
    --wait \
    --output-format json | tee "$response"; then
    echo "Apple notarization failed for $artifact" >&2
    return 1
  fi

  node --input-type=module -e '
    import fs from "node:fs";
    const response = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (response.status !== "Accepted") {
      throw new Error(`Notarization ${response.id ?? "submission"} finished with status ${response.status ?? "unknown"}`);
    }
    console.log(`Accepted notarization ${response.id}`);
  ' "$response"
}

export VSCODE_ARCH=arm64
node --experimental-strip-types "$CHECKOUT/build/darwin/sign.ts" "$APP_DIR"

codesign --verify --deep --strict --verbose=2 "$PACKAGED_APP"
codesign -dv --verbose=2 "$PACKAGED_APP"

mkdir -p "$ARTIFACT_DIR"
rm -f -- "$UPDATE_ZIP" "$DMG"

mkdir -p "$DMG_STAGE"
ditto "$PACKAGED_APP" "$DMG_STAGE/$PRODUCT_NAME.app"
ln -s /Applications "$DMG_STAGE/Applications"
hdiutil create \
  -volname "$PRODUCT_NAME" \
  -srcfolder "$DMG_STAGE" \
  -ov \
  -format UDZO \
  "$DMG"

CODESIGN_DMG_ARGS=(--force --timestamp --sign "$CODESIGN_IDENTITY")
if [[ -n "${CODESIGN_KEYCHAIN:-}" ]]; then
  CODESIGN_DMG_ARGS+=(--keychain "$CODESIGN_KEYCHAIN")
elif [[ -n "${AGENT_TEMPDIRECTORY:-}" ]]; then
  CODESIGN_DMG_ARGS+=(--keychain "$AGENT_TEMPDIRECTORY/buildagent.keychain")
fi
codesign "${CODESIGN_DMG_ARGS[@]}" "$DMG"

# One submission: notarizing the DMG also records tickets for the nested app,
# so both artifacts staple from this single Apple round trip.
submit_notarization "$DMG" dmg
xcrun stapler staple "$DMG"
xcrun stapler validate "$DMG"
xcrun stapler staple "$PACKAGED_APP"
xcrun stapler validate "$PACKAGED_APP"
spctl -a -vv --type exec "$PACKAGED_APP"
spctl -a -vv --type open --context context:primary-signature "$DMG"

# The update zip ships the stapled app.
ditto -c -k --keepParent "$PACKAGED_APP" "$UPDATE_ZIP"

echo "Created notarized Review Desktop artifacts:"
echo "  $UPDATE_ZIP"
echo "  $DMG"
