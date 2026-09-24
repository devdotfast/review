/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { stripIcons } from '../../base/common/iconLabels.js';
import { localize } from '../../nls.js';
import type { ICommandAction } from '../../platform/action/common/action.js';

type CommandLabel = Pick<ICommandAction, 'title' | 'category'>;

/**
 * Stock and built-in-extension commands that belong in Whiteboard's palette.
 * Whiteboard is for reading and reviewing code: source and diffs are
 * read-only, so only navigation, search, folding, diff review and a few app
 * commands are offered. Everything else keeps its keybinding but stays out of
 * the palette, including all commands contributed by language extensions.
 */
const REVIEW_PALETTE_STOCK_COMMANDS: ReadonlySet<string> = new Set([
	// Go to code
	'workbench.action.quickOpen',
	'workbench.action.gotoSymbol',
	'workbench.action.showAllSymbols',
	'workbench.action.navigateBack',
	'workbench.action.navigateForward',
	'editor.action.revealDefinition',
	'editor.action.revealDefinitionAside',
	'editor.action.revealDeclaration',
	'editor.action.goToTypeDefinition',
	'editor.action.goToImplementation',
	'editor.action.goToReferences',
	'editor.action.peekDefinition',
	'editor.action.peekDeclaration',
	'editor.action.peekTypeDefinition',
	'editor.action.peekImplementation',
	'editor.action.referenceSearch.trigger',
	'editor.action.jumpToBracket',
	'editor.action.marker.next',
	'editor.action.marker.prev',
	'editor.action.wordHighlight.next',
	'editor.action.wordHighlight.prev',
	'editor.action.showHover',
	'editor.action.showDefinitionPreviewHover',
	'references-view.findReferences',
	'references-view.findImplementations',
	'references-view.showCallHierarchy',
	'references-view.showIncomingCalls',
	'references-view.showOutgoingCalls',
	'references-view.showTypeHierarchy',
	'references-view.showSupertypes',
	'references-view.showSubtypes',

	// Find
	'actions.find',
	'actions.findWithSelection',
	'editor.action.nextMatchFindAction',
	'editor.action.previousMatchFindAction',

	// Folding
	'editor.fold',
	'editor.unfold',
	'editor.toggleFold',
	'editor.foldRecursively',
	'editor.unfoldRecursively',
	'editor.foldAll',
	'editor.unfoldAll',
	'editor.foldAllExcept',
	'editor.unfoldAllExcept',
	'editor.foldAllBlockComments',
	'editor.foldLevel1',
	'editor.foldLevel2',
	'editor.foldLevel3',
	'editor.gotoParentFold',

	// Diff review
	'workbench.action.compareEditor.nextChange',
	'workbench.action.compareEditor.previousChange',
	'toggle.diff.renderSideBySide',
	'diffEditor.collapseAllUnchangedRegions',
	'diffEditor.showAllUnchangedRegions',

	// Open files and tabs
	'copyFilePath',
	'copyRelativeFilePath',
	'workbench.action.closeActiveEditor',
	'workbench.action.closeAllEditors',
	'workbench.action.reopenClosedEditor',
	'workbench.action.nextEditor',
	'workbench.action.previousEditor',

	// App and window
	'workbench.action.zoomIn',
	'workbench.action.zoomOut',
	'workbench.action.zoomReset',
	'workbench.action.toggleFullScreen',
	'workbench.action.closeWindow',
	'workbench.action.reloadWindow',
	'workbench.action.toggleDevTools',
	'workbench.action.showAboutDialog',
]);

/** Whether a command belongs in Whiteboard's Command Palette. */
export function isReviewPaletteCommand(commandId: string): boolean {
	return commandId.startsWith('review.') || commandId.startsWith('whiteboard.') || REVIEW_PALETTE_STOCK_COMMANDS.has(commandId);
}

export function reviewCommandPaletteLabel(commandId: string, command: CommandLabel | undefined): string {
	if (!command) {
		return commandId;
	}

	let label = typeof command.title === 'string' ? command.title : command.title.value;
	const category = typeof command.category === 'string' ? command.category : command.category?.value;
	if (category) {
		label = localize('review.commandWithCategory', "{0}: {1}", category, label);
	}

	return stripIcons(label) || commandId;
}
