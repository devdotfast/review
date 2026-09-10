#!/usr/bin/env bash
# Container entrypoint for verify-repository.sh. Never run on a user machine.
set -euo pipefail
[[ -f /publication/repos/current.json && -n "${GENERATION:-}" && -n "${FINGERPRINT:-}" ]]
cp -a /publication/repos /repo
cp /repo/snapshots/"$GENERATION"/rpm/repodata/repomd.xml* /repo/rpm/x86_64/repodata/
dnf -y --setopt=install_weak_deps=False install rpm-build gnupg2 cpio
rpm --import /repo/keys/"$FINGERPRINT".asc
cat > /etc/yum.repos.d/dev-fast-review.repo <<EOF
[dev-fast-review]
name=Review validation
baseurl=file:///repo/rpm/x86_64/
enabled=1
gpgcheck=1
repo_gpgcheck=1
skip_if_unavailable=0
gpgkey=file:///repo/keys/$FINGERPRINT.asc
EOF
dnf -y --setopt=install_weak_deps=False install dev-fast-review
if command -v node; then echo 'Fedora package unexpectedly requires system Node' >&2; exit 1; fi
review --help >/dev/null
test "$(stat -c %u:%g:%a /usr/share/review/chrome-sandbox)" = "0:0:4755"
test -f /usr/share/applications/dev-fast-review.desktop
test ! -e /usr/share/applications/review-url-handler.desktop
mkdir -p /root/.dev/reviews /root/.config/Review/User /root/.claude
for SENTINEL in /root/.dev/reviews/package-test /root/.config/Review/User/settings.json /root/.claude/settings.json; do
  printf 'keep me\n' > "$SENTINEL"
done

# Exercise replacement with the same runtime and older metadata. This fixture
# does not claim to prove migration from a previous released Fedora runtime.
mkdir -p /tmp/older-root /tmp/rpmbuild/SPECS
rpm -ql dev-fast-review | cpio -pdm /tmp/older-root
cat > /tmp/rpmbuild/SPECS/older.spec <<'EOF'
Name: dev-fast-review
Version: 0
Release: 0
Summary: Review upgrade validation fixture
License: MIT
BuildArch: x86_64
AutoReqProv: no
%global __brp_strip %{nil}
%global __brp_strip_comment_note %{nil}
%global debug_package %{nil}
%global _build_id_links none
%description
Current runtime with older metadata, only for package upgrade validation.
%install
mkdir -p %{buildroot}
cp -a /tmp/older-root/usr %{buildroot}/
%files
%defattr(-,root,root)
/usr/bin/review
/usr/bin/review-desktop
/usr/share/review/
%attr(4755,root,root) /usr/share/review/chrome-sandbox
/usr/share/applications/dev-fast-review.desktop
/usr/share/metainfo/dev-fast-review.metainfo.xml
/usr/share/icons/hicolor/512x512/apps/review.png
EOF
rpmbuild --define '_topdir /tmp/rpmbuild' --define '_binary_payload w3.zstdio' -bb /tmp/rpmbuild/SPECS/older.spec
# Only this locally built test fixture bypasses a signature. DNF repository
# package and metadata verification remain enabled for every repository action.
rpm -U --oldpackage --nosignature /tmp/rpmbuild/RPMS/x86_64/dev-fast-review-0-0.x86_64.rpm
test "$(rpm -q --qf '%{VERSION}' dev-fast-review)" = 0
dnf -y --setopt=install_weak_deps=False upgrade --refresh dev-fast-review
test "$(rpm -q --qf '%{VERSION}' dev-fast-review)" != 0
review --help >/dev/null
dnf -y remove dev-fast-review
for SENTINEL in /root/.dev/reviews/package-test /root/.config/Review/User/settings.json /root/.claude/settings.json; do
  test "$(cat "$SENTINEL")" = 'keep me'
done

# Verify both DNF's metadata checksum and RPM's own package signature/digests.
printf tampered >> /repo/rpm/x86_64/Packages/*.rpm
if rpmkeys --checksig /repo/rpm/x86_64/Packages/*.rpm > /tmp/tampered-rpm 2>&1; then
  cat /tmp/tampered-rpm; echo 'RPM accepted a tampered package' >&2; exit 1
fi
dnf clean packages
if dnf -y --setopt=install_weak_deps=False install --downloadonly dev-fast-review > /tmp/tampered-dnf 2>&1; then
  cat /tmp/tampered-dnf; echo 'DNF accepted a tampered package' >&2; exit 1
fi
grep -Eiq 'checksum|digest|signature|corrupt|size' /tmp/tampered-dnf
cp /publication/repos/rpm/x86_64/Packages/*.rpm /repo/rpm/x86_64/Packages/

# A changed repomd.xml must fail even when it remains parseable XML.
printf '<!-- tampered -->\n' >> /repo/rpm/x86_64/repodata/repomd.xml
if dnf -y --repo=dev-fast-review --setopt=system_cachedir=/tmp/changed-repomd --refresh makecache > /tmp/tampered-metadata 2>&1; then
  cat /tmp/tampered-metadata; echo 'DNF accepted unsigned metadata changes' >&2; exit 1
fi
grep -Eiq 'signature|GPG|OpenPGP' /tmp/tampered-metadata
cp /publication/repos/snapshots/"$GENERATION"/rpm/repodata/repomd.xml /repo/rpm/x86_64/repodata/

# Signed root metadata must also reject changed content-addressed index bytes.
printf tampered >> /repo/rpm/x86_64/repodata/*-primary.xml.gz
if dnf -y --repo=dev-fast-review --setopt=system_cachedir=/tmp/changed-index --refresh makecache > /tmp/tampered-index 2>&1; then
  cat /tmp/tampered-index; echo 'DNF accepted a tampered index' >&2; exit 1
fi
grep -Eiq 'checksum|digest|corrupt|size' /tmp/tampered-index
cp /publication/repos/rpm/x86_64/repodata/*-primary.xml.gz /repo/rpm/x86_64/repodata/

# Use a separate metadata cache and unrelated trusted key to avoid reusing trust.
install -d -m 0700 /tmp/wrong-key
GNUPGHOME=/tmp/wrong-key gpg --batch --pinentry-mode loopback --passphrase '' --quick-generate-key 'Wrong CI key' rsa3072 sign 1d
GNUPGHOME=/tmp/wrong-key gpg --armor --export > /tmp/wrong.asc
rpmkeys --delete "$FINGERPRINT"
rpm --import /tmp/wrong.asc
sed -i 's|^gpgkey=.*|gpgkey=file:///tmp/wrong.asc|' /etc/yum.repos.d/dev-fast-review.repo
if dnf -y --repo=dev-fast-review --setopt=system_cachedir=/tmp/untrusted-cache --refresh makecache > /tmp/untrusted 2>&1; then
  cat /tmp/untrusted; echo 'DNF accepted an untrusted repository' >&2; exit 1
fi
grep -Eiq 'signature|GPG|OpenPGP|public key' /tmp/untrusted
