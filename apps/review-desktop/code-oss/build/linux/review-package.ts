/*---------------------------------------------------------------------------------------------
 * Copyright (c) dev.fast. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'node:child_process';
import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { additionalDeps, recommendedDeps } from './rpm/dep-lists.ts';

export interface ReviewPackageProduct {
	quality: string;
	applicationName: string;
	nameShort: string;
	darwinBundleIdentifier: string;
}

export interface ReviewPackage {
	/** RPM package name: dev-fast-review or dev-fast-review-preview. */
	name: string;
	/** Installed application directory and command name: review or review-preview. */
	app: string;
	appName: string;
	appId: string;
	/** RPM version; previews use the tilde form so they sort below their stable release. */
	rpmVersion: string;
	revision: string;
	file: string;
}

/** Derive the Fedora package identity from the stamped release channel. */
export function reviewPackage(product: ReviewPackageProduct, version: string, revision = process.env.REVIEW_LINUX_PACKAGE_REVISION ?? '1'): ReviewPackage {
	const match = /^(\d+\.\d+\.\d+)(?:-(preview\.\d{8}\.\d+))?$/.exec(version);
	if (!match || !/^[1-9]\d*$/.test(revision)) {
		throw new Error('Linux repository packages require an X.Y.Z or X.Y.Z-preview.YYYYMMDD.N version and positive package revision');
	}
	const [, release, prerelease] = match;
	if (product.quality !== (prerelease ? 'preview' : 'stable')) {
		throw new Error(`Linux payload quality ${JSON.stringify(product.quality)} does not match version ${version}`);
	}
	if (!/^[a-z][a-z0-9-]*$/.test(product.applicationName)) {
		throw new Error('Linux packages need a lowercase applicationName');
	}
	const rpmVersion = prerelease ? `${release}~${prerelease}` : release;
	const name = `dev-fast-${product.applicationName}`;
	return {
		name,
		app: product.applicationName,
		appName: product.nameShort,
		appId: product.darwinBundleIdentifier,
		rpmVersion,
		revision,
		file: `${name}-${rpmVersion}-${revision}.x86_64.rpm`,
	};
}

async function loadReviewPackage(appRoot: string) {
	const metadata = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8'));
	const source = join(appRoot, 'VSCode-linux-x64');
	const product = JSON.parse(await readFile(join(source, 'resources/app/product.json'), 'utf8'));
	if (product.reviewVersion !== metadata.version || !/^[a-f0-9]{40}$/.test(product.commit ?? '')) {
		throw new Error('Linux payload must carry the stamped Review version and source commit');
	}
	return { pkg: reviewPackage(product, metadata.version), source, urlProtocol: product.urlProtocol };
}

