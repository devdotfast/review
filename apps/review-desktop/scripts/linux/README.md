# Linux packages and release repository

Review supports Fedora Workstation 43/44 on x86-64. The stable package is
`dev-fast-review-X.Y.Z-1.x86_64.rpm`, using the Review version and
`REVIEW_LINUX_PACKAGE_REVISION` (default `1`). Atomic desktops, other desktop
environments, other distributions, and ARM64 are outside this support target.

Preview builds are a separate package, `dev-fast-review-preview`, that installs
alongside stable Review the way Review Preview does on macOS: its own
`/usr/share/review-preview` tree, `review-preview` CLI, `review-preview-desktop`
launcher, desktop entry, and data folder. The RPM version is the tilde form of
the preview version, `X.Y.Z~preview.YYYYMMDD.N`, so every preview sorts below
the stable release it precedes. `code-oss/build/linux/review-package.ts` derives
all of this from the stamped `product.json`. Previews publish to their own
repository under `repos/preview/` with the same signing key; users add
`https://install.dev.fast/repos/dev-fast-review-preview.repo` and install from
`/linux/preview`.

## Build

On the Linux x86-64 builder with the tools in `review-linux-build.yml`:

```sh
pnpm install --frozen-lockfile
pnpm desktop:build
pnpm desktop:package:linux
pnpm --filter @dev.fast/review-desktop app:package:linux:distributions
```

The RPM tasks package the assembled application. They retain ELF dependency
discovery but exclude system Node requirements for scripts run by bundled
Electron. Both the desktop app and CLI live under `/usr/share/review`.
`/usr/bin/review-desktop` starts the app; `/usr/bin/review` runs the bundled CLI.
The package includes Review's desktop entry, icon, tutorial, and curated extensions.

Package hooks refresh desktop/icon caches. They do not enroll a repository,
install agent skills, change editor alternatives, or edit user profiles. The
sandbox helper is root-owned with mode `4755`. Do not disable SELinux or Chromium
sandboxing to make an installation work.

