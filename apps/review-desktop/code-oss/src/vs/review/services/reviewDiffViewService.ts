/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from "../../base/common/event.js";
import { Disposable, DisposableStore } from "../../base/common/lifecycle.js";
import type { URI } from "../../base/common/uri.js";
import type { ICodeEditor } from "../../editor/browser/editorBrowser.js";
import type { IMultiDiffEditorViewState } from "../../editor/browser/widget/multiDiffEditor/multiDiffEditorWidgetImpl.js";
import { IConfigurationService } from "../../platform/configuration/common/configuration.js";
import { IInstantiationService } from "../../platform/instantiation/common/instantiation.js";
import { REVIEW_STRUCTURAL_DIFF_SETTING } from "../common/reviewConfigurationDefaults.js";
import type {
	ReviewCommitScope,
	ReviewDiffFileWire,
	ReviewDiffViewHandle,
	ReviewDiffViewSpec,
} from "../common/reviewProtocol.js";
import { ReviewDiffLayoutSetting } from "./reviewDiffLayout.js";
import { markReviewEmbeddedEditor } from "./reviewEmbeddedNavigation.js";
import { ReviewFilesDiffView, ReviewFilesEditorInput, type ReviewFilesEditorEntry } from "./reviewFilesDiffView.js";
import type { ReviewInlineEditorService } from "./reviewInlineEditorService.js";

import { prepareStructuralReview } from "./reviewStructuralDiff.js";

export interface ReviewDiffViewSource {
	load(scope?: ReviewCommitScope): Promise<{ sourceUri: URI; entries: readonly ReviewFilesEditorEntry[] ;
		structuralDiff?: (signal: AbortSignal) => Promise<Response>;
	}>;
	files(scope?: ReviewCommitScope): Promise<readonly ReviewDiffFileWire[]>;
}

/**
 * Mounts the changed-files diff UI inside the Review canvas. One instance
 * belongs to one canvas pane, so its view-state cache and its live handles
 * follow that pane's lifetime.
 */
export class ReviewDiffViewService extends Disposable {
	private overflowWidgetsDomNode: HTMLElement | undefined;
	private readonly handles = new Set<DiffViewHandle>();
	readonly diffLayout: ReviewDiffLayoutSetting;
	/**
	 * Scroll and expansion state per session document. The Diff view is a
	 * conditionally rendered React sibling: a toggle away disposes the widget,
	 * so the state must survive outside it.
	 */
	private readonly viewStates = new Map<string, IMultiDiffEditorViewState>();

	constructor(
		private readonly inlineEditors: ReviewInlineEditorService,
		@IInstantiationService
		private readonly instantiationService: IInstantiationService,
	) {
		super();
		this.diffLayout = this._register(instantiationService.createInstance(ReviewDiffLayoutSetting));
	}

	setOverflowWidgetsDomNode(node: HTMLElement): void {
		this.overflowWidgetsDomNode = node;
	}

	create(spec: ReviewDiffViewSpec, source: ReviewDiffViewSource): ReviewDiffViewHandle {
		const handle = new DiffViewHandle(
			spec,
			this.instantiationService,
			this.inlineEditors,
			this.overflowWidgetsDomNode,
			this.diffLayout,
			this.viewStates,
			() => this.handles.delete(handle),
			source,
		);
		this.handles.add(handle);
		return handle;
	}

	reset(): void {
		for (const handle of [...this.handles]) handle.dispose();
		this.handles.clear();
		this.viewStates.clear();
	}

	toggleRenderSideBySide(): void {
		void this.diffLayout.toggle();
	}
}

class DiffViewHandle extends Disposable implements ReviewDiffViewHandle {
	private readonly _onDidError = this._register(new Emitter<string>());
	readonly onDidError = this._onDidError.event;
	private readonly activeControlStore = this._register(new DisposableStore());
	private view: ReviewFilesDiffView | undefined;
	private viewStateKey: string | undefined;
	private adoptedEditors: readonly ICodeEditor[] = [];
	private disposed = false;