/** Stage the Review runtime for the existing Code OSS RPM build task. */
export async function prepareReviewRpmPackage(codeRoot: string, arch: string): Promise<void> {
	if (arch !== 'x86_64') { throw new Error('Review Linux packages currently support x86_64 only'); }
	const appRoot = resolve(codeRoot, '..');
	const monorepoRoot = resolve(appRoot, '../..');
	const { pkg, source, urlProtocol } = await loadReviewPackage(appRoot);
	const { name, app, appName, appId } = pkg;
	const share = `/usr/share/${app}`;
	const rpmRoot = join(codeRoot, '.build/linux/rpm/x86_64/rpmbuild');
	const destination = join(rpmRoot, 'BUILD');
	await rm(destination, { recursive: true, force: true });
	await mkdir(destination, { recursive: true });
	await cp(source, join(destination, share), { recursive: true, verbatimSymlinks: true });
	// The Code OSS bin/<app> command opens editors. The public command is the
	// Review agent CLI; keep the app executable behind a distinct desktop launcher.
	await rm(join(destination, share, 'bin'), { recursive: true, force: true });
	const write = async (name: string, value: string, mode = 0o644) => {
		const target = join(destination, name);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, value, { mode });
	};
	// The CLI launches this channel's desktop app, not the stable one.
	await write(`usr/bin/${app}`, `#!/bin/sh
export ELECTRON_RUN_AS_NODE=1
export DEV_FAST_WHITEBOARD_DESKTOP_COMMAND=/usr/bin/${app}-desktop
exec ${share}/${app} ${share}/resources/app/review-runtime/dist/cli.js "$@"
`, 0o755);
	await write(`usr/bin/${app}-desktop`, `#!/bin/sh
unset ELECTRON_RUN_AS_NODE VSCODE_DEV VSCODE_CLI
exec ${share}/${app} "$@"
`, 0o755);
	await write(`usr/share/applications/${name}.desktop`, `[Desktop Entry]
Name=${appName}
Comment=Guided code reviews with your coding agents
Exec=/usr/bin/${app}-desktop
Icon=${app}
Type=Application
Terminal=false
StartupNotify=true
StartupWMClass=${appName}
Categories=Development;
Keywords=review;code;agents;
`);
	await write(`usr/share/applications/${name}-url-handler.desktop`, `[Desktop Entry]
Name=${appName} - URL Handler
Exec=/usr/bin/${app}-desktop --open-url -- %U
Icon=${app}
Type=Application
Terminal=false
NoDisplay=true
MimeType=x-scheme-handler/${urlProtocol};
`);
	await write(`usr/share/metainfo/${name}.metainfo.xml`, `<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>${appId}</id><name>${appName}</name>
  <summary>Guided code reviews with your coding agents</summary>
  <metadata_license>CC0-1.0</metadata_license><project_license>MIT</project_license>
  <launchable type="desktop-id">${name}.desktop</launchable>
  <url type="homepage">https://dev.fast/</url>
  <description><p>Review turns code changes into guided, interactive reviews with code, traces, and agent discussions.</p></description>
</component>
`);
	const icon = join(destination, `usr/share/icons/hicolor/512x512/apps/${app}.png`);
	await mkdir(dirname(icon), { recursive: true });
	await cp(join(monorepoRoot, `packages/review/app/icons/${app}-square-512.png`), icon);
	// Electron's packaged sandbox helper must be root-owned with setuid in the
	// system package. Package creation sets ownership; no runtime chmod is needed.
	await chmod(join(destination, share, 'chrome-sandbox'), 0o4755);
	const dependencies = [...additionalDeps.filter(dep => !dep.startsWith('rpmlib(')), 'git', 'libsecret-1.so.0()(64bit)', 'libkrb5.so.3()(64bit)', 'libnotify.so.4()(64bit)', '/bin/sh'];
	await mkdir(join(rpmRoot, 'SPECS'), { recursive: true });
	await writeFile(join(rpmRoot, 'SPECS/review.spec'), String.raw`Name: ${name}
Version: ${pkg.rpmVersion}
Release: ${pkg.revision}
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
%global __provides_exclude_from ^%{_datadir}/${app}/.*$
%global __requires_exclude ^lib(EGL|GLESv2|vulkan|vk_swiftshader|ffmpeg|vips-cpp)\.so.*$
%global __brp_strip %{nil}
%global __brp_strip_comment_note %{nil}
%global debug_package %{nil}
%global _build_id_links none

%description
${appName} turns code changes into guided, interactive reviews with code, traces,
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
/usr/bin/${app}
/usr/bin/${app}-desktop
${share}/
%attr(4755,root,root) ${share}/chrome-sandbox
/usr/share/applications/${name}.desktop
/usr/share/applications/${name}-url-handler.desktop
/usr/share/metainfo/${name}.metainfo.xml
/usr/share/icons/hicolor/512x512/apps/${app}.png
`);
}

/** Keep rpmbuild state under the package output directory without changing HOME. */
export async function buildReviewRpmPackage(codeRoot: string, arch: string): Promise<void> {
	if (arch !== 'x86_64') { throw new Error('Review Fedora packages support x86_64 only'); }
	const rpmRoot = join(codeRoot, '.build/linux/rpm/x86_64/rpmbuild');
	const { pkg } = await loadReviewPackage(resolve(codeRoot, '..'));
	execFileSync('rpmbuild', ['--define', `_topdir ${rpmRoot}`, '-bb', join(rpmRoot, 'SPECS/review.spec'), '--target', arch], { stdio: 'inherit' });
	await cp(join(rpmRoot, 'RPMS/x86_64', pkg.file), join(rpmRoot, '..', pkg.file));
}
