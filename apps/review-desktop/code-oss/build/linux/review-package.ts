/*---------------------------------------------------------------------------------------------
 * Copyright (c) dev.fast. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFileSync } from 'node:child_process';
import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { referenceGeneratedDepsByArch, recommendedDeps } from './debian/dep-lists.ts';

export function reviewPackageVersion(version: string, revision = process.env.REVIEW_LINUX_PACKAGE_REVISION ?? '1'): string {
	if (!/^\d+\.\d+\.\d+$/.test(version) || !/^[1-9]\d*$/.test(revision)) {
		throw new Error('Linux repository packages require a stable X.Y.Z version and positive package revision');
	}
	return `${version}-${revision}`;
}

/** Reuse the Code OSS DEB task, but never execute its Microsoft install hooks. */
export async function prepareReviewDebPackage(codeRoot: string, arch: string): Promise<void> {
	if (arch !== 'amd64') { throw new Error('Review Linux packages currently support amd64 only'); }
	const appRoot = resolve(codeRoot, '..');
	const monorepoRoot = resolve(appRoot, '../..');
	const metadata = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8'));
	const packageVersion = reviewPackageVersion(metadata.version);
	const source = join(appRoot, 'VSCode-linux-x64');
	const product = JSON.parse(await readFile(join(source, 'resources/app/product.json'), 'utf8'));
	if (product.reviewVersion !== metadata.version || product.quality !== 'stable' || !/^[a-f0-9]{40}$/.test(product.commit ?? '')) {
		throw new Error('Linux payload must carry the stable Review version and source commit');
	}
	const destination = join(codeRoot, '.build/linux/deb/amd64/review-amd64');
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
	const installedSize = Number(execFileSync('du', ['-sk', join(destination, 'usr')], { encoding: 'utf8' }).split(/\s+/)[0]);
	const dependencies = [...referenceGeneratedDepsByArch.amd64, 'git', 'libsecret-1-0', 'libkrb5-3', 'libstdc++6 (>= 9)', 'libgcc-s1', 'libnotify4'];
	await write('DEBIAN/control', `Package: dev-fast-review
Version: ${packageVersion}
Architecture: amd64
Installed-Size: ${installedSize}
Section: devel
Priority: optional
Maintainer: dev.fast <support@dev.fast>
Homepage: https://dev.fast/
Depends: ${dependencies.join(', ')}
Recommends: ${recommendedDeps.join(', ')}
Description: Guided code reviews with your coding agents
 Review turns code changes into guided, interactive reviews.
`);
	// No repository enrollment, editor alternatives, or changes to user homes
	// happen in a package hook. Setup instructions handle repository trust once.
	const refresh = `#!/bin/sh
set -e
if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database -q; fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true; fi
`;
	await write('DEBIAN/postinst', refresh, 0o755);
	await write('DEBIAN/postrm', refresh, 0o755);
	await write('DEBIAN/prerm', '#!/bin/sh\nset -e\n', 0o755);
}
