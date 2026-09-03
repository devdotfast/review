/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { importReviewUserConfig } from './reviewUserConfigImport.js';

describe('ReviewUserConfigImport', () => {
	const fixtures: string[] = [];

	afterEach(() => {
		for (const fixture of fixtures.splice(0)) {
			rmSync(fixture, { recursive: true, force: true });
		}
	});

	function createFixture(): { root: string; sourceRoot: string; sourceUser: string; target: string } {
		const root = mkdtempSync(path.join(os.tmpdir(), 'review-user-config-'));
		fixtures.push(root);
		const sourceRoot = path.join(root, 'source');
		const sourceUser = path.join(sourceRoot, 'User');
		const target = path.join(root, 'target');
		mkdirSync(sourceUser, { recursive: true });
		return { root, sourceRoot, sourceUser, target };
	}

	test('imports JSONC keybindings verbatim and filters hardened settings', () => {
		const fixture = createFixture();
		const keybindings = '[\n\t// Keep this chord and its comment.\n\t{ "key": "ctrl+k ctrl+r", "command": "review.refresh" },\n]\n';
		writeFileSync(path.join(fixture.sourceUser, 'keybindings.json'), keybindings);
		writeFileSync(path.join(fixture.sourceUser, 'settings.json'), `{
			// User-facing editor and keymap settings survive.
			"editor.fontSize": 15,
			"vim.useSystemClipboard": true,
			"telemetry.telemetryLevel": "all",
			"extensions.autoUpdate": true,
			"workbench.statusBar.visible": true,
			// Would re-arm the install prompt for an extension Review cannot ship.
			"python.languageServer": "Pylance",
		}`);

		const extensionsDir = path.join(fixture.sourceRoot, 'extensions');
		mkdirSync(path.join(extensionsDir, 'vscodevim.vim-1.32.4'), { recursive: true });
		writeFileSync(path.join(extensionsDir, 'extensions.json'), JSON.stringify([
			{ identifier: { id: 'vscodevim.vim' } },
		]));

		const result = importReviewUserConfig({
			userDataPath: fixture.target,
			env: { DEV_REVIEW_IMPORT_FROM: fixture.sourceRoot },
			homeDir: fixture.root,
			now: () => new Date('2026-07-29T12:00:00.000Z'),
		});

		assert.strictEqual(result.status, 'imported');
		assert.strictEqual(result.keymap, 'vim');
		assert.strictEqual(
			readFileSync(path.join(fixture.target, 'User', 'keybindings.json'), 'utf8'),
			keybindings,
		);
		const settings = JSON.parse(readFileSync(path.join(fixture.target, 'User', 'settings.json'), 'utf8'));
		assert.deepStrictEqual(settings, {
			'editor.fontSize': 15,
			'vim.useSystemClipboard': true,
			'review.keymap': 'vim',
		});
		assert.deepStrictEqual(
			JSON.parse(readFileSync(path.join(fixture.target, 'User', '.review-import.json'), 'utf8')),
			{
				version: 1,
				source: fixture.sourceUser,
				importedAt: '2026-07-29T12:00:00.000Z',
				keymap: 'vim',
			},
		);
	});

	test('does not import twice after writing the stamp', () => {
		const fixture = createFixture();
		writeFileSync(path.join(fixture.sourceUser, 'keybindings.json'), '[]\n');
		const options = {
			userDataPath: fixture.target,
			env: { DEV_REVIEW_IMPORT_FROM: fixture.sourceRoot },
			homeDir: fixture.root,
		};
		assert.strictEqual(importReviewUserConfig(options).status, 'imported');
		writeFileSync(path.join(fixture.sourceUser, 'keybindings.json'), '[{ "key": "x", "command": "x" }]\n');

		const second = importReviewUserConfig(options);
		assert.strictEqual(second.status, 'skipped');
		assert.strictEqual(second.reason, 'stamp-exists');
		assert.strictEqual(readFileSync(path.join(fixture.target, 'User', 'keybindings.json'), 'utf8'), '[]\n');
	});

	test('never clobbers a pre-existing keybindings file on startup', () => {
		const fixture = createFixture();
		writeFileSync(path.join(fixture.sourceUser, 'keybindings.json'), '[{ "key": "source" }]\n');
		mkdirSync(path.join(fixture.target, 'User'), { recursive: true });
		writeFileSync(path.join(fixture.target, 'User', 'keybindings.json'), '[{ "key": "mine" }]\n');

		const result = importReviewUserConfig({
			userDataPath: fixture.target,
			env: { DEV_REVIEW_IMPORT_FROM: fixture.sourceRoot },
			homeDir: fixture.root,
		});

		assert.strictEqual(result.status, 'skipped');
		assert.strictEqual(result.reason, 'keybindings-exists');
		assert.strictEqual(
			readFileSync(path.join(fixture.target, 'User', 'keybindings.json'), 'utf8'),
			'[{ "key": "mine" }]\n',
		);
	});

	test('never clobbers a pre-existing settings file on startup', () => {
		const fixture = createFixture();
		writeFileSync(path.join(fixture.sourceUser, 'settings.json'), '{ "editor.fontSize": 22 }\n');
		mkdirSync(path.join(fixture.target, 'User'), { recursive: true });
		const targetSettings = path.join(fixture.target, 'User', 'settings.json');
		writeFileSync(targetSettings, '{ "editor.fontSize": 11, "workbench.colorTheme": "MyTheme" }\n');

		const result = importReviewUserConfig({
			userDataPath: fixture.target,
			env: { DEV_REVIEW_IMPORT_FROM: fixture.sourceRoot },
			homeDir: fixture.root,
		});

		assert.strictEqual(result.status, 'skipped');
		assert.strictEqual(result.reason, 'settings-exists');
		assert.strictEqual(
			readFileSync(targetSettings, 'utf8'),
			'{ "editor.fontSize": 11, "workbench.colorTheme": "MyTheme" }\n',
		);
	});

	test('maps a Code Insiders override to its exact extensions directory', () => {
		const fixture = createFixture();
		const insidersUser = path.join(fixture.root, 'Code - Insiders', 'User');
		mkdirSync(insidersUser, { recursive: true });
		writeFileSync(path.join(insidersUser, 'settings.json'), '{ "editor.fontSize": 15 }\n');
		mkdirSync(path.join(fixture.root, '.vscode-insiders', 'extensions', 'vscodevim.vim-1.32.4'), { recursive: true });
		mkdirSync(path.join(fixture.root, '.vscode', 'extensions', 'tuttieee.emacs-mcx-0.40.0'), { recursive: true });

		const result = importReviewUserConfig({
			userDataPath: fixture.target,
			env: { DEV_REVIEW_IMPORT_FROM: insidersUser },
			homeDir: fixture.root,
		});

		assert.strictEqual(result.status, 'imported');
		assert.strictEqual(result.source, insidersUser);
		assert.strictEqual(result.keymap, 'vim');
	});

	test('previews manual overwrites without changing them', () => {
		const fixture = createFixture();
		writeFileSync(path.join(fixture.sourceUser, 'keybindings.json'), '[]\n');
		mkdirSync(path.join(fixture.target, 'User'), { recursive: true });
		const targetKeybindings = path.join(fixture.target, 'User', 'keybindings.json');
		writeFileSync(targetKeybindings, '[{ "key": "mine" }]\n');

		const result = importReviewUserConfig({
			userDataPath: fixture.target,
			mode: 'preview',
			env: { DEV_REVIEW_IMPORT_FROM: fixture.sourceRoot },
			homeDir: fixture.root,
		});

		assert.strictEqual(result.status, 'ready');
		assert.deepStrictEqual(result.wouldOverwrite, [targetKeybindings]);
		assert.strictEqual(readFileSync(targetKeybindings, 'utf8'), '[{ "key": "mine" }]\n');

		const applied = importReviewUserConfig({
			userDataPath: fixture.target,
			mode: 'apply',
			env: { DEV_REVIEW_IMPORT_FROM: fixture.sourceRoot },
			homeDir: fixture.root,
		});
		assert.strictEqual(applied.status, 'imported');
		assert.strictEqual(readFileSync(targetKeybindings, 'utf8'), '[]\n');
	});

	test('chooses the most recently modified VS Code-family default profile', () => {
		const fixture = createFixture();
		const configRoot = path.join(fixture.root, 'config');
		const codeUser = path.join(configRoot, 'Code', 'User');
		const cursorUser = path.join(configRoot, 'Cursor', 'User');
		mkdirSync(codeUser, { recursive: true });
		mkdirSync(cursorUser, { recursive: true });
		writeFileSync(path.join(codeUser, 'keybindings.json'), '[{ "key": "code" }]\n');
		writeFileSync(path.join(cursorUser, 'keybindings.json'), '[{ "key": "cursor" }]\n');
		utimesSync(path.join(codeUser, 'keybindings.json'), new Date(1_000), new Date(1_000));
		utimesSync(path.join(cursorUser, 'keybindings.json'), new Date(2_000), new Date(2_000));
		utimesSync(codeUser, new Date(1_000), new Date(1_000));
		utimesSync(cursorUser, new Date(2_000), new Date(2_000));

		const result = importReviewUserConfig({
			userDataPath: fixture.target,
			platform: 'linux',
			env: { XDG_CONFIG_HOME: configRoot },
			homeDir: fixture.root,
		});

		assert.strictEqual(result.source, cursorUser);
		assert.strictEqual(
			readFileSync(path.join(fixture.target, 'User', 'keybindings.json'), 'utf8'),
			'[{ "key": "cursor" }]\n',
		);
	});

	test('honours the import opt-out', () => {
		const fixture = createFixture();
		const result = importReviewUserConfig({
			userDataPath: fixture.target,
			env: { DEV_REVIEW_IMPORT_FROM: 'none' },
			homeDir: fixture.root,
		});
		assert.strictEqual(result.status, 'disabled');
	});
});