The same build also produces `dev-fast-review_X.Y.Z-1_amd64.deb`; see
[Debian package](#debian-package).

The package installation tests use pinned Fedora 43 and 44 containers.

## Debian package

The deb is a download, not a channel: it is attached to the GitHub release and
installed by hand. There is no apt repository, so it does not update itself and
does not carry a repository signature. Fedora remains the supported target, and
Ubuntu is not covered by the acceptance results below.

`prepareReviewDebPackage` in `code-oss/build/linux/review-package.ts` stages the
same `/usr` tree as the RPM and writes `DEBIAN/control` and the desktop/icon
cache hooks. `dpkg-deb --root-owner-group` then installs the payload as root
without a fakeroot session, keeping the setuid mode on the sandbox helper.

Unlike rpmbuild, dpkg-deb discovers no ELF dependencies. `Depends` is therefore
the generated Debian dependency list checked in for this Electron version
(`code-oss/build/linux/debian/dep-lists.ts`) plus what the RPM requires on top of
its own discovery. Updating Electron means refreshing that list.

`verify-deb-package.sh` installs the built deb through apt in pinned Ubuntu 24.04
and 26.04 containers, which is what proves those declared dependencies resolve on
a real archive. It also checks that no system Node is pulled in, that the sandbox
helper is `0:0:4755`, that the desktop entry and URL handler register, and that
removing the package retains user data.

## Signing and rollout

Deploy the `Fix-Fast/dev` update Worker with RPM support first. Its
`https://install.dev.fast/repos/health` endpoint must return
`{"schemaVersion":1,"format":"rpm"}`. The release workflow checks this before
tagging a production release. Publishers for the previous package formats will
reject the new health response; the Fedora publisher rejects the old response.

Configure these values in the protected `review-release` GitHub environment:

- `LINUX_REPOSITORY_SIGNING_KEY`: base64 of an exported OpenPGP secret signing key.
- `LINUX_REPOSITORY_SIGNING_PASSPHRASE`: its passphrase, if set.
- `LINUX_REPOSITORY_SIGNING_FINGERPRINT`: the uppercase, 40-character fingerprint.
- Existing R2 release credentials, endpoint, and bucket.

Keep an offline key backup and record its fingerprint independently. Installation
instructions show the fingerprint before users trust the key. Key rotation requires
clients to trust the new key before packages signed with it become active.

CI uses an ephemeral key in `review-linux-ci`. Production signing and publishing
use `review-release`. Signing credentials stay in a private temporary directory,
are removed after the job, and are never included in artifacts.

`build-linux-repository.py` signs the RPM, verifies it with an isolated RPM key
database, and generates checksum-named indexes with `createrepo_c`. It signs
`repomd.xml` and seals the publication with `sha256.json`. The workflow copies the
signed RPM back to the downloadable package artifacts before upload.

`publish-linux-repository.py` checks the sealed digests, uploads immutable files,
and then compare-and-swaps `repos/current.json`. A stale rerun cannot roll back a
newer release. Retries must reuse the sealed artifact. Re-signing or rebuilding the
same version can change its bytes; increment the package revision for new bytes.
Retain prior packages and metadata for clients with cached indexes or interrupted
downloads. The active pointer includes `format: "rpm"`.

DNF uses `/repos/rpm/x86_64/` for stable and `/repos/preview/rpm/x86_64/` for
preview; each channel has its own `current.json` pointer and the publisher
refuses a publication built for the other channel. Named `repomd.xml` and its `.asc` signature redirect
to an immutable snapshot. Index filenames contain their SHA-256 checksums; packages
have immutable versioned names. If requests straddle promotion, mismatched root
metadata/signatures must fail verification. Refresh and retry; never disable
`gpgcheck` or `repo_gpgcheck`. The repository sets `skip_if_unavailable=0` so
verification failures stop DNF instead of silently skipping Review. Setup and update instructions are at `/linux`.

## Validation gates

The automated workflow builds the RPM and the deb. It runs clean Fedora 43/44 installation,
bundled CLI startup without system Node, sandbox permission checks, a fixture
upgrade, retained-data uninstall, and rejection of altered RPMs, altered root/index
metadata, and untrusted keys. The fixture is a minimal older package; it does not prove migration from an older
released runtime.
Publication tests cover interrupted uploads, immutable collisions, stale reruns,
and concurrent pointer promotion. Worker tests cover routing, conditional requests,
range downloads, and refusal to expose removed distribution paths.

It also runs clean Ubuntu 24.04/26.04 installation of the deb. That gate covers
dependency resolution and file layout only; no Ubuntu native acceptance was run.

Before the first public Fedora release, record these additional results:

- GNOME/Wayland on the latest Fedora Workstation release (44) with SELinux enforcing and Chromium
  sandboxing enabled. Check native/custom controls, F10/Escape, drag regions,
  fullscreen, narrow widths, light/dark themes, and fractional scaling.
- Onboarding, tutorial, review publication, language tools, and `review app launch`
  on a clean machine without the source checkout or system Node.
- Real N to N+1 through the hosted DNF repository, including interrupted downloads
  and metadata/signature requests that straddle publication.

Xvfb or an emulated container does not establish GNOME, SELinux, or sandbox support.
No Linux package repository was published before the Fedora-only change, so there
is no client migration from the removed formats. Production signing credentials
and the native/hosted acceptance results remain prerequisites for publication.

## Release evidence

Recorded container, signing, hosted upgrade, and native Workstation results are in
[PR #226](https://github.com/devdotfast/review/pull/226).

The production signing certificate is
[0760DDC0AACD234D42A2C62626D3C32D039A5EC3](keys/0760DDC0AACD234D42A2C62626D3C32D039A5EC3.asc).
The certification key stays outside CI; CI uses a dedicated signing subkey.
Both keys expire in September 2028. Keep the encrypted recovery export offline
and its passphrase stored separately.

## Temporary Linux-only release

After this PR merges, run **Review Linux Release (temporary)** from `main`.
It builds that pinned main commit with the current published stable version,
uses production signing, and publishes the verified Linux repository and RPM.
It does not rebuild macOS, bump the version, or create or move a release tag.
The Linux source commit can be newer than the existing macOS release commit.

Start with package revision `1`. Increment it for a rebuild after publication;
immutable package files cannot be replaced. The workflow shares the normal
release lock and requires `review-release` approval. Remove this temporary
workflow after the first normal release includes Fedora packages.
