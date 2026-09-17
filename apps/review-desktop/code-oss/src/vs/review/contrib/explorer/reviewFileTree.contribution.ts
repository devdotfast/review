/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../nls.js';
import { KeyCode, KeyMod } from '../../../base/common/keyCodes.js';
import { Action2, MenuId, registerAction2 } from '../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../platform/contextkey/common/contextkey.js';
import { ICodeEditorService } from '../../../editor/browser/services/codeEditorService.js';
import { IEditorService } from '../../../workbench/services/editor/common/editorService.js';
import { IReviewApiSourceService } from '../../services/reviewApiSourceService.js';
import { isReviewReadonlySource } from '../../common/reviewReadonlySource.js';
import type { ServicesAccessor } from '../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../platform/keybinding/common/keybindingsRegistry.js';
import { IReviewExplorerPartsService } from '../../browser/parts/explorer/reviewExplorerPart.js';

/**
 * Closes and reopens the file tree beside a reviewed file.
 *
 * `Cmd+B` matches VS Code's Toggle Primary Side Bar, and it is taken here on
 * purpose. `ToggleSidebarVisibilityAction` in
 * `workbench/browser/actions/layoutActions.ts` claims the same chord at
 * `WorkbenchContrib`, and Review reaches that file transitively through
 * `workbench/browser/workbench.contribution.js`. At equal weight the last rule
 * registered wins, which is registration order rather than intent — so this asks
 * for one more than `WorkbenchContrib` to win deterministically.
 *
 * The binding carries no `when` clause on purpose, so the chord can never reach
 * the stock action. That action is not merely inert in Review: it flips
 * `partVisibility.sidebar`, toggles the layout class, and then calls
 * `setViewVisible` on `ReviewWorkbench.sideBarPartView`, which Review never
 * assigns. It throws with the layout state already half-changed. So this action
 * always takes the key and no-ops itself when there is no tree to toggle, rather
 * than declining the key and handing it to something that breaks the window.
 */
class ToggleReviewFileTreeAction extends Action2 {
	constructor() {
		super({
			id: 'review.toggleFileTree',
			title: localize2('review.toggleFileTree', "Review: Toggle File Tree"),
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib + 1,
				primary: KeyMod.CtrlCmd | KeyCode.KeyB,
			},
		});
	}

	override run(accessor: ServicesAccessor): void {
		accessor.get(IReviewExplorerPartsService).toggle();
	}
}

registerAction2(ToggleReviewFileTreeAction);

registerAction2(class extends Action2 {
	constructor() {
		const when = ContextKeyExpr.or(ContextKeyExpr.equals('resourceScheme', 'review-api-source'), ContextKeyExpr.equals('resourceScheme', 'review-language-source'));
		super({ id: 'review.openInWorkspace', title: localize2('review.openInWorkspace', 'Open in Workspace'), f1: true,
			precondition: when, menu: [{ id: MenuId.EditorTitle, when, group: 'navigation' }, { id: MenuId.EditorContext, when }] });
	}
	override async run(accessor: ServicesAccessor): Promise<void> {
		const resource = accessor.get(ICodeEditorService).getFocusedCodeEditor()?.getModel()?.uri ?? accessor.get(IEditorService).activeEditor?.resource;
		if (resource && isReviewReadonlySource(resource)) await accessor.get(IReviewApiSourceService).openInWorkspace(resource);
	}
});
