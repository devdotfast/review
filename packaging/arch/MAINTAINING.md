# Arch Linux package maintenance

`whiteboard-bin` tracks the stable GitHub release. Its `PKGBUILD` downloads the
Fedora RPM attached to that release, extracts only its filesystem payload, and
registers those files with pacman. The app bundle is moved to `/opt/whiteboard`;
the CLI, desktop entries, URL handler, metainfo, and icon keep their standard
system paths.

For each stable release, update `pkgver` and `sha256sums` in
`whiteboard-bin/PKGBUILD` to match the attached
`dev-fast-review-<version>-1.x86_64.rpm`, then regenerate `.SRCINFO` from that
directory with `makepkg --printsrcinfo > .SRCINFO`. Build and inspect the
package with `makepkg --syncdeps` and `namcap ./whiteboard-bin-*.pkg.tar.zst`,
then push the updated `PKGBUILD` and `.SRCINFO` to the `whiteboard-bin` AUR Git
repository.
