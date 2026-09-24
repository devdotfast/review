/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import type { IEditor } from '../../../editor/common/editorCommon.js';
import { AbstractEditorCommandsQuickAccessProvider } from '../../../editor/contrib/quickAccess/browser/commandsQuickAccess.js';
import { localize } from '../../../nls.js';
import { IMenuService, MenuId, MenuItemAction, registerAction2 } from '../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../platform/keybinding/common/keybinding.js';
import type { ICommandQuickPick } from '../../../platform/quickinput/browser/commandsQuickAccess.js';
import { Extensions, type IQuickAccessRegistry } from '../../../platform/quickinput/common/quickAccess.js';
import { Registry } from '../../../platform/registry/common/platform.js';
import { ITelemetryService } from '../../../platform/telemetry/common/telemetry.js';
import { ShowAllCommandsAction } from '../../../workbench/contrib/quickaccess/browser/commandsQuickAccess.js';
import { IEditorGroupsService } from '../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../workbench/services/editor/common/editorService.js';
import { isReviewPaletteCommand, reviewCommandPaletteLabel } from '../../common/reviewCommandPalette.js';

/**
 * Collects commands the way the stock palette does (the active editor's
 * actions and the CommandPalette menu, with their when/precondition applied),
 * then keeps only Whiteboard's own commands and the curated stock ones in
 * `isReviewPaletteCommand`.
 */
export class ReviewCommandsQuickAccessProvider extends AbstractEditorCommandsQuickAccessProvider {
	protected get activeTextEditorControl(): IEditor | undefined { return this.editorService.activeTextEditorControl; }

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IKeybindingService keybindingService: IKeybindingService,
		@ICommandService commandService: ICommandService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IDialogService dialogService: IDialogService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupService: IEditorGroupsService,
		@IMenuService private readonly menuService: IMenuService,
	) {
		super({ showAlias: false }, instantiationService, keybindingService, commandService, telemetryService, dialogService);
	}

	protected override async getCommandPicks(token: CancellationToken): Promise<ICommandQuickPick[]> {
		if (token.isCancellationRequested) return [];
		return [...this.getCodeEditorCommandPicks(), ...this.getPaletteMenuCommandPicks()]
			.filter(pick => isReviewPaletteCommand(pick.commandId));
	}

	private getPaletteMenuCommandPicks(): ICommandQuickPick[] {
		const contextKeyService = this.editorService.activeEditorPane?.scopedContextKeyService ?? this.editorGroupService.activeGroup.scopedContextKeyService;
		return this.menuService.getMenuActions(MenuId.CommandPalette, contextKeyService)
			.flatMap(([, actions]) => actions)
			.filter((action): action is MenuItemAction => action instanceof MenuItemAction && action.enabled)
			.map(action => ({
				commandId: action.item.id,
				commandWhen: action.item.precondition?.serialize(),
				label: reviewCommandPaletteLabel(action.item.id, action.item),
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
	placeholder: localize('reviewCommandsQuickAccessPlaceholder', 'Type the name of an editor or Whiteboard command to run.'),
	helpEntries: [{
		description: localize('reviewCommandsQuickAccess', 'Show and run Whiteboard commands'),
		commandId: ShowAllCommandsAction.ID,
		commandCenterOrder: 20
	}]
});

registerAction2(ShowAllCommandsAction);
