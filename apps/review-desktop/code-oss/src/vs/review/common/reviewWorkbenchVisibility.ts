/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Review hosts Home, review canvases, files, and diffs in one native editor
 * group. The legacy sessions part remains registered only as a hidden layout
 * placeholder.
 *
 * `explorer` is never persisted. `ReviewExplorerParts` derives it from the
 * active editor pane on every change, so the layout always starts it hidden and
 * lets that service reassert it once the restored editor is known.
 *
 * A user *closing* the tree is a separate matter. That is a decision rather than
 * derived state, so it has to survive the next tab switch and a reload.
 * `ReviewExplorerParts` persists it on its own key (`review.explorer.userClosed`)
 * and folds it into the derived value. No part visibility is stored here.
 */
export const initialReviewPartVisibility = {
	sidebar: false,
	auxiliaryBar: false,
	editor: true,
	panel: false,
	sessions: false,
	explorer: false,
} as const;
