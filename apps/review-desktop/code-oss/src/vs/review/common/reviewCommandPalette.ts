/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { stripIcons } from '../../base/common/iconLabels.js';
import { localize } from '../../nls.js';
import type { ICommandAction } from '../../platform/action/common/action.js';

type CommandLabel = Pick<ICommandAction, 'title' | 'category'>;

/** Stock features Whiteboard does not ship, whose commands stay out of the palette. */
const FOREIGN_COMMAND = /chat|debug|extension|git|keybinding|mcp|notebook|preference|profile|remote|scm|setting|sync|task|terminal|test|update/i;

/**
 * Whether a Command Palette entry belongs in Whiteboard's palette. Whiteboard
 * and extension commands always do; stock commands only when they are not
 * part of a feature Whiteboard leaves out.
 */
export function isReviewPaletteCommand(commandId: string, extensionCommands: ReadonlySet<string>): boolean {
	return commandId.startsWith('review.') || extensionCommands.has(commandId) || !FOREIGN_COMMAND.test(commandId);
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
