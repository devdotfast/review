/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { addDisposableListener, EventType, h } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { autorun, type IObservable } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { createActionViewItem } from '../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { MenuWorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { MenuId } from '../../../../platform/actions/common/actions.js';
import { IContextKeyService, type IScopedContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import type { IDocumentDiffItem } from './model.js';
import { ActionRunnerWithContext } from './utils.js';
import type { IWorkbenchUIElementFactory } from './workbenchUIElementFactory.js';

export const MULTI_DIFF_RESOURCE_HEADER_HEIGHT = 40;

export interface IMultiDiffEditorResourceHeaderData {
	readonly originalLabelUri: URI | undefined;
	readonly modifiedLabelUri: URI | undefined;
	readonly originalUri: URI | undefined;
	readonly modifiedUri: URI | undefined;
	readonly label?: IDocumentDiffItem['label'];
}

/**
 * The native resource header shared by multi-diff entries and embedded editor
 * hosts. Callers provide the content engine; this class owns the identity,
 * state, actions, collapse affordance, and accessibility of its header.
 */
export class MultiDiffEditorResourceHeader extends Disposable {
	private readonly _elements;
	private readonly _resourceLabel;
	private readonly _resourceLabel2;
	private readonly _resourceHeaderMetadata;
	private _data: IMultiDiffEditorResourceHeaderData | undefined;

	readonly element: HTMLElement;
	readonly actionsElement: HTMLElement;
	readonly contextKeyService: IScopedContextKeyService;
	readonly height: number;

	constructor(
		container: HTMLElement,
		private readonly _workbenchUIElementFactory: IWorkbenchUIElementFactory,
		collapsed: IObservable<boolean | undefined>,
		toggleCollapsed: () => void,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IContextKeyService parentContextKeyService: IContextKeyService,
	) {
		super();
		this._elements = h('div.header@header', [
			h('div.header-content', [
				h('div.collapse-button@collapseButton'),
				h('div.file-path', [
					// eslint-disable-next-line local/code-no-any-casts, @typescript-eslint/no-explicit-any
					h('div.title.modified.show-file-icons@primaryPath', [] as any),
					h('div.status.deleted@status', ['R']),
					// eslint-disable-next-line local/code-no-any-casts, @typescript-eslint/no-explicit-any
					h('div.title.original.show-file-icons@secondaryPath', [] as any),
				]),
				h('div.header-metadata@headerMetadata'),
				h('div.actions@actions'),
			]),
		]) as Record<string, HTMLElement>;
		this.element = this._elements.header;
		this.actionsElement = this._elements.actions;
		container.appendChild(this.element);

		this._resourceLabel = this._workbenchUIElementFactory.createResourceLabel
			? this._register(this._workbenchUIElementFactory.createResourceLabel(this._elements.primaryPath))
			: undefined;
		this._resourceLabel2 = this._workbenchUIElementFactory.createResourceLabel
			? this._register(this._workbenchUIElementFactory.createResourceLabel(this._elements.secondaryPath))
			: undefined;
		this._resourceHeaderMetadata = this._workbenchUIElementFactory.createResourceHeaderMetadata
			? this._register(this._workbenchUIElementFactory.createResourceHeaderMetadata(this._elements.headerMetadata))
			: undefined;

		this.height = this._workbenchUIElementFactory.hideResourceHeader ? 0 : MULTI_DIFF_RESOURCE_HEADER_HEIGHT;
		if (this._workbenchUIElementFactory.hideResourceHeader) {
			this.element.style.display = 'none';
		}

		const collapseButton = this._register(new Button(this._elements.collapseButton, {}));
		this._register(autorun(reader => {
			collapseButton.element.className = '';
			collapseButton.icon = collapsed.read(reader) ? Codicon.chevronRight : Codicon.chevronDown;
		}));
		this._register(collapseButton.onDidClick(toggleCollapsed));

		if (!this._workbenchUIElementFactory.hideResourceHeader && this._workbenchUIElementFactory.headerClickToCollapse) {
			this.element.tabIndex = 0;
			this.element.setAttribute('role', 'button');
			this._register(addDisposableListener(this.element, EventType.CLICK, event => {
				const target = event.target;
				if (!(target instanceof Element) || isInteractiveHeaderTarget(target, this.element)) {
					return;
				}
				toggleCollapsed();
			}));
			this._register(addDisposableListener(this.element, EventType.KEY_DOWN, event => {
				if (event.key !== 'Enter' && event.key !== ' ') {
					return;
				}
				const target = event.target;
				if (target instanceof Element && isInteractiveHeaderTarget(target, this.element)) {
					return;
				}
				event.preventDefault();
				toggleCollapsed();
			}));
		}
		this._register(autorun(reader => {
			const isCollapsed = collapsed.read(reader) ?? false;
			if (!this._workbenchUIElementFactory.hideResourceHeader && this._workbenchUIElementFactory.headerClickToCollapse) {
				this.element.setAttribute('aria-expanded', String(!isCollapsed));
			}
		}));

		this.contextKeyService = this._register(parentContextKeyService.createScoped(this.actionsElement));
		const instantiationService = this._register(this._instantiationService.createChild(new ServiceCollection([IContextKeyService, this.contextKeyService])));
		this._register(instantiationService.createInstance(MenuWorkbenchToolBar, this.actionsElement, MenuId.MultiDiffEditorFileToolbar, {
			actionRunner: this._register(new ActionRunnerWithContext(() => this._data?.modifiedUri ?? this._data?.originalUri)),
			highlightToggledItems: true,
			menuOptions: { shouldForwardArgs: true },
			toolbarOptions: { primaryGroup: group => group.startsWith('navigation') },
			actionViewItemProvider: (action, options) => createActionViewItem(instantiationService, action, options),
		}));
	}

	setData(data: IMultiDiffEditorResourceHeaderData | undefined): void {
		this._data = data;
		if (!data) {
			this._resourceLabel?.setUri(undefined);
			this._resourceLabel2?.setUri(undefined);
			this._resourceHeaderMetadata?.setUris(undefined);
			return;
		}

		const { modifiedLabelUri, originalLabelUri, label } = data;
		if (label && this._resourceLabel?.setLabel) {
			this._resourceLabel.setLabel(label.name, label.description, label.resource ?? modifiedLabelUri ?? originalLabelUri);
		} else {
			this._resourceLabel?.setUri(modifiedLabelUri ?? originalLabelUri, { strikethrough: modifiedLabelUri === undefined });
		}

		let isRenamed = false;
		let isDeleted = false;
		let isAdded = false;
		let flag = '';
		if (!label && modifiedLabelUri && originalLabelUri && modifiedLabelUri.path !== originalLabelUri.path) {
			flag = 'R';
			isRenamed = true;
		} else if (!label && !modifiedLabelUri) {
			flag = 'D';
			isDeleted = true;
		} else if (!label && !originalLabelUri) {
			flag = 'A';
			isAdded = true;
		}
		this._elements.status.classList.toggle('renamed', isRenamed);
		this._elements.status.classList.toggle('deleted', isDeleted);
		this._elements.status.classList.toggle('added', isAdded);
		this._elements.status.innerText = flag;
		this._resourceLabel2?.setUri(!label && isRenamed ? originalLabelUri : undefined, { strikethrough: true });
		this._resourceHeaderMetadata?.setUris({
			original: data.originalUri,
			modified: data.modifiedUri,
		});
	}
}

function isInteractiveHeaderTarget(target: Element, header: HTMLElement): boolean {
	const interactive = target.closest('.actions, .collapse-button, button, a, input, select, textarea, [role="button"]');
	return interactive !== null && interactive !== header;
}
