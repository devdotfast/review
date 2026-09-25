/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { stripIcons } from '../../base/common/iconLabels.js';
import { localize } from '../../nls.js';
import type { ICommandAction } from '../../platform/action/common/action.js';

type CommandLabel = Pick<ICommandAction, 'title' | 'category'>;

/**
 * Whether a command belongs in Whiteboard's Command Palette. Only Whiteboard's
 * own commands do; stock and extension commands keep their keybindings but
 * are never listed.
 */
export function isReviewPaletteCommand(commandId: string): boolean {
	return commandId.startsWith('review.') || commandId.startsWith('whiteboard.');
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
