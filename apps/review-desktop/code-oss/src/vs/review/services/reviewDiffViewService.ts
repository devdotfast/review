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

import { createStructuralDiffEditors } from "./reviewStructuralDiff.js";
import { StructuralDiffSession } from "./reviewStructuralDiffSession.js";
import type { StructuralDiffStream } from "./reviewStructuralDiffClient.js";
import { structuralInitialCounts } from "../common/reviewStructuralDiff.js";

export interface ReviewDiffViewSource {
	load(scope?: ReviewCommitScope): Promise<{
		sourceUri: URI; entries: readonly ReviewFilesEditorEntry[];
		session?: StructuralDiffSession;
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
	private readonly handles = new Set<DiffViewController>();
	comparisonGeneration = 0;
	private readonly sessions = new Map<string, StructuralDiffSession>();
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

	/** Shared by every view of this comparison; reset/dispose follows the canvas lifetime. */
	openComparison(key: string, client: StructuralDiffStream, generation: number): StructuralDiffSession | undefined {
		if (generation !== this.comparisonGeneration) return undefined;
		if (!this.instantiationService.invokeFunction(a => a.get(IConfigurationService).getValue<boolean>(REVIEW_STRUCTURAL_DIFF_SETTING) === true)) return undefined;
		let session = this.sessions.get(key);
		if (!session) {
			session = new StructuralDiffSession(client);
			this.sessions.set(key, session);
			void session.start();
		}
		return session;
	}

	override dispose(): void { this.reset(); super.dispose(); }

	setOverflowWidgetsDomNode(node: HTMLElement): void {
		this.overflowWidgetsDomNode = node;
	}

	create(spec: ReviewDiffViewSpec, source: ReviewDiffViewSource): ReviewDiffViewHandle {
		const handle = new DiffViewController(
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
		this.comparisonGeneration++;
		for (const handle of [...this.handles]) handle.dispose();
		this.handles.clear();
		this.viewStates.clear();
		for (const session of this.sessions.values()) session.dispose();
		this.sessions.clear();
	}

	toggleRenderSideBySide(): void {
		void this.diffLayout.toggle();
	}
}

class DiffViewController extends Disposable implements ReviewDiffViewHandle {
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
			const session = data.session;
			const structuralEnabled = session !== undefined;
			this.viewStateKey = `${sourceUri.toString()}:${structuralEnabled}`;
			if (this.disposed) return;
			const store = this._register(new DisposableStore());
			const structural = session ? createStructuralDiffEditors(this.instantiationService, entries, store, session)
				: { instantiation: this.instantiationService, entries };

			if (this.disposed) return;
			// The input owns the text-model references its view model resolves, so
			// this handle disposes it alongside the view.
			const input = store.add(structural.instantiation.createInstance(ReviewFilesEditorInput, sourceUri, structural.entries,
				structuralEnabled));
			const view = store.add(
				structural.instantiation.createInstance(
					ReviewFilesDiffView,
					this.spec.container,
					this.overflowWidgetsDomNode,
					this.diffLayout,
				),
			);
			this.view = view;
			if (structuralEnabled) view.startLoading(structural.entries);
			store.add(view.onDidChangeActiveControl(() => this.bindActiveControl(view)));
			// A saved whole-list offset cannot be restored into a partial streamed list.
			await view.setInput(input, structuralEnabled ? undefined : this.viewStates.get(this.viewStateKey),
			);
			if (this.disposed) return;
			this.bindActiveControl(view);
			if (session) this.observeSession(session, structural.entries, view, store);

		} catch (error) {
			if (this.disposed) return;
			this._onDidError.fire(error instanceof Error ? error.message : String(error));
		}
	}

	private observeSession(session: StructuralDiffSession, entries: readonly ReviewFilesEditorEntry[], view: ReviewFilesDiffView, store: DisposableStore): void {
		const rendered = new Set<string>();
		const renderCurrentState = () => {
			if (this.disposed) return;
			for (const entry of entries) {
				const path = entry.file.path;
				const result = session.getFileResult(path);
				if (!result || rendered.has(path)) continue;
				rendered.add(path);
				if (result.hidden !== undefined) view.hideFile(path, result.hidden);
				if (result.diff?.type === "text") view.fileCounts(path, structuralInitialCounts(result.diff));
				view.fileLoaded(path, result.error);
			}
			if (session.error) view.loadingFailed(session.error);
			else if (session.complete) view.loadingFailed("diffr did not supply a result for this file.");
		};
		store.add(session.onDidChange(renderCurrentState));
		renderCurrentState();
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
