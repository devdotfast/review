# Ubuntu packages

Target: Ubuntu 24.04 LTS, x86-64. Stable and preview install separately as
`dev-fast-review` and `dev-fast-review-preview`. Each includes the desktop app,
agent CLI, extensions, tutorial, and runtime. System Node is not required.

## Build and check

Use the Linux builder configured in `review-linux-build.yml`. In addition to the
Fedora tools, install `dpkg-dev` and `apt-utils`. Build the application with
`pnpm desktop:build` and `pnpm desktop:package:linux`, then run
`pnpm --filter @dev.fast/review-desktop app:package:linux:distributions`.
The distribution step produces both RPM and DEB files in `dist/linux`.

The DEB derives dependencies from all bundled ELF binaries with
`dpkg-shlibdeps`. Build on Ubuntu 24.04 to avoid introducing dependencies that
are unavailable on that target. Missing libraries fail packaging. Private
bundled libraries do not create system package dependencies.

`build-linux-repository.py` builds both signed repositories in one sealed
publication. `linux/verify-repository.sh <publication> ubuntu` checks:

- Clean installation with APT, without system Node.
- CLI, desktop entries, URL handler, sandbox ownership, and AppArmor syntax.
- A non-root graphical launch with Chromium sandboxing enabled.
- Replacement of an older package, removal, and retained user data.
- Rejection of changed package bytes, signed metadata, indexes, and wrong keys.

The tests use a pinned Ubuntu container. Docker's outer seccomp filter is
relaxed for Chromium namespace creation; Chromium's sandbox remains enabled.
Containers share the host kernel, so this does not replace a GNOME/Wayland test
on an Ubuntu host with AppArmor enforcement. `review-linux-ci.yml` runs the
packaging checks for packaging PRs and supports manual builds. It checks both channels, then starts each installed
app on an Ubuntu 24.04 runner with AppArmor namespace restrictions enabled.

## Publication contract

The companion `Fix-Fast/dev` update Worker must support APT before this release
pipeline publishes. The publisher checks `/repos/apt/health` for
`{"schemaVersion":1,"format":"deb"}`. The existing `/repos/health` response stays
unchanged so the Worker can deploy before this packaging change.

One channel pointer promotes RPM and APT together after all immutable uploads.
The pointer retains `format: "rpm"` for compatibility and adds `deb: true`.
APT uses `/repos/apt/` for stable and `/repos/preview/apt/` for preview, with
matching suites `stable` and `preview`. `InRelease`, `Release`, `Release.gpg`,
and named package indexes redirect to the active immutable snapshot. APT uses
SHA-256 by-hash indexes, so a concurrent release cannot mix metadata generations.
Old packages, snapshots, and hashes remain available for in-flight downloads.

DEBs rely on APT's signed metadata and package checksums. They are not individually
OpenPGP-signed RPMs. The release also includes the downloadable `.deb` artifact.

After publication, install instructions are at `https://install.dev.fast/linux/ubuntu`
and `https://install.dev.fast/linux/preview/ubuntu`. Sources use repository-scoped
keys in `/etc/apt/keyrings`. Package installation does not add repositories,
change editor alternatives, or edit user profiles. The app-specific AppArmor
profile permits Chromium user namespaces without changing global policy.
