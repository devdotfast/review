/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../nls.js';
import { Codicon } from '../../../base/common/codicons.js';
import { getErrorMessage } from '../../../base/common/errors.js';
import { DisposableStore } from '../../../base/common/lifecycle.js';
import { isLinux, isMacintosh } from '../../../base/common/platform.js';
import { ThemeIcon } from '../../../base/common/themables.js';
import { URI } from '../../../base/common/uri.js';
import { ipcRenderer } from '../../../base/parts/sandbox/electron-browser/globals.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../platform/commands/common/commands.js';
import { IConfigurationService, ConfigurationTarget } from '../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../platform/dialogs/common/dialogs.js';
import { ExtensionType, type IExtensionIdentifier } from '../../../platform/extensions/common/extensions.js';
import {
	IExtensionManagementService,
	IGlobalExtensionEnablementService,
	type ILocalExtension
} from '../../../platform/extensionManagement/common/extensionManagement.js';
import { areSameExtensions } from '../../../platform/extensionManagement/common/extensionManagementUtil.js';
import type { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { IMainProcessService } from '../../../platform/ipc/common/mainProcessService.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../platform/progress/common/progress.js';
import { IQuickInputService, type IQuickPickItem } from '../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../platform/storage/common/storage.js';
import { LifecyclePhase } from '../../../workbench/services/lifecycle/common/lifecycle.js';
import {
	Extensions as WorkbenchExtensions,
	type IWorkbenchContribution,
	type IWorkbenchContributionsRegistry
} from '../../../workbench/common/contributions.js';
import { REVIEW_KEYMAP_SETTING, type ReviewKeymap } from '../../common/reviewConfigurationDefaults.js';
import { REVIEW_DESKTOP_CHANNEL } from '../../common/reviewDesktopBootstrap.js';
import type { ReviewUserConfigImportResult } from '../../node/reviewUserConfigImport.js';
import { IReviewTelemetryService } from '../../services/reviewTelemetryService.js';
import { reviewOptionalExtensionCatalog } from '../../node/reviewOptionalExtensionCatalog.js';
import {
	installMissingOptionalExtensions,
	OptionalExtensionInstallError,
	optionalGroupMemberIds,
	upgradeOptionalExtensionPins
} from './reviewOptionalExtensionManagement.js';

/**
 * The curated bundled extensions Review materializes, mirroring
 * apps/review-desktop/scripts/curated-extensions.manifest.mjs. A test in
 * curated-extensions.test.mjs keeps the two lists in step.
 *
 * Only bundled extensions that are installed show up as individual rows.
 * Optional groups always show so the user can consent to their download.
 */
const BUNDLED_EXTENSIONS: readonly { id: string; label: string }[] = [
	{ id: 'ms-python.python', label: localize('review.curated.python', "Python") },
	{ id: 'astral-sh.ty', label: localize('review.curated.ty', "Python type checking (ty)") },
	{ id: 'charliermarsh.ruff', label: localize('review.curated.ruff', "Python lint and format (ruff)") },
	{ id: 'golang.go', label: localize('review.curated.go', "Go") },
	{ id: 'vscodevim.vim', label: localize('review.curated.vim', "Vim keybindings") },
	{ id: 'tuttieee.emacs-mcx', label: localize('review.curated.emacs', "Emacs keybindings") }
];

const OPTIONAL_GROUPS: readonly { group: string; label: string; detail?: string }[] = [
	{ group: 'rust', label: localize('review.curated.rust', "Rust (rust-analyzer)") },
	{ group: 'swift', label: localize('review.curated.swift', "Swift") },
	{
		group: 'csharp',
		label: localize('review.curated.csharp', "C#"),
		detail: localize('review.curated.csharp.requiresDotnet', "Requires a system .NET SDK. Review does not download .NET.")
	}
] as const;

const ALL_CURATED_IDS = [
	...BUNDLED_EXTENSIONS.map(extension => extension.id),
	...reviewOptionalExtensionCatalog.map(extension => extension.id)
];

type CuratedQuickPickItem = IQuickPickItem & (
	| { kind: 'bundled'; id: string }
	| { kind: 'optional'; group: string }
);

/** The two keymaps fight over the same keys, so only one may be on at a time. */
const KEYMAP_EXTENSION_IDS: Readonly<Record<Exclude<ReviewKeymap, 'none'>, string>> = {
	vim: 'vscodevim.vim',
	emacs: 'tuttieee.emacs-mcx',
};
const KEYMAP_IDS = Object.values(KEYMAP_EXTENSION_IDS);

const SEEDED_STORAGE_KEY = 'review.curatedExtensions.defaultsApplied.v2';

type ExtensionEnablementTrigger = 'user' | 'keymap' | 'startup_seed';

function isDisabled(disabled: readonly IExtensionIdentifier[], id: string): boolean {
	return disabled.some(identifier => areSameExtensions(identifier, { id }));
}

/**
 * Applies the enable/disable choice. Extension enablement only takes effect when
 * the extension host restarts, so callers offer a reload afterwards. Takes the
 * services rather than a ServicesAccessor: callers reach this after awaits, and
 * an accessor is only valid during the synchronous span of its invocation.
 */
export async function setCuratedExtensionsEnabled(
	enablementService: IGlobalExtensionEnablementService,
	extensionManagementService: IExtensionManagementService,
	enabledIds: readonly string[],
	reviewTelemetryService: IReviewTelemetryService,
	trigger: ExtensionEnablementTrigger = 'user'
): Promise<boolean> {
	const installed = await extensionManagementService.getInstalled();
	const installedCurated = installed.filter(extension =>
		ALL_CURATED_IDS.some(id => areSameExtensions(extension.identifier, { id }))
	);
	let changed = false;

	for (const extension of installedCurated) {
		const extensionId = ALL_CURATED_IDS.find(id => areSameExtensions(extension.identifier, { id }));
		if (!extensionId) {
			continue;
		}
		let didChange: boolean;
		if (enabledIds.some(id => areSameExtensions(extension.identifier, { id }))) {
			didChange = await enablementService.enableExtension(extension.identifier);
			if (didChange) {
				reviewTelemetryService.capture('extension_enabled', { extension_id: extensionId, trigger });
			}
		} else {
			didChange = await enablementService.disableExtension(extension.identifier);
			if (didChange) {
				reviewTelemetryService.capture('extension_disabled', { extension_id: extensionId, trigger });
			}
		}
		changed ||= didChange;
	}
	return changed;
}

/**
 * Selects a keymap from the Settings tab.
 *
 * This touches the two keymap extensions only. `setCuratedExtensionsEnabled`
 * takes the full enabled list, so passing one keymap id to it would disable
 * rust-analyzer, Python, and Go.
 *
 * The extension enablement moves here rather than at the next launch, because
 * CuratedExtensionDefaults reconciles enablement against `review.keymap` on
 * startup and would force a surprise reload if the two disagreed.
 */
async function applyReviewKeymap(accessor: ServicesAccessor, keymap: ReviewKeymap): Promise<void> {
	const configurationService = accessor.get(IConfigurationService);
	const enablementService = accessor.get(IGlobalExtensionEnablementService);
	const commandService = accessor.get(ICommandService);
	const dialogService = accessor.get(IDialogService);
	const reviewTelemetryService = accessor.get(IReviewTelemetryService);

	if (configurationService.getValue<ReviewKeymap>(REVIEW_KEYMAP_SETTING) === keymap) {
		return;
	}
	await configurationService.updateValue(REVIEW_KEYMAP_SETTING, keymap, ConfigurationTarget.USER);

	let changed = false;
	for (const [candidate, id] of Object.entries(KEYMAP_EXTENSION_IDS) as [Exclude<ReviewKeymap, 'none'>, string][]) {
		const didChange = candidate === keymap
			? await enablementService.enableExtension({ id })
			: await enablementService.disableExtension({ id });
		if (didChange) {
			reviewTelemetryService.capture(candidate === keymap ? 'extension_enabled' : 'extension_disabled', {
				extension_id: id,
				trigger: 'keymap'
			});
		}
		changed ||= didChange;
	}
	if (!changed) {
		return;
	}

	// The caller may be a page the user is still reading, so offer the reload
	// rather than force it.
	const reload = await dialogService.confirm({
		type: 'info',
		message: localize('review.keymap.reload', "Reload Review to apply the keymap?"),
		detail: localize('review.keymap.reloadDetail', "Keymap extensions only take effect after the extension host restarts."),
		primaryButton: localize('review.keymap.reloadNow', "&&Reload"),
		cancelButton: localize('review.keymap.reloadLater', "Later"),
	});
	if (reload.confirmed) {
		await reviewTelemetryService.flush();
		await commandService.executeCommand('workbench.action.reloadWindow');
	}
}

CommandsRegistry.registerCommand('review.setKeymap', (accessor, keymap: ReviewKeymap) =>
	applyReviewKeymap(accessor, keymap)
);

function findInstalled(installed: readonly ILocalExtension[], id: string): ILocalExtension | undefined {
	return installed.find(extension => areSameExtensions(extension.identifier, { id }));
}

function optionalDownloadSize(group: string, installed: readonly ILocalExtension[]): number {
	const target = isMacintosh ? 'darwin-arm64' : isLinux ? 'linux-x64' : undefined;
	return reviewOptionalExtensionCatalog
		.filter(extension => extension.group === group && !findInstalled(installed, extension.id))
		.reduce((total, extension) => {
			const targets = extension.targets as Readonly<Record<string, { readonly size: number }>>;
			const pin = targets['universal'] ?? (target ? targets[target] : undefined);
			return total + (pin?.size ?? 0);
		}, 0);
}

function formatDownloadSize(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function optionalExtensionLabel(extensionId: string): string {
	const extension = reviewOptionalExtensionCatalog.find(candidate => candidate.id === extensionId);
	const group = extension && OPTIONAL_GROUPS.find(candidate => candidate.group === extension.group);
	if (!extension || !group) {
		return extensionId;
	}
	return extension.role === 'support'
		? localize('review.curated.extensionSupport', "{0} support", group.label)
		: group.label;
}

async function stageRustAnalyzer(
	mainProcessService: IMainProcessService,
	logService: ILogService
): Promise<void> {
	try {
		await mainProcessService.getChannel(REVIEW_DESKTOP_CHANNEL).call('stageRustAnalyzer');
	} catch (error) {
		logService.error(`[Review extensions] Could not stage rust-analyzer: ${getErrorMessage(error)}`);
	}
}

class ManageCuratedExtensionsAction extends Action2 {
	constructor() {
		super({
			id: 'review.manageExtensions',
			title: localize2('review.manageExtensions', "Manage Extensions..."),
			f1: true
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const extensionManagementService = accessor.get(IExtensionManagementService);
		const enablementService = accessor.get(IGlobalExtensionEnablementService);
		const commandService = accessor.get(ICommandService);
		const configurationService = accessor.get(IConfigurationService);
		const dialogService = accessor.get(IDialogService);
		const notificationService = accessor.get(INotificationService);
		const progressService = accessor.get(IProgressService);
		const mainProcessService = accessor.get(IMainProcessService);
		const logService = accessor.get(ILogService);
		const reviewTelemetryService = accessor.get(IReviewTelemetryService);

		let installed = await extensionManagementService.getInstalled();

		const disabled = enablementService.getDisabledExtensions();
		const items: CuratedQuickPickItem[] = BUNDLED_EXTENSIONS
			.filter(curated => findInstalled(installed, curated.id))
			.map(curated => ({
			kind: 'bundled',
			id: curated.id,
			label: curated.label,
			description: curated.id,
			picked: !isDisabled(disabled, curated.id)
		}));
		for (const optionalGroup of OPTIONAL_GROUPS) {
			const members = optionalGroupMemberIds(optionalGroup.group);
			const installedMembers = members
				.map(id => findInstalled(installed, id))
				.filter((extension): extension is ILocalExtension => Boolean(extension));
			const primary = reviewOptionalExtensionCatalog.find(extension =>
				extension.group === optionalGroup.group && extension.role === 'primary'
			);
			const downloadSize = optionalDownloadSize(optionalGroup.group, installed);
			const userMembers = installedMembers.filter(extension => extension.type === ExtensionType.User);
			items.push({
				kind: 'optional',
				group: optionalGroup.group,
				label: optionalGroup.label,
				description: downloadSize > 0
					? localize('review.curated.downloadSize', "Download {0}", formatDownloadSize(downloadSize))
					: localize('review.curated.installed', "Installed"),
				detail: optionalGroup.detail,
				picked: Boolean(primary && findInstalled(installed, primary.id)) &&
					installedMembers.every(extension => !isDisabled(disabled, extension.identifier.id)),
				buttons: userMembers.length > 0 ? [{
					iconClass: ThemeIcon.asClassName(Codicon.trash),
					tooltip: localize('review.curated.uninstall', "Uninstall this optional language group")
				}] : undefined
			});
		}

		const installedBefore = new Set(installed.map(extension => extension.identifier.id.toLowerCase()));
		const initiallySelected = new Set(items.filter(item => item.picked).map(item => item));
		const picked = await new Promise<readonly CuratedQuickPickItem[] | undefined>(resolve => {
			const disposables = new DisposableStore();
			const quickPick = disposables.add(quickInputService.createQuickPick<CuratedQuickPickItem>());
			let accepted: readonly CuratedQuickPickItem[] | undefined;

			quickPick.canSelectMany = true;
			quickPick.title = localize('review.curated.title', "Manage Extensions");
			quickPick.placeholder = localize('review.curated.placeholder', "Select language groups to download, install, or enable");
			quickPick.items = items;
			quickPick.selectedItems = items.filter(item => item.picked);

			const updateAcceptLabel = (selected: readonly CuratedQuickPickItem[]): void => {
				const selectedSet = new Set(selected);
				const selectedGroups = new Set(selected
					.filter((item): item is CuratedQuickPickItem & { kind: 'optional' } => item.kind === 'optional')
					.map(item => item.group));
				const installCount = reviewOptionalExtensionCatalog.filter(extension =>
					selectedGroups.has(extension.group) && !installedBefore.has(extension.id.toLowerCase())
				).length;
				const hasOtherChanges = items.some(item => {
					if (initiallySelected.has(item) === selectedSet.has(item)) {
						return false;
					}
					return item.kind !== 'optional' || !selectedSet.has(item) ||
						!reviewOptionalExtensionCatalog.some(extension =>
							extension.group === item.group && !installedBefore.has(extension.id.toLowerCase())
						);
				});

				quickPick.okLabel = installCount > 0 && !hasOtherChanges
					? installCount === 1
						? localize('review.curated.installOneExtension', "Install 1 extension")
						: localize('review.curated.installManyExtensions', "Install {0} extensions", installCount)
					: localize('review.curated.saveExtensions', "Save");
			};

			updateAcceptLabel(quickPick.selectedItems);
			disposables.add(quickPick.onDidChangeSelection(updateAcceptLabel));
			disposables.add(quickPick.onDidAccept(() => {
				accepted = quickPick.selectedItems.slice();
				quickPick.hide();
			}));
			disposables.add(quickPick.onDidTriggerItemButton(context => {
				if (context.item.kind !== 'optional') {
					return;
				}
				const item = context.item;
				void (async () => {
					const confirmation = await dialogService.confirm({
						type: 'warning',
						message: localize('review.curated.confirmUninstall', "Uninstall {0}?", item.label),
						detail: localize('review.curated.confirmUninstallDetail', "Review will remove all user-installed members of this language group."),
						primaryButton: localize('review.curated.uninstallNow', "&&Uninstall")
					});
					if (!confirmation.confirmed) {
						return;
					}
					try {
						const members = optionalGroupMemberIds(item.group);
						const userMembers = (await extensionManagementService.getInstalled(ExtensionType.User))
							.filter(extension => members.some(id => areSameExtensions(extension.identifier, { id })));
						for (const extension of userMembers) {
							await extensionManagementService.uninstall(extension, {
								donotIncludePack: true,
								donotCheckDependents: true
							});
							const extensionId = ALL_CURATED_IDS.find(id => areSameExtensions(extension.identifier, { id }));
							if (extensionId) {
								reviewTelemetryService.capture('extension_uninstalled', {
									extension_id: extensionId,
									trigger: 'user'
								});
							}
						}
						if (userMembers.length > 0) {
							await reviewTelemetryService.flush();
							await commandService.executeCommand('workbench.action.reloadWindow');
						}
					} catch (error) {
						notificationService.error(localize(
							'review.curated.uninstallFailed',
							"Review could not uninstall the optional extension group: {0}",
							getErrorMessage(error)
						));
					}
				})();
			}));
			disposables.add(quickPick.onDidHide(() => {
				resolve(accepted);
				disposables.dispose();
			}));
			quickPick.show();
		});
		if (!picked) {
			return;
		}

		const selectedOptionalGroups = picked
			.filter((item): item is CuratedQuickPickItem & { kind: 'optional' } => item.kind === 'optional')
			.map(item => item.group);
		let newInstalls: readonly ILocalExtension[];
		try {
			newInstalls = await progressService.withProgress({
				location: ProgressLocation.Notification,
				title: localize('review.curated.installingLanguageSupport', "Adding language support..."),
				delay: 0
			}, progress => installMissingOptionalExtensions({
				groups: selectedOptionalGroups,
				installedIds: installedBefore,
				download: async extensionId => {
					progress.report({
						message: localize(
							'review.curated.downloadingExtension',
							"Downloading {0}...",
							optionalExtensionLabel(extensionId)
						)
					});
					return ipcRenderer.invoke(
						'vscode:reviewDownloadOptionalExtension',
						extensionId
					) as Promise<string>;
				},
				install: async (extensionId, vsixPath) => {
					progress.report({
						message: localize(
							'review.curated.installingExtension',
							"Installing {0}...",
							optionalExtensionLabel(extensionId)
						)
					});
					return extensionManagementService.install(URI.file(vsixPath), {
						donotIncludePackAndDependencies: true,
						installGivenVersion: true,
						pinned: true
					});
				},
				rollback: extension => extensionManagementService.uninstall(extension, {
					donotIncludePack: true,
					donotCheckDependents: true
				}),
				onInstalled: (extensionId, trigger, durationMs) => {
					reviewTelemetryService.capture('extension_installed', {
						extension_id: extensionId,
						trigger,
						duration_ms: durationMs
					});
				},
				onInstallFailed: (extensionId, trigger, phase) => {
					reviewTelemetryService.capture('extension_install_failed', {
						extension_id: extensionId,
						trigger,
						phase
					});
				},
				onRolledBack: extensionId => {
					reviewTelemetryService.capture('extension_uninstalled', {
						extension_id: extensionId,
						trigger: 'rollback'
					});
				}
			}, 'user'));
		} catch (error) {
			if (error instanceof OptionalExtensionInstallError) {
				for (const rollbackError of error.rollbackErrors) {
					notificationService.error(localize(
						'review.curated.rollbackFailed',
						"Review could not roll back an optional extension: {0}",
						getErrorMessage(rollbackError)
					));
				}
				const message = error.phase === 'download'
					? localize('review.curated.downloadFailed', "Review could not download an optional extension: {0}", getErrorMessage(error.originalError))
					: localize('review.curated.installFailed', "Review could not install an optional extension: {0}", getErrorMessage(error.originalError));
				notificationService.error(message);
			} else {
				notificationService.error(getErrorMessage(error));
			}
			return;
		}

		installed = await extensionManagementService.getInstalled();
		if (newInstalls.some(extension => areSameExtensions(extension.identifier, { id: 'rust-lang.rust-analyzer' }))) {
			await stageRustAnalyzer(mainProcessService, logService);
		}
		let enabledIds = picked
			.filter((item): item is CuratedQuickPickItem & { kind: 'bundled' } => item.kind === 'bundled')
			.map(item => item.id);
		for (const group of selectedOptionalGroups) {
			enabledIds.push(...optionalGroupMemberIds(group));
		}
		const pickedKeymaps = enabledIds.filter(id => KEYMAP_IDS.includes(id));
		if (pickedKeymaps.length > 1) {
			// Keep the one that was off before, i.e. the one being turned on now.
			const newlyEnabled = pickedKeymaps.find(id => isDisabled(disabled, id)) ?? pickedKeymaps[0];
			enabledIds = enabledIds.filter(id => !KEYMAP_IDS.includes(id) || id === newlyEnabled);
		}

		const keymap = (Object.entries(KEYMAP_EXTENSION_IDS) as [Exclude<ReviewKeymap, 'none'>, string][])
			.find(([, id]) => enabledIds.includes(id))?.[0] ?? 'none';
		const enablementChanged = await setCuratedExtensionsEnabled(
			enablementService,
			extensionManagementService,
			enabledIds,
			reviewTelemetryService,
			'user'
		);
		const keymapChanged = configurationService.getValue<ReviewKeymap>(REVIEW_KEYMAP_SETTING) !== keymap;
		if (keymapChanged) {
			await configurationService.updateValue(REVIEW_KEYMAP_SETTING, keymap, ConfigurationTarget.USER);
		}
		if (newInstalls.length > 0 || enablementChanged || keymapChanged) {
			await reviewTelemetryService.flush();
			await commandService.executeCommand('workbench.action.reloadWindow');
		}
	}
}

registerAction2(ManageCuratedExtensionsAction);

class ImportUserConfigAction extends Action2 {
	constructor() {
		super({
			id: 'review.importUserConfig',
			title: localize2('review.importUserConfig', "Review: Import VS Code Settings and Keybindings..."),
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const dialogService = accessor.get(IDialogService);
		const commandService = accessor.get(ICommandService);

		try {
			const preview = await ipcRenderer.invoke(
				'vscode:reviewImportUserConfig',
				{ mode: 'preview' },
			) as ReviewUserConfigImportResult;
			if (preview.status === 'disabled') {
				await dialogService.info(
					localize('review.importUserConfig.disabled', "VS Code settings import is disabled."),
					localize('review.importUserConfig.disabledDetail', "Unset DEV_REVIEW_IMPORT_FROM=none and restart Review to enable imports."),
				);
				return;
			}
			if (preview.status === 'not-found' || !preview.source) {
				await dialogService.info(
					localize('review.importUserConfig.notFound', "No VS Code settings were found."),
					localize('review.importUserConfig.notFoundDetail', "Review checks Code, Code - Insiders, VSCodium, and Cursor's default profiles."),
				);
				return;
			}

			const overwriteDetail = preview.wouldOverwrite.length > 0
				? localize(
					'review.importUserConfig.overwriteDetail',
					"The following Review files will be overwritten:\n{0}",
					preview.wouldOverwrite.join('\n'),
				)
				: localize(
					'review.importUserConfig.createDetail',
					"Review will create settings files under its user profile. Source:\n{0}",
					preview.source,
				);
			const confirmation = await dialogService.confirm({
				type: 'warning',
				message: localize('review.importUserConfig.confirm', "Import VS Code settings and keybindings?"),
				detail: overwriteDetail,
				primaryButton: localize('review.importUserConfig.import', "Import"),
			});
			if (!confirmation.confirmed) {
				return;
			}

			const result = await ipcRenderer.invoke(
				'vscode:reviewImportUserConfig',
				{ mode: 'apply' },
			) as ReviewUserConfigImportResult;
			if (result.status !== 'imported') {
				throw new Error(`Unexpected Review user-config import result: ${result.status}`);
			}

			const reload = await dialogService.confirm({
				type: 'info',
				message: localize('review.importUserConfig.complete', "VS Code settings and keybindings were imported."),
				detail: localize('review.importUserConfig.reloadDetail', "Reload Review to apply keybindings and keymap extension changes."),
				primaryButton: localize('review.importUserConfig.reload', "Reload"),
			});
			if (reload.confirmed) {
				await commandService.executeCommand('workbench.action.reloadWindow');
			}
		} catch (error) {
			await dialogService.error(
				localize('review.importUserConfig.error', "Review could not import VS Code settings and keybindings."),
				String(error),
			);
		}
	}
}

registerAction2(ImportUserConfigAction);

MenuRegistry.appendMenuItem(MenuId.MenubarPreferencesMenu, {
	command: {
		id: 'review.manageExtensions',
		title: localize('review.manageExtensions.menu', "Manage Extensions...")
	},
	order: 1
});

/**
 * Seeds the shipped keymap defaults once per profile. An imported review.keymap
 * selects Vim or Emacs; otherwise both remain off. After that the user's choice
 * in the picker wins.
 */
class CuratedExtensionDefaults implements IWorkbenchContribution {
	constructor(
		@IStorageService storageService: IStorageService,
		@IGlobalExtensionEnablementService enablementService: IGlobalExtensionEnablementService,
		@IConfigurationService configurationService: IConfigurationService,
		@ICommandService commandService: ICommandService,
		@IReviewTelemetryService reviewTelemetryService: IReviewTelemetryService,
	) {
		const alreadySeeded = storageService.getBoolean(SEEDED_STORAGE_KEY, StorageScope.APPLICATION, false);
		const keymap = configurationService.getValue<ReviewKeymap>(REVIEW_KEYMAP_SETTING);
		const disabled = enablementService.getDisabledExtensions();
		const keymapStateMatches = (Object.entries(KEYMAP_EXTENSION_IDS) as [Exclude<ReviewKeymap, 'none'>, string][])
			.every(([candidate, id]) => isDisabled(disabled, id) === (candidate !== keymap));
		if (alreadySeeded && keymapStateMatches) {
			return;
		}
		if (!alreadySeeded) {
			storageService.store(SEEDED_STORAGE_KEY, true, StorageScope.APPLICATION, StorageTarget.MACHINE);
		}
		void this.applyKeymapDefault(keymap, enablementService, commandService, reviewTelemetryService);
	}

	private async applyKeymapDefault(
		keymap: ReviewKeymap,
		enablementService: IGlobalExtensionEnablementService,
		commandService: ICommandService,
		reviewTelemetryService: IReviewTelemetryService,
	): Promise<void> {
		let changed = false;
		for (const [candidate, id] of Object.entries(KEYMAP_EXTENSION_IDS) as [Exclude<ReviewKeymap, 'none'>, string][]) {
			const didChange = candidate === keymap
				? await enablementService.enableExtension({ id })
				: await enablementService.disableExtension({ id });
			if (didChange) {
				reviewTelemetryService.capture(candidate === keymap ? 'extension_enabled' : 'extension_disabled', {
					extension_id: id,
					trigger: 'startup_seed'
				});
			}
			changed ||= didChange;
		}
		if (changed) {
			await reviewTelemetryService.flush();
			await commandService.executeCommand('workbench.action.reloadWindow');
		}
	}
}

class OptionalExtensionPinUpgrades implements IWorkbenchContribution {
	constructor(
		@IExtensionManagementService private readonly extensionManagementService: IExtensionManagementService,
		@IMainProcessService private readonly mainProcessService: IMainProcessService,
		@ILogService private readonly logService: ILogService,
		@IReviewTelemetryService private readonly reviewTelemetryService: IReviewTelemetryService
	) {
		void this.run().catch(error => {
			this.logService.error(`[Review extensions] Could not check optional extension pins: ${getErrorMessage(error)}`);
		});
	}

	private async run(): Promise<void> {
		const installed = await this.extensionManagementService.getInstalled(ExtensionType.User);
		await upgradeOptionalExtensionPins({
			installed: installed.map(extension => ({
				id: extension.identifier.id,
				version: extension.manifest.version
			})),
			download: extensionId => ipcRenderer.invoke(
				'vscode:reviewDownloadOptionalExtension',
				extensionId
			) as Promise<string>,
			install: async (_extensionId, vsixPath) => {
				await this.extensionManagementService.install(URI.file(vsixPath), {
					donotIncludePackAndDependencies: true,
					installGivenVersion: true,
					pinned: true
				});
			},
			stageRustAnalyzer: () => stageRustAnalyzer(this.mainProcessService, this.logService),
			logError: (message, error) => {
				this.logService.error(`[Review extensions] ${message}: ${getErrorMessage(error)}`);
			},
			onInstalled: (extensionId, trigger, durationMs) => {
				this.reviewTelemetryService.capture('extension_installed', {
					extension_id: extensionId,
					trigger,
					duration_ms: durationMs
				});
			},
			onInstallFailed: (extensionId, trigger, phase) => {
				this.reviewTelemetryService.capture('extension_install_failed', {
					extension_id: extensionId,
					trigger,
					phase
				});
			}
		}, 'auto_upgrade');
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
	CuratedExtensionDefaults,
	LifecyclePhase.Restored
);
Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
	OptionalExtensionPinUpgrades,
	LifecyclePhase.Eventually
);