	constructor(
		private readonly spec: ReviewDiffViewSpec,
		private readonly instantiationService: IInstantiationService,
		private readonly inlineEditors: ReviewInlineEditorService,
		private readonly overflowWidgetsDomNode: HTMLElement | undefined,
		private readonly diffLayout: ReviewDiffLayoutSetting,
		private readonly viewStates: Map<string, IMultiDiffEditorViewState>,
		private readonly onDispose: () => void,
		private readonly source: ReviewDiffViewSource,
	) {
		super();
		void this.initialize();
	}

	focus(): void {
		this.view?.focus();
	}

	override dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.captureViewState();
		// A view toggle disposes these editors. The composite must not keep one
		// of them as its active editor afterwards.
		for (const editor of this.adoptedEditors) {
			this.inlineEditors.clearExternalActiveEditor(editor);
		}
		this.adoptedEditors = [];
		this.view = undefined;
		super.dispose();
		this.onDispose();
	}

	private async initialize(): Promise<void> {
		try {
			const data = await this.source.load(this.spec.scope);
			const { sourceUri, entries } = data;
			const structuralEnabled = this.instantiationService.invokeFunction(
				(a) =>
					a
						.get(IConfigurationService)
						.getValue<boolean>(REVIEW_STRUCTURAL_DIFF_SETTING) === true,
			);
			this.viewStateKey = `${sourceUri.toString()}:${structuralEnabled}`;
			if (this.disposed) return;
			if (structuralEnabled && !data.structuralDiff) throw new Error("Structural diffs are unavailable for this source.");
			const store = this._register(new DisposableStore());
			const structural = structuralEnabled
				? await prepareStructuralReview(
						this.instantiationService,
						entries,
						store,
						data.structuralDiff!,
					)
				: {
						instantiation: this.instantiationService,
						entries,
						enabled: false,
						load: undefined,
						onDidChangeCounts: undefined,
					};
			if (this.disposed) return;
			// The input owns the text-model references its view model resolves, so
			// this handle disposes it alongside the view.
			const input = store.add(structural.instantiation.createInstance(ReviewFilesEditorInput, sourceUri, structural.entries,
					structural.enabled));
			const view = store.add(
				structural.instantiation.createInstance(
					ReviewFilesDiffView,
					this.spec.container,
					this.overflowWidgetsDomNode,
					this.diffLayout,
				),
			);
			this.view = view;
			if (structural.enabled) view.startLoading(structural.entries);
			store.add(view.onDidChangeActiveControl(() => this.bindActiveControl(view)));
			// A saved whole-list offset cannot be restored into a partial streamed list.
			await view.setInput(input, structural.enabled ? undefined : this.viewStates.get(this.viewStateKey),
			);
			if (this.disposed) return;
			this.bindActiveControl(view);
		if (structural.load) {
				store.add(
					structural.onDidChangeCounts(({ path, counts }) => {
						if (!this.disposed) view.fileCounts(path, counts);
					}),
				);
				void structural
					.load((path, outcome) => {
						if (this.disposed) return;
						if (outcome.hidden !== undefined)
							view.hideFile(path, outcome.hidden);
						view.fileLoaded(path, outcome.error, outcome.stats);
					})
					.catch((error) => {
						if (!this.disposed)
							view.loadingFailed(
								error instanceof Error ? error.message : String(error),
							);
					});
			}
		} catch (error) {
			if (this.disposed) return;
			this._onDidError.fire(error instanceof Error ? error.message : String(error));
		}
	}

	/**
	 * Joins the embedded diff's inner editors to the canvas composite. Find and
	 * the editor context keys act on the composite's active editor, so a focused
	 * inner editor has to become that editor.
	 */
	private bindActiveControl(view: ReviewFilesDiffView): void {
		this.activeControlStore.clear();
		const diffEditor = view.getActiveControl();
		if (!diffEditor) return;
		const editors: readonly ICodeEditor[] = [diffEditor.getOriginalEditor(), diffEditor.getModifiedEditor(),
		];
		this.adoptedEditors = editors;
		for (const editor of editors) {
			this.activeControlStore.add(markReviewEmbeddedEditor(editor));
			this.activeControlStore.add(
				editor.onDidFocusEditorText(() => this.inlineEditors.setExternalActiveEditor(editor)),
			);
		}
	}

	private captureViewState(): void {
		const key = this.viewStateKey;
		const state = this.view?.getViewState();
		if (!key || !state) return;
		this.viewStates.set(key, state);
	}
}
