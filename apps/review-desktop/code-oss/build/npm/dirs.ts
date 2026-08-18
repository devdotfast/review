/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync } from 'fs';

/**
 * Complete list of directories where npm should be executed to install node modules
 */
export const dirs = [
	'',
	'build',
	'extensions',
	'extensions/configuration-editing',
	'extensions/css-language-features',
	'extensions/css-language-features/server',
	'extensions/git-base',
	'extensions/html-language-features',
	'extensions/html-language-features/server',
	'extensions/json-language-features',
	'extensions/json-language-features/server',
	'extensions/markdown-language-features',
	'extensions/media-preview',
	'extensions/references-view',
	'extensions/typescript-language-features',
];

if (existsSync(`${import.meta.dirname}/../../.build/distro/npm`)) {
	dirs.push('.build/distro/npm');
	dirs.push('.build/distro/npm/remote');
	dirs.push('.build/distro/npm/remote/web');
}
