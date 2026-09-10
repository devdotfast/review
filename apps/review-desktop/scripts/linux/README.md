# Fedora packages and release repository

Review supports Fedora Workstation 43/44 on x86-64. The package is
`dev-fast-review-X.Y.Z-1.x86_64.rpm`, using the Review version and
`REVIEW_LINUX_PACKAGE_REVISION` (default `1`). Preview builds remain CI archives.
Atomic desktops, other desktop environments, other distributions, and ARM64 are
outside this support target.

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

The existing Ubuntu CI runner is a build host, not a supported installation target.
The package installation tests use pinned Fedora 43 and 44 containers.

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

DNF uses `/repos/rpm/x86_64/`. Named `repomd.xml` and its `.asc` signature redirect
to an immutable snapshot. Index filenames contain their SHA-256 checksums; packages
have immutable versioned names. If requests straddle promotion, mismatched root
metadata/signatures must fail verification. Refresh and retry; never disable
`gpgcheck` or `repo_gpgcheck`. The repository sets `skip_if_unavailable=0` so
verification failures stop DNF instead of silently skipping Review. Setup and update instructions are at `/linux`.

## Validation gates

The automated workflow builds the RPM and runs clean Fedora 43/44 installation,
bundled CLI startup without system Node, sandbox permission checks, a fixture
upgrade, retained-data uninstall, and rejection of altered RPMs, altered root/index
metadata, and untrusted keys. The fixture uses current runtime bytes with older
package metadata; it does not prove migration from an older released runtime.
Publication tests cover interrupted uploads, immutable collisions, stale reruns,
and concurrent pointer promotion. Worker tests cover routing, conditional requests,
range downloads, and refusal to expose removed distribution paths.

Before the first public Fedora release, record these additional results:

- GNOME/Wayland on Fedora Workstation 43/44 with SELinux enforcing and Chromium
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

## Local validation evidence

On 2026-09-09, the signed RPM and sealed repository passed the complete container
matrix on the pinned Fedora 43 and 44 x86-64 images, under Docker emulation on
macOS. Both runs passed installation, bundled CLI startup without system Node,
root-owned sandbox permissions, the older-metadata fixture upgrade, retained-data
removal, and package, root metadata, index, and untrusted-key rejection. Repository
creation also passed with a passphrase-protected ephemeral signing key after
stopping its GPG agent. The publisher suite passed 8 tests and the Worker suite
passed 28 tests, including conditional and resumed downloads.

These results cover package management. They do not satisfy the native Workstation
or hosted release upgrade gates above. No test signing key is a production key.
