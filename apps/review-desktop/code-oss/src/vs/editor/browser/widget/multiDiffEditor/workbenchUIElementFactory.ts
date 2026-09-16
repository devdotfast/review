/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable } from '../../../../base/common/lifecycle.js';
import type { IObservable } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import type { IDiffCodeEditorWidgetOptions } from '../diffEditor/diffEditorWidget.js';

/**
 * This solves the problem that the editor layer cannot depend on the workbench layer.
 *
 * Maybe the multi diff editor widget should be moved to the workbench layer?
 * This would make monaco-editor consumption much more difficult though.
 */
export interface IWorkbenchUIElementFactory {
	createResourceLabel?(element: HTMLElement): IResourceLabel;
	createResourceHeaderMetadata?(element: HTMLElement): IResourceHeaderMetadata;

	/** Controls the outer multi-diff scroller for compact embedded hosts. */
	readonly horizontalScrollbar?: 'auto' | 'hidden';

	/**
	 * External host for the inner editors' overflowing widgets (hover,
	 * definition). Embedded hosts whose ancestors clip or re-anchor
	 * position: fixed content supply a node outside that subtree.
	 */
	readonly overflowWidgetsDomNode?: HTMLElement;

	/**
	 * Confines the widget's scroll space to a window of its content.
	 * Windowed embeds keep alignment view zones for hidden content in
	 * their content height; the range makes scrollTop 0 the window's start
	 * and the scroll extent exactly the window, so wheel release,
	 * clamping, and scrollbar visibility are all computed against
	 * reachable content only. Assumes a single-item widget: reveal() of an
	 * item outside the range clamps to the nearest bound.
	 */
	readonly scrollRange?: IObservable<{ readonly start: number; readonly endExclusive: number } | undefined>;
	readonly hideResourceHeader?: boolean;
	readonly codeEditorWidgetOptions?: IDiffCodeEditorWidgetOptions;

	/**
	 * When true, the entire header area is clickable to toggle collapse/expand
	 * and receives keyboard activation (Enter/Space) and ARIA button semantics.
	 */
	readonly headerClickToCollapse?: boolean;
}

export interface IResourceHeaderMetadata extends IDisposable {
	setUris(uris: {
		readonly original: URI | undefined;
		readonly modified: URI | undefined;
	} | undefined): void;
}

export interface IResourceLabel extends IDisposable {
	setUri(uri: URI | undefined, options?: IResourceLabelOptions): void;
	setLabel?(name: string, description?: string, resource?: URI, options?: IResourceLabelOptions): void;
}

export interface IResourceLabelOptions {
	strikethrough?: boolean;
}
