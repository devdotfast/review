/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event, IValueWithChangeEvent } from '../../../../base/common/event.js';
import { RefCounted } from '../diffEditor/utils.js';
import { IDiffEditorOptions } from '../../../common/config/editorOptions.js';
import { ITextModel } from '../../../common/model.js';
import { ContextKeyValue } from '../../../../platform/contextkey/common/contextkey.js';
import { URI } from '../../../../base/common/uri.js';

export interface IMultiDiffEditorModel {
	readonly documents: IValueWithChangeEvent<readonly RefCounted<IDocumentDiffItem>[] | 'loading'>;
	readonly contextKeys?: Record<string, ContextKeyValue>;
}

export interface IDocumentDiffItem {
	/**
	 * undefined if the file was created.
	 */
	readonly original: ITextModel | undefined;

	/**
	 * undefined if the file was deleted.
	 */
	readonly modified: ITextModel | undefined;
	/**
	 * Optional user-facing identities for the two sides. These let a host keep
	 * model URIs optimized for content providers and language services without
	 * leaking those backing resources into the multi-diff header.
	 */
	readonly labelUris?: {
		readonly original: URI | undefined;
		readonly modified: URI | undefined;
	};
	/** Optional semantic headline used by compact embedded diff surfaces. */
	readonly label?: {
		readonly name: string;
		readonly description?: string;
		readonly resource?: URI;
	};
	readonly options?: IDiffEditorOptions;
	readonly onOptionsDidChange?: Event<void>;
	readonly contextKeys?: Record<string, ContextKeyValue>;
}
