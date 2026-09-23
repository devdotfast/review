/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The height of the one Review chrome row, in CSS pixels.
 *
 * Review draws the titlebar as an overlay on the editor tab strip, so one
 * height controls three things that must agree: the titlebar part, the macOS
 * window controls, and the editor tab strip. 40px is a 28px tab pill plus 6px
 * of padding above it and 6px below it.
 *
 * KEEP IN SYNC WITH:
 * - `.review-chrome-overlay` and the pill metrics in
 *   `review/browser/media/review.css`.
 * - `EditorTabsControl.EDITOR_TAB_HEIGHT.review` in
 *   `workbench/browser/parts/editor/editorTabsControl.ts`.
 */
export const REVIEW_CHROME_HEIGHT = 40;
