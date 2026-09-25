#!/usr/bin/env bash
# Container entrypoint for verify-repository.sh. Never run on a user machine.
set -euo pipefail
: "${GENERATION:?}" "${FINGERPRINT:?}" "${PREFIX:?}" "${PACKAGE:?}" "${APP:?}" "${CHANNEL:?}"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends gnupg python3 desktop-file-utils apparmor xvfb xauth dbus-x11 procps
cp -a "/publication/$PREFIX/apt" /repo
cp -a "/publication/$PREFIX/snapshots/$GENERATION/apt/dists/$CHANNEL/." "/repo/dists/$CHANNEL/"
install -d -m 0755 /etc/apt/keyrings
install -m 0644 "/publication/repos/keys/$FINGERPRINT.asc" /etc/apt/keyrings/review-test.asc
# HTTP also exercises APT's by-hash requests and package checksums.
python3 -m http.server 8765 --bind 127.0.0.1 --directory /repo >/tmp/apt-http.log 2>&1 &
HTTP_PID=$!
trap 'cat /tmp/apt-http.log; kill "$HTTP_PID" 2>/dev/null || true' EXIT
# Fail with the server log instead of an opaque APT connection error.
python3 - <<'READY'
import time
import urllib.request
for attempt in range(50):
    try:
        urllib.request.urlopen("http://127.0.0.1:8765/", timeout=1).close()
        break
    except OSError:
        time.sleep(0.1)
else:
    raise RuntimeError("APT test server did not start")
READY
cat > /etc/apt/sources.list.d/review-test.sources <<SOURCES
Types: deb
URIs: http://127.0.0.1:8765
Suites: $CHANNEL
Components: main
Architectures: amd64
Signed-By: /etc/apt/keyrings/review-test.asc
SOURCES
apt-get -o APT::Update::Error-Mode=any update
apt-get install -y --no-install-recommends "$PACKAGE"
if command -v node; then echo 'Ubuntu package unexpectedly requires system Node' >&2; exit 1; fi
"$APP" --help >/dev/null
test "$(stat -c %u:%g:%a "/usr/share/$APP/chrome-sandbox")" = '0:0:4755'
desktop-file-validate "/usr/share/applications/$PACKAGE.desktop"
desktop-file-validate "/usr/share/applications/$PACKAGE-url-handler.desktop"
test "$(xdg-mime query default "x-scheme-handler/$PACKAGE")" = "$PACKAGE-url-handler.desktop"
apparmor_parser --skip-kernel-load --skip-read-cache "/etc/apparmor.d/$PACKAGE"
test ! -e /etc/apt/sources.list.d/vscode.sources
# `set -e` ignores a negated pipeline, so fail explicitly.
if update-alternatives --list editor 2>/dev/null | grep -qF "/usr/bin/$APP"; then
  echo "$APP must not register itself as an editor alternative" >&2
  exit 1
fi
# An unprivileged user must start a renderer and the embedded Review server.
useradd -m tester
runuser -u tester -- env APP="$APP" DO_NOT_TRACK=1 dbus-run-session -- xvfb-run -a bash /test/smoke-installed-linux.sh
mkdir -p /home/tester/.dev/reviews /home/tester/.config/Review/User /home/tester/.claude
for SENTINEL in /home/tester/.dev/reviews/package-test /home/tester/.config/Review/User/settings.json /home/tester/.claude/settings.json; do
  printf 'keep me\n' > "$SENTINEL"
done

# Replace an older package and check removal of files owned only by that version.
mkdir -p /tmp/older/DEBIAN "/tmp/older/usr/share/$APP"
printf 'Package: %s\nVersion: 0.0.0-1\nArchitecture: amd64\nMaintainer: Test <test@example.test>\nDescription: Upgrade fixture\n' "$PACKAGE" > /tmp/older/DEBIAN/control
printf 'older\n' > "/tmp/older/usr/share/$APP/upgrade-fixture"
dpkg-deb --build /tmp/older /tmp/older.deb
dpkg -i /tmp/older.deb
apt-get install -y --no-install-recommends --only-upgrade "$PACKAGE"
test ! -e "/usr/share/$APP/upgrade-fixture"
"$APP" --help >/dev/null
apt-get purge -y "$PACKAGE"
for SENTINEL in /home/tester/.dev/reviews/package-test /home/tester/.config/Review/User/settings.json /home/tester/.claude/settings.json; do
  test "$(cat "$SENTINEL")" = 'keep me'
done
test ! -e "/usr/bin/$APP"
test ! -e "/usr/share/applications/$PACKAGE.desktop"
test ! -e "/etc/apparmor.d/$PACKAGE"

# Reject modified package bytes even when the index remains correctly signed.
printf tampered >> /repo/pool/main/*.deb
apt-get clean
if apt-get install -y --download-only "$PACKAGE" >/tmp/tampered-deb 2>&1; then
  cat /tmp/tampered-deb; echo 'APT accepted a tampered package' >&2; exit 1
fi
grep -Eiq 'hash|checksum|size' /tmp/tampered-deb
cp "/publication/$PREFIX/apt/pool/main/"*.deb /repo/pool/main/

# Force fresh lists so cached metadata cannot hide a broken signature or index.
check_rejected_update() {
  rm -f /var/lib/apt/lists/127.0.0.1*
  if apt-get -o APT::Update::Error-Mode=any update >/tmp/rejected-apt 2>&1; then
    cat /tmp/rejected-apt; echo 'APT accepted an untrusted repository' >&2; exit 1
  fi
  grep -Eiq 'signature|signed|public key|hash|checksum|size|NOSPLIT' /tmp/rejected-apt
}
sed -i 's/Origin: dev.fast/Origin: tampered/' "/repo/dists/$CHANNEL/InRelease"
check_rejected_update
cp "/publication/$PREFIX/snapshots/$GENERATION/apt/dists/$CHANNEL/InRelease" "/repo/dists/$CHANNEL/"
for INDEX in /repo/dists/"$CHANNEL"/main/binary-amd64/by-hash/SHA256/*; do printf tampered >> "$INDEX"; done
check_rejected_update
cp "/publication/$PREFIX/apt/dists/$CHANNEL/main/binary-amd64/by-hash/SHA256/"* "/repo/dists/$CHANNEL/main/binary-amd64/by-hash/SHA256/"
install -d -m 0700 /tmp/wrong-key
GNUPGHOME=/tmp/wrong-key gpg --batch --pinentry-mode loopback --passphrase '' --quick-generate-key 'Wrong CI key' rsa3072 sign 1d
GNUPGHOME=/tmp/wrong-key gpg --armor --export > /etc/apt/keyrings/review-test.asc
check_rejected_update
grep -F '/by-hash/SHA256/' /tmp/apt-http.log >/dev/null
