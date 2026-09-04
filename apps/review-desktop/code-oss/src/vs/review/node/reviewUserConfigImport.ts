/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse, type ParseError } from '../../base/common/json.js';
// Setting keys come from the import-free defaults module, never from
// `reviewConfiguration.js`: this runs in the main process before bootstrapESM(),
// so reaching the configuration registry behind it would throw
// `!!! NLS MISSING: <n> !!!` in a packaged build. See reviewConfigurationDefaults.ts.
import { curatedExtensionConfigurationDefaults, reviewConfigurationDefaults, type ReviewKeymap } from '../common/reviewConfigurationDefaults.js';

export const REVIEW_USER_CONFIG_IMPORT_VERSION = 1;

export type { ReviewKeymap };
export type ReviewUserConfigImportMode = 'startup' | 'preview' | 'apply';

export interface ReviewUserConfigImportOptions {
	readonly userDataPath: string;
	readonly mode?: ReviewUserConfigImportMode;
	readonly homeDir?: string;
	readonly platform?: NodeJS.Platform;
	readonly env?: NodeJS.ProcessEnv;
	readonly now?: () => Date;
	readonly log?: (message: string) => void;
}

export interface ReviewUserConfigImportResult {
	readonly status: 'disabled' | 'not-found' | 'skipped' | 'ready' | 'imported';
	readonly source?: string;
	readonly keymap: ReviewKeymap;
	readonly files: readonly string[];
	readonly wouldOverwrite: readonly string[];
	readonly reason?: 'stamp-exists' | 'keybindings-exists' | 'settings-exists';
	readonly defaultProfileOnly?: boolean;
}

interface SourceCandidate {
	readonly userDir: string;
	readonly extensionsDir?: string;
	readonly modifiedAt: number;
}

interface PreparedImport {
	readonly source: SourceCandidate;
	readonly keymap: ReviewKeymap;
	readonly keybindings?: string;
	readonly settings?: Record<string, unknown>;
	readonly defaultProfileOnly: boolean;
}

const BLOCKED_SETTING_PREFIXES = [
	'telemetry.',
	'update.',
	'extensions.',
	'chat.',
	'github.',
	'workbench.enableExperiments',
	'security.workspace.trust.',
	'remote.',
] as const;

const BLOCKED_SETTING_KEYS = new Set<string>([
	...Object.keys(reviewConfigurationDefaults),
	// An imported setting beats a default, so a VS Code user who runs Pylance
	// would carry `python.languageServer: "Pylance"` in and re-arm the install
	// prompt for an extension Review cannot ship. The same holds for every other
	// prompt these defaults close.
	...Object.keys(curatedExtensionConfigurationDefaults),
]);

const SOURCE_INSTALLS = [
	{ name: 'Code', extensionsHome: '.vscode' },
	{ name: 'Code - Insiders', extensionsHome: '.vscode-insiders' },
	{ name: 'VSCodium', extensionsHome: '.vscode-oss' },
	{ name: 'Cursor', extensionsHome: '.cursor' },
] as const;

const KEYMAP_EXTENSIONS: Readonly<Record<Exclude<ReviewKeymap, 'none'>, string>> = {
	vim: 'vscodevim.vim',
	emacs: 'tuttieee.emacs-mcx',
};

function existingMtime(target: string): number {
	try {
		return statSync(target).mtimeMs;
	} catch {
		return 0;
	}
}

function sourceModifiedAt(userDir: string): number {
	return Math.max(
		existingMtime(userDir),
		existingMtime(path.join(userDir, 'keybindings.json')),
		existingMtime(path.join(userDir, 'settings.json')),
	);
}

function isUsableSource(userDir: string): boolean {
	return existsSync(path.join(userDir, 'keybindings.json')) || existsSync(path.join(userDir, 'settings.json'));
}

function extensionDirectoryForOverride(userDir: string, homeDir: string): string | undefined {
	const installName = path.basename(path.dirname(userDir)).toLowerCase();
	for (const install of SOURCE_INSTALLS) {
		if (installName === install.name.toLowerCase()) {
			return path.join(homeDir, install.extensionsHome, 'extensions');
		}
	}

	const fixtureStyleExtensions = path.join(path.dirname(userDir), 'extensions');
	return existsSync(fixtureStyleExtensions) ? fixtureStyleExtensions : undefined;
}

