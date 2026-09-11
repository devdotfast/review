/*---------------------------------------------------------------------------------------------
 * Copyright (c) dev.fast. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'node:child_process';
import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { additionalDeps, recommendedDeps } from './rpm/dep-lists.ts';

export function reviewPackageVersion(version: string, revision = process.env.REVIEW_LINUX_PACKAGE_REVISION ?? '1'): string {
	if (!/^\d+\.\d+\.\d+$/.test(version) || !/^[1-9]\d*$/.test(revision)) {
		throw new Error('Linux repository packages require a stable X.Y.Z version and positive package revision');
	}
	return `${version}-${revision}`;
}

/** Stage the Review runtime for the existing Code OSS RPM build task. */
export async function prepareReviewRpmPackage(codeRoot: string, arch: string): Promise<void> {
	if (arch !== 'x86_64') { throw new Error('Review Linux packages currently support x86_64 only'); }
	const appRoot = resolve(codeRoot, '..');
	const monorepoRoot = resolve(appRoot, '../..');
	const metadata = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8'));
	const packageVersion = reviewPackageVersion(metadata.version);
	const source = join(appRoot, 'VSCode-linux-x64');
	const product = JSON.parse(await readFile(join(source, 'resources/app/product.json'), 'utf8'));
	if (product.reviewVersion !== metadata.version || product.quality !== 'stable' || !/^[a-f0-9]{40}$/.test(product.commit ?? '')) {
		throw new Error('Linux payload must carry the stable Review version and source commit');
	}
	const rpmRoot = join(codeRoot, '.build/linux/rpm/x86_64/rpmbuild');
	const destination = join(rpmRoot, 'BUILD');
	await rm(destination, { recursive: true, force: true });
	await mkdir(destination, { recursive: true });
	await cp(source, join(destination, 'usr/share/review'), { recursive: true, verbatimSymlinks: true });
	// The Code OSS bin/review command opens editors. The public command is the
	// Review agent CLI; keep the app executable behind a distinct desktop launcher.
	await rm(join(destination, 'usr/share/review/bin'), { recursive: true, force: true });
	const write = async (name: string, value: string, mode = 0o644) => {
		const target = join(destination, name);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, value, { mode });
	};
	await write('usr/bin/review', `#!/bin/sh
export ELECTRON_RUN_AS_NODE=1
exec /usr/share/review/review /usr/share/review/resources/app/review-runtime/dist/cli.js "$@"
`, 0o755);
	await write('usr/bin/review-desktop', `#!/bin/sh
unset ELECTRON_RUN_AS_NODE VSCODE_DEV VSCODE_CLI
exec /usr/share/review/review "$@"
`, 0o755);
	await write('usr/share/applications/dev-fast-review.desktop', `[Desktop Entry]
Name=Review
Comment=Guided code reviews with your coding agents
Exec=/usr/bin/review-desktop
Icon=review
Type=Application
Terminal=false
StartupNotify=true
StartupWMClass=Review
Categories=Development;
Keywords=review;code;agents;
`);
	await write('usr/share/metainfo/dev-fast-review.metainfo.xml', `<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>dev.fast.review</id><name>Review</name>
  <summary>Guided code reviews with your coding agents</summary>
  <metadata_license>CC0-1.0</metadata_license><project_license>MIT</project_license>
  <launchable type="desktop-id">dev-fast-review.desktop</launchable>
  <url type="homepage">https://dev.fast/</url>
  <description><p>Review turns code changes into guided, interactive reviews with code, traces, and agent discussions.</p></description>
</component>
`);
	const icon = join(destination, 'usr/share/icons/hicolor/512x512/apps/review.png');
	await mkdir(dirname(icon), { recursive: true });
	await cp(join(monorepoRoot, 'packages/progressive-review/app/icons/review-square-512.png'), icon);
	// Electron's packaged sandbox helper must be root-owned with setuid in the
	// system package. Package creation sets ownership; no runtime chmod is needed.
	await chmod(join(destination, 'usr/share/review/chrome-sandbox'), 0o4755);
	const revision = packageVersion.slice(metadata.version.length + 1);
	const dependencies = [...additionalDeps.filter(dep => !dep.startsWith('rpmlib(')), 'git', 'libsecret-1.so.0()(64bit)', 'libkrb5.so.3()(64bit)', 'libnotify.so.4()(64bit)', '/bin/sh'];
	await mkdir(join(rpmRoot, 'SPECS'), { recursive: true });
	await writeFile(join(rpmRoot, 'SPECS/review.spec'), String.raw`Name: dev-fast-review
Version: ${metadata.version}
Release: ${revision}
Summary: Guided code reviews with your coding agents
License: MIT
URL: https://dev.fast/
Vendor: dev.fast
Packager: dev.fast <support@dev.fast>
BuildArch: x86_64
Requires: ${dependencies.join(', ')}
Recommends: ${recommendedDeps.join(', ')}

# Keep ELF dependency discovery, but do not require system Node for scripts
# that are executed by bundled Electron. Do not export bundled private libraries.
%global __script_requires %{nil}
%global __provides_exclude_from ^%{_datadir}/review/.*$
%global __requires_exclude ^lib(EGL|GLESv2|vulkan|vk_swiftshader|ffmpeg)\.so.*$
%global __brp_strip %{nil}
%global __brp_strip_comment_note %{nil}
%global debug_package %{nil}
%global _build_id_links none

%description
Review turns code changes into guided, interactive reviews with code, traces,
and agent discussions. Includes the Review CLI and its runtime.

%install
mkdir -p %{buildroot}
cp -a %{_builddir}/usr %{buildroot}/

%post
if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database -q || :; fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || :; fi

%postun
if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database -q || :; fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || :; fi

%files
%defattr(-,root,root)
/usr/bin/review
/usr/bin/review-desktop
/usr/share/review/
%attr(4755,root,root) /usr/share/review/chrome-sandbox
/usr/share/applications/dev-fast-review.desktop
/usr/share/metainfo/dev-fast-review.metainfo.xml
/usr/share/icons/hicolor/512x512/apps/review.png
`);
}

/** Keep rpmbuild state under the package output directory without changing HOME. */
export async function buildReviewRpmPackage(codeRoot: string, arch: string): Promise<void> {
	if (arch !== 'x86_64') { throw new Error('Review Fedora packages support x86_64 only'); }
	const rpmRoot = join(codeRoot, '.build/linux/rpm/x86_64/rpmbuild');
	const metadata = JSON.parse(await readFile(join(codeRoot, '../package.json'), 'utf8'));
	const version = reviewPackageVersion(metadata.version);
	execFileSync('rpmbuild', ['--define', `_topdir ${rpmRoot}`, '-bb', join(rpmRoot, 'SPECS/review.spec'), '--target', arch], { stdio: 'inherit' });
	const name = `dev-fast-review-${version}.x86_64.rpm`;
	await cp(join(rpmRoot, 'RPMS/x86_64', name), join(rpmRoot, '..', name));
}
