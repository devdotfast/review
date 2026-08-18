/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { h } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { autorun, derived, globalTransaction, IObservable, observableValue } from '../../../../base/common/observable.js';
import { type IScopedContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { EditorContextKeys } from '../../../common/editorContextKeys.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IDiffEditorOptions } from '../../../common/config/editorOptions.js';
import { OffsetRange } from '../../../common/core/ranges/offsetRange.js';
import { observableCodeEditor } from '../../observableCodeEditor.js';
import { DiffEditorWidget } from '../diffEditor/diffEditorWidget.js';
import { MultiDiffEditorResourceHeader } from './multiDiffEditorResourceHeader.js';
import { DocumentDiffItemViewModel } from './multiDiffEditorViewModel.js';
import { IObjectData, IPooledObject } from './objectPool.js';
import { IWorkbenchUIElementFactory } from './workbenchUIElementFactory.js';

export class TemplateData implements IObjectData {
	constructor(
		public readonly viewModel: DocumentDiffItemViewModel,
		public readonly deltaScrollVertical: (delta: number) => void,
	) { }


	getId(): unknown {
		return this.viewModel;
	}
}

export class DiffEditorItemTemplate extends Disposable implements IPooledObject<TemplateData> {
	private readonly _viewModel;

	private readonly _collapsed;

	private readonly _editorContentHeight;
	public readonly contentHeight;

	private readonly _modifiedContentWidth;
	private readonly _modifiedWidth;
	private readonly _originalContentWidth;
	private readonly _originalWidth;

	public readonly maxScroll;

	private readonly _elements;

	public readonly editor;

	private readonly isModifedFocused;
	private readonly isOriginalFocused;
	public readonly isFocused;

	private readonly _resourceHeader;

	private readonly _outerEditorHeight: number;
	private readonly _contextKeyService: IScopedContextKeyService;

	constructor(
		private readonly _container: HTMLElement,
		private readonly _overflowWidgetsDomNode: HTMLElement,
		private readonly _workbenchUIElementFactory: IWorkbenchUIElementFactory,
		private readonly _optionsOverride: IObservable<IDiffEditorOptions> | undefined,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();
		this._viewModel = observableValue<DocumentDiffItemViewModel | undefined>(this, undefined);
		this._collapsed = derived(this, reader => this._viewModel.read(reader)?.collapsed.read(reader));
		this._editorContentHeight = observableValue<number>(this, 500);
		this.contentHeight = derived(this, reader => {
			const h = this._collapsed.read(reader) ? 0 : this._editorContentHeight.read(reader);
			return h + this._outerEditorHeight;
		});
		this._modifiedContentWidth = observableValue<number>(this, 0);
		this._modifiedWidth = observableValue<number>(this, 0);
		this._originalContentWidth = observableValue<number>(this, 0);
		this._originalWidth = observableValue<number>(this, 0);
		this.maxScroll = derived(this, reader => {
			const scroll1 = this._modifiedContentWidth.read(reader) - this._modifiedWidth.read(reader);
			const scroll2 = this._originalContentWidth.read(reader) - this._originalWidth.read(reader);
			if (scroll1 > scroll2) {
				return { maxScroll: scroll1, width: this._modifiedWidth.read(reader) };
			} else {
				return { maxScroll: scroll2, width: this._originalWidth.read(reader) };
			}
		});
		this._elements = h('div.multiDiffEntry', [
			h('div.editorParent@editorParent', [
				h('div.editorContainer@editor'),
			])
		]) as Record<string, HTMLElement>;
		this.editor = this._register(this._instantiationService.createInstance(DiffEditorWidget, this._elements.editor, {
			overflowWidgetsDomNode: this._overflowWidgetsDomNode,
			fixedOverflowWidgets: true
		}, this._workbenchUIElementFactory.codeEditorWidgetOptions ?? {}));
		this.isModifedFocused = observableCodeEditor(this.editor.getModifiedEditor()).isFocused;
		this.isOriginalFocused = observableCodeEditor(this.editor.getOriginalEditor()).isFocused;
		this.isFocused = derived(this, reader => this.isModifedFocused.read(reader) || this.isOriginalFocused.read(reader));
		this._dataStore = this._register(new DisposableStore());
		this._resourceHeader = this._register(this._instantiationService.createInstance(
			MultiDiffEditorResourceHeader,
			this._elements.root,
			this._workbenchUIElementFactory,
			this._collapsed,
			() => this._viewModel.get()?.collapsed.set(!this._collapsed.get(), undefined),
		));
		this._elements.root.insertBefore(this._resourceHeader.element, this._elements.editorParent);
		this._headerHeight = this._resourceHeader.height;
		this._lastScrollTop = -1;
		this._isSettingScrollTop = false;

		this._register(autorun(reader => {
			const collapsed = this._collapsed.read(reader);
			this._elements.editor.style.display = collapsed ? 'none' : 'block';
		}));

		this._register(this.editor.getModifiedEditor().onDidLayoutChange(e => {
			const width = this.editor.getModifiedEditor().getLayoutInfo().contentWidth;
			this._modifiedWidth.set(width, undefined);
		}));

		this._register(this.editor.getOriginalEditor().onDidLayoutChange(e => {
			const width = this.editor.getOriginalEditor().getLayoutInfo().contentWidth;
			this._originalWidth.set(width, undefined);
		}));

		this._register(this.editor.onDidContentSizeChange(e => {
			globalTransaction(tx => {
				this._editorContentHeight.set(e.contentHeight, tx);
				this._modifiedContentWidth.set(this.editor.getModifiedEditor().getContentWidth(), tx);
				this._originalContentWidth.set(this.editor.getOriginalEditor().getContentWidth(), tx);
			});
		}));

		this._register(this.editor.getOriginalEditor().onDidScrollChange(e => {
			if (this._isSettingScrollTop) {
				return;
			}

			if (!e.scrollTopChanged || !this._data) {
				return;
			}
			const delta = e.scrollTop - this._lastScrollTop;
			this._data.deltaScrollVertical(delta);
		}));

		this._register(autorun(reader => {
			const isActive = this._viewModel.read(reader)?.isActive.read(reader);
			this._elements.root.classList.toggle('active', isActive);
		}));

		this._container.appendChild(this._elements.root);
		this._outerEditorHeight = this._headerHeight;

		this._contextKeyService = this._resourceHeader.contextKeyService;
		const ctxAllUnchangedRegionsShown = EditorContextKeys.multiDiffEditorItemAllUnchangedRegionsShown.bindTo(this._contextKeyService);
		this._register(autorun(reader => {
			ctxAllUnchangedRegionsShown.set(this.editor.allUnchangedRegionsShown.read(reader));
		}));
	}

	public setScrollLeft(left: number): void {
		if (this._modifiedContentWidth.get() - this._modifiedWidth.get() > this._originalContentWidth.get() - this._originalWidth.get()) {
			this.editor.getModifiedEditor().setScrollLeft(left);
		} else {
			this.editor.getOriginalEditor().setScrollLeft(left);
		}
	}

	private readonly _dataStore;

	private _data: TemplateData | undefined;

	public setData(data: TemplateData | undefined): void {
		this._data = data;
		const optionsOverride = this._optionsOverride;
		function updateOptions(options: IDiffEditorOptions): IDiffEditorOptions {
			return {
				...options,
				...optionsOverride?.get(),
				scrollBeyondLastLine: false,
				hideUnchangedRegions: options.hideUnchangedRegions ?? {
					enabled: true,
				},
				scrollbar: {
					vertical: 'hidden',
					horizontal: 'hidden',
					handleMouseWheel: false,
					useShadows: false,
				},
				renderOverviewRuler: false,
				fixedOverflowWidgets: true,
				overviewRulerBorder: false,
			};
		}

		if (!data) {
			this._resourceHeader.setData(undefined);
			globalTransaction(tx => {
				this._viewModel.set(undefined, tx);
				this.editor.setDiffModel(null, tx);
				this._dataStore.clear();
			});
			return;
		}

		const value = data.viewModel.documentDiffItem;

		globalTransaction(tx => {
			this._resourceHeader.setData({
				originalLabelUri: data.viewModel.originalLabelUri,
				modifiedLabelUri: data.viewModel.modifiedLabelUri,
				originalUri: data.viewModel.originalUri,
				modifiedUri: data.viewModel.modifiedUri,
				label: value.label,
			});

			this._dataStore.clear();
			this._viewModel.set(data.viewModel, tx);
			this.editor.setDiffModel(data.viewModel.diffEditorViewModelRef, tx);
			this.editor.updateOptions(updateOptions(value.options ?? {}));
		});
		if (value.onOptionsDidChange) {
			this._dataStore.add(value.onOptionsDidChange(() => {
				this.editor.updateOptions(updateOptions(value.options ?? {}));
			}));
		}
		if (optionsOverride) {
			this._dataStore.add(autorun(reader => {
				optionsOverride.read(reader);
				this.editor.updateOptions(updateOptions(value.options ?? {}));
			}));
		}
		data.viewModel.isAlive.recomputeInitiallyAndOnChange(this._dataStore, value => {
			if (!value) {
				this.setData(undefined);
			}
		});

		if (data.viewModel.documentDiffItem.contextKeys) {
			for (const [key, value] of Object.entries(data.viewModel.documentDiffItem.contextKeys)) {
				this._contextKeyService.createKey(key, value);
			}
		}
	}

	private readonly _headerHeight;

	private _lastScrollTop;
	private _isSettingScrollTop;

	public render(verticalRange: OffsetRange, width: number, editorScroll: number, viewPort: OffsetRange): void {
		this._elements.root.style.visibility = 'visible';
		this._elements.root.style.top = `${verticalRange.start}px`;
		this._elements.root.style.height = `${verticalRange.length}px`;
		this._elements.root.style.width = `${width}px`;
		this._elements.root.style.position = 'absolute';

		// For sticky scroll
		const maxDelta = verticalRange.length - this._headerHeight;
		const delta = Math.max(0, Math.min(viewPort.start - verticalRange.start, maxDelta));
		this._resourceHeader.element.style.transform = `translateY(${delta}px)`;

		globalTransaction(tx => {
			this.editor.layout({
				width: width - 2 * 8 - 2 * 1,
				height: verticalRange.length - this._outerEditorHeight,
			});
		});
		try {
			this._isSettingScrollTop = true;
			this._lastScrollTop = editorScroll;
			this.editor.getOriginalEditor().setScrollTop(editorScroll);
		} finally {
			this._isSettingScrollTop = false;
		}

		this._resourceHeader.element.classList.toggle('shadow', delta > 0 || editorScroll > 0);
		this._resourceHeader.element.classList.toggle('collapsed', delta === maxDelta);
	}

	public hide(): void {
		this._elements.root.style.top = `-100000px`;
		this._elements.root.style.visibility = 'hidden'; // Some editor parts are still visible
	}
}