function discoverSource(options: ReviewUserConfigImportOptions): SourceCandidate | 'disabled' | undefined {
	const env = options.env ?? process.env;
	const homeDir = options.homeDir ?? os.homedir();
	const override = env['DEV_REVIEW_IMPORT_FROM'];

	if (override?.toLowerCase() === 'none') {
		return 'disabled';
	}

	if (override) {
		const expanded = path.resolve(override);
		const userDir = path.basename(expanded) === 'User' ? expanded : path.join(expanded, 'User');
		if (!isUsableSource(userDir)) {
			return undefined;
		}
		return {
			userDir,
			extensionsDir: extensionDirectoryForOverride(userDir, homeDir),
			modifiedAt: sourceModifiedAt(userDir),
		};
	}

	const configRoot = options.platform === 'darwin' || (options.platform === undefined && process.platform === 'darwin')
		? path.join(homeDir, 'Library', 'Application Support')
		: path.resolve(env['XDG_CONFIG_HOME'] || path.join(homeDir, '.config'));

	const candidates = SOURCE_INSTALLS
		.map(install => {
			const userDir = path.join(configRoot, install.name, 'User');
			return {
				userDir,
				extensionsDir: path.join(homeDir, install.extensionsHome, 'extensions'),
				modifiedAt: sourceModifiedAt(userDir),
			};
		})
		.filter(candidate => isUsableSource(candidate.userDir))
		.sort((left, right) => right.modifiedAt - left.modifiedAt);

	return candidates[0];
}

function extensionIdsFromMetadata(extensionsDir: string): Set<string> | undefined {
	const metadataPath = path.join(extensionsDir, 'extensions.json');
	if (!existsSync(metadataPath)) {
		return undefined;
	}

	const errors: ParseError[] = [];
	const value = parse(readFileSync(metadataPath, 'utf8'), errors);
	if (errors.length > 0 || !Array.isArray(value)) {
		return new Set();
	}

	const ids = new Set<string>();
	for (const entry of value) {
		if (!entry || typeof entry !== 'object') {
			continue;
		}
		const identifier = (entry as { identifier?: unknown }).identifier;
		const id = identifier && typeof identifier === 'object'
			? (identifier as { id?: unknown }).id
			: (entry as { id?: unknown }).id;
		if (typeof id === 'string') {
			ids.add(id.toLowerCase());
		}
	}
	return ids;
}

function detectKeymap(extensionsDir: string | undefined): ReviewKeymap {
	if (!extensionsDir || !existsSync(extensionsDir)) {
		return 'none';
	}

	const metadataIds = extensionIdsFromMetadata(extensionsDir);
	const candidates: { keymap: Exclude<ReviewKeymap, 'none'>; modifiedAt: number }[] = [];
	for (const entry of readdirSync(extensionsDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) {
			continue;
		}
		const normalizedName = entry.name.toLowerCase();
		for (const [keymap, extensionId] of Object.entries(KEYMAP_EXTENSIONS) as [Exclude<ReviewKeymap, 'none'>, string][]) {
			if (!normalizedName.startsWith(`${extensionId}-`)) {
				continue;
			}
			if (metadataIds && !metadataIds.has(extensionId)) {
				continue;
			}
			candidates.push({
				keymap,
				modifiedAt: existingMtime(path.join(extensionsDir, entry.name)),
			});
		}
	}

	candidates.sort((left, right) => right.modifiedAt - left.modifiedAt);
	return candidates[0]?.keymap ?? 'none';
}

function shouldImportSetting(key: string): boolean {
	if (BLOCKED_SETTING_KEYS.has(key)) {
		return false;
	}
	return !BLOCKED_SETTING_PREFIXES.some(prefix => key.startsWith(prefix));
}

function filterReviewUserSettings(settings: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(settings).filter(([key]) => shouldImportSetting(key)));
}

function readSettings(settingsPath: string): Record<string, unknown> | undefined {
	if (!existsSync(settingsPath)) {
		return undefined;
	}

	const errors: ParseError[] = [];
	const value = parse(readFileSync(settingsPath, 'utf8'), errors);
	if (errors.length > 0 || !value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`Cannot import invalid VS Code settings from ${settingsPath}`);
	}
	return filterReviewUserSettings(value as Record<string, unknown>);
}

