# Linux packages and release repositories

Review targets x86-64 Ubuntu 22.04/24.04 and Omarchy. Packages use the Review
version and `REVIEW_LINUX_PACKAGE_REVISION` (default `1`). Stable releases produce
`dev-fast-review_X.Y.Z-1_amd64.deb` and
`dev-fast-review-X.Y.Z-1-x86_64.pkg.tar.zst`. Preview builds remain CI archives.

## Build

On an x86-64 Linux builder with the dependencies in `review-linux-build.yml`:

```sh
pnpm install --frozen-lockfile
pnpm desktop:build
pnpm desktop:package:linux
pnpm --filter @dev.fast/review-desktop app:package:linux:distributions
bash apps/review-desktop/scripts/package-linux-arch.sh
```

The Arch builder uses a pinned container and packages the DEB's staged filesystem.
It does not rebuild the runtime. Both packages install `/usr/share/review`,
`/usr/bin/review-desktop`, and `/usr/bin/review`. The CLI runs with bundled
Electron, so system Node is unnecessary. Package hooks refresh desktop/icon caches;
they do not enroll repositories, install agent skills, change editor alternatives,
or edit user profiles. The sandbox helper is root-owned with mode `4755`.

## Signing and rollout

Deploy the `Fix-Fast/dev` update Worker with Linux repository support first. Its
`https://install.dev.fast/repos/health` endpoint must return `{"schemaVersion":1}`.
The release workflow checks this before tagging a production release.

Configure these values in the protected `review-release` GitHub environment:

- `LINUX_REPOSITORY_SIGNING_KEY`: base64 of an exported OpenPGP secret signing key.
- `LINUX_REPOSITORY_SIGNING_PASSPHRASE`: its passphrase, if set.
- `LINUX_REPOSITORY_SIGNING_FINGERPRINT`: environment variable containing its full
  uppercase, 40-character fingerprint.
- Existing R2 release credentials, endpoint, and bucket.

Keep an offline backup and record the fingerprint independently. Public installation
instructions show it before users trust the key. Key rotation requires distributing
and trusting the new key before packages signed with it become active; changing the
pointer alone does not rotate keys already installed on clients.

CI uses an ephemeral key and the unprotected `review-linux-ci` environment. Only
production signing and publishing jobs use `review-release`. Signing keys are kept
in a private temporary directory, removed after the job, and never mounted into the
Arch packaging container or uploaded as artifacts.

`build-linux-repository.py` creates a sealed publication directory with packages,
signatures, APT by-hash indexes, pacman databases, the public key, and `sha256.json`.
`publish-linux-repository.py` verifies every digest, uploads immutable files with
conditional writes, then compare-and-swaps `repos/current.json`. A stale rerun
cannot roll back a newer release. A retry must reuse the sealed publication artifact;
re-signing or rebuilding the same version can change bytes and is rejected. Increment
the package revision for changed package bytes. Keep prior package and snapshot
objects; clients can still have their signed metadata or an interrupted download.

APT selects immutable indexes by signed hash. Pacman verifies the database and its
detached signature; a client that straddles publication and obtains mismatched
versions must fail verification and retry synchronization. Never disable signature
checking to recover from this boundary. The package signatures also remain required.

## Validation gates

The workflow checks the packaged app and installed app, clean package installation
on Ubuntu 22.04/24.04 and Arch, bundled CLI startup without system Node, sandbox
permissions, an upgrade from an older package-metadata fixture, preserved user data,
uninstall, and rejection of tampered packages and an untrusted signing key.
Publication unit tests cover interrupted uploads, immutable collisions, stale reruns,
and concurrent pointer promotion. The fixture upgrade
uses the current runtime with older package metadata; it does not prove migration
from a previous released runtime.

Before the first public Linux release, record these additional results:

- Real version N to N+1 through the hosted APT and pacman repositories, including
  interrupted downloads, tampered package rejection, and pacman publication races.
- GNOME Wayland and X11 on both supported Ubuntu releases; current Omarchy/Hyprland
  in floating and tiled layouts. Inspect native and custom controls, keyboard menu,
  drag regions, fullscreen, narrow widths, themes, and fractional scaling.
- First-run onboarding, tutorial, review publication, and curated language tools on
  a clean machine. Confirm uninstall retains reviews, settings, and agent configuration.

Containers can validate packages and runtime dependencies. They do not establish
GNOME or Hyprland desktop support. Do not mark these desktop gates passed based on
an Xvfb launch. The hosted repositories remain unavailable until the Worker is
deployed and a signed stable publication is promoted.

## Implementation validation (2026-09-09)

The x86-64 app, DEB, and Arch packages were built on an Apple Silicon host using
Linux emulation. Clean Ubuntu 22.04, Ubuntu 24.04, and Arch containers passed
installation, bundled CLI startup, fixture upgrade, retained-data uninstall, and
tampered-package and untrusted-key rejection. The publisher passed seven
failure-boundary unit tests;
the update Worker passed 27 tests and its deployed repository health endpoint was
verified. The client typecheck and release workflow syntax checks passed.

Xvfb/Openbox checks passed for native controls with the dark theme at scale 1 and
custom controls with the light theme at scale 1.25. They covered F10/Escape, modal
blocking, menu actions, narrow-width placement, and custom maximize, restore,
minimize, and close. Screenshots caught and verified a correction to right-edge
control placement.

Local emulation required `REVIEW_TEST_DISABLE_SANDBOX=1` for the UI test and
pacman seccomp compatibility. The packaged sandbox ownership/mode was verified,
but sandbox-enabled GUI startup remains a native CI gate. The workflow does not
set this override. Production signing credentials are not configured, and no
Linux package publication was promoted. The native desktop and hosted upgrade
gates above remain open.
