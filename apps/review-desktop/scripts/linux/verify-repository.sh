#!/usr/bin/env bash
# Run on the Linux package builder after build-linux-repository.py.
set -euo pipefail
TARGET="${2:-all}"
case "$TARGET" in all|ubuntu:22.04|ubuntu:24.04|arch) ;; *) echo "Unknown test target: $TARGET" >&2; exit 2 ;; esac
PUBLICATION="$(cd "${1:?usage: verify-repository.sh publication-directory}" && pwd -P)"
GENERATION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["generation"])' "$PUBLICATION/repos/current.json")"
FINGERPRINT="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["keyFingerprint"])' "$PUBLICATION/repos/current.json")"
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT
# Materialize the Worker's mutable redirects for file:// package-manager tests.
cp -a "$PUBLICATION/repos/." "$TEMP/"
cp -a "$TEMP/snapshots/$GENERATION/apt/." "$TEMP/apt/dists/stable/"
cp -a "$TEMP/snapshots/$GENERATION/arch/." "$TEMP/arch/x86_64/"
chmod -R a+rX "$TEMP"

for IMAGE in ubuntu:22.04 ubuntu:24.04; do
  if [[ "$TARGET" != all && "$TARGET" != "$IMAGE" ]]; then continue; fi
  docker run --rm --platform linux/amd64 -v "$TEMP:/source-repo:ro" "$IMAGE" bash -euc '
    cp -a /source-repo /repo
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y --no-install-recommends ca-certificates gnupg
    install -d -m 0755 /etc/apt/keyrings
    cp /repo/keys/*.asc /etc/apt/keyrings/review.asc
    printf "deb [arch=amd64 signed-by=/etc/apt/keyrings/review.asc] file:/repo/apt stable main\n" > /etc/apt/sources.list.d/review.list
    apt-get update -qq
    apt-get install -y --no-install-recommends dev-fast-review
    test "$(stat -c %u:%g:%a /usr/share/review/chrome-sandbox)" = "0:0:4755"
    review --help >/dev/null
    test -f /usr/share/applications/dev-fast-review.desktop
    test ! -e /usr/share/applications/review-url-handler.desktop
    mkdir -p /root/.dev/reviews
    printf "keep me\n" >/root/.dev/reviews/package-test
    # Exercise package replacement with an older metadata fixture containing the
    # same runtime; real previous-release migration remains a release QA gate.
    dpkg-deb -R /repo/apt/pool/main/d/dev-fast-review/*.deb /tmp/older
    sed -i "s/^Version:.*/Version: 0~ci/" /tmp/older/DEBIAN/control
    dpkg-deb -Zxz --build /tmp/older /tmp/older.deb
    apt-get install -y --allow-downgrades /tmp/older.deb
    test "$(dpkg-query -W -f=\${Version} dev-fast-review)" = "0~ci"
    apt-get install -y --only-upgrade dev-fast-review
    test "$(dpkg-query -W -f=\${Version} dev-fast-review)" != "0~ci"
    review --help >/dev/null
    test "$(cat /root/.dev/reviews/package-test)" = "keep me"
    apt-get remove -y dev-fast-review
    test "$(cat /root/.dev/reviews/package-test)" = "keep me"
    # Signed metadata must reject package bytes changed after publication.
    printf "tampered" >> /repo/apt/pool/main/d/dev-fast-review/*.deb
    apt-get clean
    if apt-get install -y --no-install-recommends --download-only dev-fast-review >/tmp/tampered 2>&1; then
      cat /tmp/tampered; echo "APT accepted a tampered package" >&2; exit 1
    fi
    grep -Eiq "Hash Sum mismatch|unexpected size" /tmp/tampered
    # Replacing the trusted key with an unrelated key must prevent installation.
    install -d -m 0700 /tmp/wrong-key
    GNUPGHOME=/tmp/wrong-key gpg --batch --passphrase "" --quick-generate-key "Wrong CI key" rsa2048 sign 1d
    GNUPGHOME=/tmp/wrong-key gpg --armor --export >/etc/apt/keyrings/review.asc
    rm -rf /var/lib/apt/lists/*
    if apt-get update -o APT::Update::Error-Mode=any -o Dir::Etc::sourcelist=/etc/apt/sources.list.d/review.list -o Dir::Etc::sourceparts=- >/tmp/rejected 2>&1; then
      cat /tmp/rejected; echo "APT accepted an untrusted repository" >&2; exit 1
    fi
    grep -Eq "NO_PUBKEY|not signed|signatures" /tmp/rejected
  '
  echo "$IMAGE: install, upgrade, data retention, tamper and untrusted-key rejection passed"
done

if [[ "$TARGET" != all && "$TARGET" != arch ]]; then exit 0; fi

ARCH_IMAGE='archlinux:base-devel@sha256:61f7de2dd88cc4ba1fe36c24cfe1a503c3936984492d6405eeab013ce6ac68c5'
docker run --rm --platform linux/amd64 -v "$TEMP:/source-repo:ro" -e FINGERPRINT="$FINGERPRINT" -e REVIEW_TEST_DISABLE_SANDBOX "$ARCH_IMAGE" bash -euc '
  cp -a /source-repo /repo
  # Rosetta emulation cannot install pacmans seccomp filter. This local-only
  # opt-in leaves package/database signature verification enabled.
  if [ "${REVIEW_TEST_DISABLE_SANDBOX:-0}" = 1 ]; then
    sed -i "/^\\[options\\]/a DisableSandbox" /etc/pacman.conf
  fi
  pacman-key --init
  pacman-key --populate archlinux
  pacman-key --add /repo/keys/*.asc
  pacman-key --lsign-key "$FINGERPRINT"
  printf "\n[dev-fast-review]\nSigLevel = Required TrustedOnly\nServer = file:///repo/arch/x86_64\n" >> /etc/pacman.conf
  pacman -Syu --noconfirm dev-fast-review
  test "$(stat -c %u:%g:%a /usr/share/review/chrome-sandbox)" = "0:0:4755"
  review --help >/dev/null
  mkdir -p /root/.dev/reviews
  printf "keep me\n" >/root/.dev/reviews/package-test
  mkdir /tmp/older
  tar --zstd -xf /repo/arch/x86_64/*.pkg.tar.zst -C /tmp/older
  sed -i "s/^pkgver =.*/pkgver = 0.0.0-1/" /tmp/older/.PKGINFO
  tar --zstd -cf /tmp/older.pkg.tar.zst -C /tmp/older .PKGINFO .BUILDINFO .MTREE usr
  pacman -U --noconfirm /tmp/older.pkg.tar.zst
  test "$(pacman -Q dev-fast-review)" = "dev-fast-review 0.0.0-1"
  pacman -Syu --noconfirm
  test "$(pacman -Q dev-fast-review)" != "dev-fast-review 0.0.0-1"
  review --help >/dev/null
  test "$(cat /root/.dev/reviews/package-test)" = "keep me"
  pacman -R --noconfirm dev-fast-review
  test "$(cat /root/.dev/reviews/package-test)" = "keep me"
  printf "tampered" >> /repo/arch/x86_64/*.pkg.tar.zst
  rm -f /var/cache/pacman/pkg/dev-fast-review-*
  if pacman -Sw --noconfirm dev-fast-review >/tmp/tampered 2>&1; then
    cat /tmp/tampered; echo "pacman accepted a tampered package" >&2; exit 1
  fi
  grep -Eiq "signature|corrupt|invalid|size" /tmp/tampered
  pacman-key --delete "$FINGERPRINT"
  rm -f /var/lib/pacman/sync/dev-fast-review.*
  if pacman -Syy --noconfirm >/tmp/rejected 2>&1; then
    cat /tmp/rejected; echo "pacman accepted an untrusted repository" >&2; exit 1
  fi
  grep -Eiq "signature|unknown trust|unknown public key" /tmp/rejected
'
echo "Arch: install, upgrade, data retention, tamper and untrusted-key rejection passed"
