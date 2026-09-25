#!/usr/bin/env bash
# Container entrypoint for verify-deb-package.sh. Never run on a user machine.
set -euo pipefail
[[ -n "${DEB:-}" && -n "${PACKAGE:-}" && -n "${APP:-}" ]]
apt-get update
apt-get install -y --no-install-recommends desktop-file-utils
# Installing the file through apt resolves the package's declared dependencies
# from the Ubuntu archive, which dpkg alone would only report as unmet.
apt-get install -y --no-install-recommends "/packages/$DEB"
test "$(dpkg-query -W -f '${Version}' "$PACKAGE")" = "$(dpkg-deb -f "/packages/$DEB" Version)"
if command -v node; then echo 'Debian package unexpectedly requires system Node' >&2; exit 1; fi
"$APP" --help >/dev/null
test "$(stat -c %u:%g:%a "/usr/share/$APP/chrome-sandbox")" = "0:0:4755"
test -f "/usr/share/applications/$PACKAGE.desktop"
desktop-file-validate "/usr/share/applications/$PACKAGE-url-handler.desktop"
test "$(xdg-mime query default "x-scheme-handler/$PACKAGE")" = "$PACKAGE-url-handler.desktop"

# Reinstalling over an installed copy is how a downloaded deb updates itself.
apt-get install -y --no-install-recommends --reinstall "/packages/$DEB"
"$APP" --help >/dev/null

mkdir -p /root/.dev/reviews /root/.config/Review/User /root/.claude
for SENTINEL in /root/.dev/reviews/package-test /root/.config/Review/User/settings.json /root/.claude/settings.json; do
  printf 'keep me\n' > "$SENTINEL"
done
apt-get remove -y "$PACKAGE"
test ! -e "/usr/share/$APP"
for SENTINEL in /root/.dev/reviews/package-test /root/.config/Review/User/settings.json /root/.claude/settings.json; do
  test "$(cat "$SENTINEL")" = 'keep me'
done
