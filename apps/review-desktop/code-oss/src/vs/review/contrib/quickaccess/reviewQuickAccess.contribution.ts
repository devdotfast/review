/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { localize } from '../../../nls.js';
import { MenuRegistry, registerAction2 } from '../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../platform/keybinding/common/keybinding.js';
import { AbstractCommandsQuickAccessProvider, type ICommandQuickPick } from '../../../platform/quickinput/browser/commandsQuickAccess.js';
import { Extensions, type IQuickAccessRegistry } from '../../../platform/quickinput/common/quickAccess.js';
import { Registry } from '../../../platform/registry/common/platform.js';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry.js';
import { ShowAllCommandsAction } from '../../../workbench/contrib/quickaccess/browser/commandsQuickAccess.js';
import { IExtensionService } from '../../../workbench/services/extensions/common/extensions.js';
import { reviewCommandPaletteLabel } from '../../common/reviewCommandPalette.js';

const FOREIGN_COMMAND = /chat|debug|extension|git|keybinding|mcp|notebook|preference|profile|remote|scm|setting|sync|task|terminal|test|update/i;

export class ReviewCommandsQuickAccessProvider extends AbstractCommandsQuickAccessProvider {
	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IKeybindingService keybindingService: IKeybindingService,
		@ICommandService commandService: ICommandService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IDialogService dialogService: IDialogService,
		@IExtensionService private readonly extensionService: IExtensionService,
	) {
		super({ showAlias: false }, instantiationService, keybindingService, commandService, telemetryService, dialogService);
	}

	protected override async getCommandPicks(token: CancellationToken): Promise<ICommandQuickPick[]> {
		if (token.isCancellationRequested) return [];
		await this.extensionService.whenInstalledExtensionsRegistered();
		if (token.isCancellationRequested) return [];
		const extensionCommands = new Set(
			this.extensionService.extensions.flatMap(extension =>
				extension.contributes?.commands?.map(command => command.command) ?? []
			)
		);
		return [...CommandsRegistry.getCommands().keys()]
			.filter(commandId => commandId.startsWith('review.') || extensionCommands.has(commandId) || !FOREIGN_COMMAND.test(commandId))
			.sort((left, right) => left.localeCompare(right))
			.map(commandId => ({
				commandId,
				label: reviewCommandPaletteLabel(commandId, MenuRegistry.getCommand(commandId)),
			}));
	}

	protected override hasAdditionalCommandPicks(_filter: string, _token: CancellationToken): boolean {
		return false;
	}

	protected override async getAdditionalCommandPicks(
		_allPicks: ICommandQuickPick[],
		_picksSoFar: ICommandQuickPick[],
		_filter: string,
		_token: CancellationToken,
	): Promise<ICommandQuickPick[]> {
		return [];
	}
}

Registry.as<IQuickAccessRegistry>(Extensions.Quickaccess).registerQuickAccessProvider({
	ctor: ReviewCommandsQuickAccessProvider,
	prefix: ReviewCommandsQuickAccessProvider.PREFIX,
	contextKey: 'inCommandsPicker',
	placeholder: localize('reviewCommandsQuickAccessPlaceholder', 'Type the name of an editor or Review command to run.'),
	helpEntries: [{
		description: localize('reviewCommandsQuickAccess', 'Show and run Review commands'),
		commandId: ShowAllCommandsAction.ID,
		commandCenterOrder: 20
	}]
});

registerAction2(ShowAllCommandsAction);
