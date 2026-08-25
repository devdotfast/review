/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Review's configuration data: setting keys and default values, with no imports
 * and no side effects.
 *
 * This module is deliberately import-free. `vs/review/node/reviewUserConfigImport.ts`
 * reads these keys from the Electron main process, which `src/main.ts` reaches
 * before `startup()` calls `bootstrapESM()` — the step that installs
 * `globalThis._VSCODE_NLS_MESSAGES`. Anything imported here is evaluated inside
 * that pre-bootstrap window, where a packaged build's mangled `localize(2488, null)`
 * throws `!!! NLS MISSING: 2488 !!!` into a modal, before any window or log exists.
 *
 * Registration lives in `reviewConfiguration.ts`, which imports this file and owns
 * the configuration-registry calls. Never add an import here, and never re-export
 * these values from `reviewConfiguration.ts` — a re-export would put the
 * configuration registry back on the main process's import path.
 *
 * Enforced by `scripts/main-bootstrap-imports.test.mjs`.
 */

export const REVIEW_KEYMAP_SETTING = 'review.keymap';
export const REVIEW_TELEMETRY_SETTING = 'review.telemetry.enabled';
export const REVIEW_SOFTWARE_MAP_SETTING = 'review.experimental.softwareMap.enabled';
export const REVIEW_KEYMAPS = ['none', 'vim', 'emacs'] as const;
export type ReviewKeymap = typeof REVIEW_KEYMAPS[number];

export const reviewConfigurationDefaults = {
	[REVIEW_SOFTWARE_MAP_SETTING]: false,
	[REVIEW_TELEMETRY_SETTING]: true,
	'telemetry.telemetryLevel': 'off',
	'telemetry.enableTelemetry': false,
	'telemetry.enableCrashReporter': false,
	'telemetry.editStats.enabled': false,
	'security.workspace.trust.enabled': false,
	'workbench.enableExperiments': false,
	'workbench.commandPalette.experimental.enableNaturalLanguageSearch': false,
	'workbench.settings.enableNaturalLanguageSearch': false,
	'window.autoDetectColorScheme': true,
	'workbench.colorTheme': 'Review Dark',
	'workbench.preferredDarkColorTheme': 'Review Dark',
	'workbench.preferredLightColorTheme': 'Review Light',
	'workbench.startupEditor': 'none',
	'workbench.activityBar.location': 'hidden',
	'workbench.statusBar.visible': false,
	'window.title': 'Review',
	'window.commandCenter': false,
	'workbench.navigationControl.enabled': true,
	'window.menuBarVisibility': 'hidden',
	'workbench.editor.showTabs': 'multiple',
	'workbench.editor.editorActionsLocation': 'hidden',
	// Reduce tab widths when the row fills. The native tab control truncates the
	// labels first. It keeps horizontal scrolling after tabs reach their minimum.
	'workbench.editor.tabSizing': 'shrink',
	// Keep wheel, trackpad, keyboard, and active-tab scrolling. Hide only the
	// scrollbar, which would otherwise sit across the bottom of the pill row.
	'workbench.editor.titleScrollbarVisibility': 'hidden',
	// Home is the only sticky editor in Review. "compact" makes a sticky tab show
	// its icon alone, so the Home pill lost its name. "normal" shows the home
	// icon and the word "Home".
	'workbench.editor.pinnedTabSizing': 'normal',
	// A sticky tab shows an unpin button in place of its close button. Home is
	// always sticky and the reader cannot unpin it, so the button is dead chrome.
	'workbench.editor.tabActionUnpinVisibility': false,
	'workbench.layoutControl.enabled': false,
	'editor.minimap.enabled': false,
	'diffEditor.renderIndicators': false,
	'breadcrumbs.enabled': false,
	'git.enabled': false,
	// Review opens whole files from the pinned head worktree so language
	// servers see the tree they indexed. Those checkouts are shared,
	// disposable render sources — an edit there never reaches the user's
	// working copy, so surface every one of them as read-only.
	// The pattern must stay absolute (leading slash): the workspace folder IS
	// the pinned worktree, so ResourceGlobMatcher first tests the
	// folder-relative path ("src/lib.rs"), where no worktree segment exists.
	// Only an absolute pattern makes it retry against the full path.
	'files.readonlyInclude': { '/**/.git/dev-fast/worktrees/**': true },
	// The line above makes every full file read-only, so the read-only lock
	// badge marks every file tab and separates nothing. The badge also keeps
	// upstream's margins, which reserve a 28px close-button column. The Review
	// pill gives that column 16px, so the lock paints under the close button.
	// Colors stay on, so a tab label with errors still gets its tint.
	'workbench.editor.decorations.badges': false,
	'chat.disableAIFeatures': true,
	'extensions.ignoreRecommendations': true,
	'workbench.tips.enabled': false
} as const;

/**
 * Defaults that keep the curated built-in extensions quiet.
 *
 * Review ships no marketplace, so an extension that prompts to install or update
 * something offers the reader a dead end. Every key here closes one such prompt.
 * Keep this aligned with `scripts/curated-extensions.manifest.mjs`; the contract
 * test in `scripts/curated-extension-defaults.test.mjs` fails when a curated
 * group has neither defaults here nor an explicit "prompts nothing" entry.
 */
export const curatedExtensionConfigurationDefaults = {
	// ms-python.python resolves the "Default" language server to Pylance, which is
	// proprietary and can never ship here, then prompts to install it. ty is
	// Review's Python language server and ignores this setting.
	'python.languageServer': 'None',
	// Fetches A/B experiment payloads and prompts into them.
	'python.experiments.enabled': false,
	// "Do you want to create a virtual environment?" on requirements.txt.
	'python.createEnvironment.trigger': 'off',
	// "Configure a test framework?" on test files.
	'python.testing.promptToConfigure': false,

	// golang.go asks users to fill in a survey on a timer.
	'go.survey.prompt': false,
	// Prompts to `go install` newer tools against a toolchain Review does not ship.
	'go.toolsManagement.checkForUpdates': 'off',

	// "This file is not linked to a Cargo project" — routine when the review is
	// scoped to a subdirectory of a workspace.
	'rust-analyzer.showUnlinkedFileNotification': false,
	'rust-analyzer.notifications.cargoTomlNotFound': false,
	'rust-analyzer.showRequestFailedErrorNotification': false,

	// The Swift extension can offer to install Swiftly. Review uses the Swift
	// toolchain that the user installed and made available on the shell PATH.
	'swift.disableSwiftlyInstallPrompt': true,

	// The .NET support extension must not send its own telemetry or expose AI
	// tools. C# uses the system .NET SDK that Review resolves from the shell PATH.
	'dotnetAcquisitionExtension.enableTelemetry': false,
	'dotnetAcquisitionExtension.enableLanguageModelTools': false

	// charliermarsh.ruff already defaults `ruff.showNotifications` to "off".
	// astral-sh.ty, vscodevim.vim and tuttieee.emacs-mcx contribute no prompts.
} as const;

export const reviewAgentsWindowDefaultOverrides = {
	'window.title': reviewConfigurationDefaults['window.title'],
	'workbench.navigationControl.enabled': reviewConfigurationDefaults['workbench.navigationControl.enabled'],
} as const;