function prepareImport(source: SourceCandidate, log: (message: string) => void): PreparedImport {
	const profilesDir = path.join(source.userDir, 'profiles');
	const defaultProfileOnly = existsSync(profilesDir);
	if (defaultProfileOnly) {
		log(`Review user-config import found profiles under ${profilesDir}; importing the default profile only.`);
	}

	const keymap = detectKeymap(source.extensionsDir);
	const keybindingsPath = path.join(source.userDir, 'keybindings.json');
	const settings = readSettings(path.join(source.userDir, 'settings.json'));
	if (settings && keymap !== 'none') {
		settings['review.keymap'] = keymap;
	}

	return {
		source,
		keymap,
		keybindings: existsSync(keybindingsPath) ? keybindingsPath : undefined,
		settings: settings ?? (keymap !== 'none' ? { 'review.keymap': keymap } : undefined),
		defaultProfileOnly,
	};
}

function targetFiles(prepared: PreparedImport, userDir: string): string[] {
	const files: string[] = [];
	if (prepared.keybindings) {
		files.push(path.join(userDir, 'keybindings.json'));
	}
	if (prepared.settings) {
		files.push(path.join(userDir, 'settings.json'));
	}
	files.push(path.join(userDir, '.review-import.json'));
	return files;
}

function writeImport(prepared: PreparedImport, userDir: string, now: () => Date): string[] {
	mkdirSync(userDir, { recursive: true });
	const files = targetFiles(prepared, userDir);
	if (prepared.keybindings) {
		copyFileSync(prepared.keybindings, path.join(userDir, 'keybindings.json'));
	}
	if (prepared.settings) {
		writeFileSync(path.join(userDir, 'settings.json'), `${JSON.stringify(prepared.settings, null, '\t')}\n`, 'utf8');
	}
	writeFileSync(path.join(userDir, '.review-import.json'), `${JSON.stringify({
		version: REVIEW_USER_CONFIG_IMPORT_VERSION,
		source: prepared.source.userDir,
		importedAt: now().toISOString(),
		keymap: prepared.keymap,
	}, null, '\t')}\n`, 'utf8');
	return files;
}

export function importReviewUserConfig(options: ReviewUserConfigImportOptions): ReviewUserConfigImportResult {
	const mode = options.mode ?? 'startup';
	const targetUserDir = path.join(options.userDataPath, 'User');
	const stampPath = path.join(targetUserDir, '.review-import.json');
	const keybindingsPath = path.join(targetUserDir, 'keybindings.json');
	const settingsPath = path.join(targetUserDir, 'settings.json');
	const log = options.log ?? (() => undefined);

	if (mode === 'startup' && existsSync(stampPath)) {
		return { status: 'skipped', keymap: 'none', files: [], wouldOverwrite: [], reason: 'stamp-exists' };
	}
	if (mode === 'startup' && existsSync(keybindingsPath)) {
		return { status: 'skipped', keymap: 'none', files: [], wouldOverwrite: [], reason: 'keybindings-exists' };
	}
	if (mode === 'startup' && existsSync(settingsPath)) {
		return { status: 'skipped', keymap: 'none', files: [], wouldOverwrite: [], reason: 'settings-exists' };
	}

	const source = discoverSource(options);
	if (source === 'disabled') {
		return { status: 'disabled', keymap: 'none', files: [], wouldOverwrite: [] };
	}
	if (!source) {
		return { status: 'not-found', keymap: 'none', files: [], wouldOverwrite: [] };
	}

	const prepared = prepareImport(source, log);
	const files = targetFiles(prepared, targetUserDir);
	const wouldOverwrite = files.filter(file => existsSync(file));
	if (mode === 'preview') {
		return {
			status: 'ready',
			source: source.userDir,
			keymap: prepared.keymap,
			files,
			wouldOverwrite,
			defaultProfileOnly: prepared.defaultProfileOnly,
		};
	}

	const written = writeImport(prepared, targetUserDir, options.now ?? (() => new Date()));
	log(`Review imported VS Code settings and keybindings from ${source.userDir}.`);
	return {
		status: 'imported',
		source: source.userDir,
		keymap: prepared.keymap,
		files: written,
		wouldOverwrite,
		defaultProfileOnly: prepared.defaultProfileOnly,
	};
}
