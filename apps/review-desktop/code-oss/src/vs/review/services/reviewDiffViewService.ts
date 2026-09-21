import { orderReviewDiffFiles } from "../common/reviewChangedFilesModel.js";
import { CancellationToken } from "../../base/common/cancellation.js";
import { Range } from "../../editor/common/core/range.js";
import { USUAL_WORD_SEPARATORS } from "../../editor/common/core/wordHelper.js";
import { ITextModelService } from "../../editor/common/services/resolverService.js";
import { IDiffProviderFactoryService } from "../../editor/browser/widget/diffEditor/diffProviderFactoryService.js";
import { alignmentRows } from "../common/reviewLens.js";
import type { ReviewInlineEditorSpec, ReviewInlineEditorHandle, ReviewFindQuery } from "../common/reviewProtocol.js";
import { structuralChangeCounts } from "../common/reviewProtocol.js";
import type { ReviewDiffProgress, ReviewDiffViewport } from "../common/reviewProtocol.js";
import { lensRanges, withLens } from "./reviewLens.js";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from "../../base/common/event.js";
import { Disposable, DisposableStore, isDisposable } from "../../base/common/lifecycle.js";
import type { URI } from "../../base/common/uri.js";
import type { ICodeEditor } from "../../editor/browser/editorBrowser.js";
import type { IMultiDiffEditorViewState } from "../../editor/browser/widget/multiDiffEditor/multiDiffEditorWidgetImpl.js";
import { IConfigurationService } from "../../platform/configuration/common/configuration.js";
import { IInstantiationService } from "../../platform/instantiation/common/instantiation.js";
import { REVIEW_STRUCTURAL_DIFF_SETTING } from "../common/reviewConfigurationDefaults.js";
import type {
	ReviewCommitScope,
	ReviewDiffLens,
	ReviewDiffFileWire,
	ReviewDiffViewHandle,
	ReviewDiffViewSpec,
} from "../common/reviewProtocol.js";
import { ReviewDiffLayoutSetting } from "./reviewDiffLayout.js";
import { markReviewEmbeddedEditor } from "./reviewEmbeddedNavigation.js";
import { ReviewFilesDiffView, ReviewFilesEditorInput, type ReviewFilesEditorEntry } from "./reviewFilesDiffView.js";
import { ReviewEmbeddedEditors } from "./reviewEmbeddedEditors.js";

import { createStructuralDiffEditors } from "./reviewStructuralDiff.js";
import { StructuralDiffSession } from "./reviewStructuralDiffSession.js";
import type { StructuralDiffStream } from "./reviewStructuralDiffClient.js";

export interface ReviewDiffViewSource {
	load(scope?: ReviewCommitScope, lens?: ReviewDiffLens): Promise<{
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
		private readonly inlineEditors: ReviewEmbeddedEditors,
		@IInstantiationService
		private readonly instantiationService: IInstantiationService,
	) {
		super();
		this.diffLayout = this._register(instantiationService.createInstance(ReviewDiffLayoutSetting));
	}

	get structuralRenderingEnabled(): boolean {
		return this.instantiationService.invokeFunction(a => a.get(IConfigurationService).getValue<boolean>(REVIEW_STRUCTURAL_DIFF_SETTING) === true);
	}

	/** Shared by every view of this comparison; reset/dispose follows the canvas lifetime. */
	openComparison(key: string, client: StructuralDiffStream, generation: number): StructuralDiffSession | undefined {
		if (generation !== this.comparisonGeneration || !this.structuralRenderingEnabled) return undefined;
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

	/** Document peeks use the same controller, providers and widget as the Diff tab. */
	createDocument(spec: ReviewInlineEditorSpec, lens: ReviewDiffLens, source: ReviewDiffViewSource): ReviewInlineEditorHandle {
		const lifetime = new DisposableStore();
		const heightChanged = lifetime.add(new Emitter<number>());
		let height = 400;
		let generation = 0;
		let matches: DocumentMatch[] = [];
		const view = this.create({
			container: spec.container, lens, progress: spec.progress,
			document: {
				heightMode: spec.heightMode,
				onDidChangeHeight: value => { height = value; heightChanged.fire(value); },
				onDidFocus: spec.onDidFocus, onDidOpen: spec.onDidOpen,
			},
		}, source) as DiffViewController;
		lifetime.add(view);
		return {
			get height() { return height; },
			setProgress: progress => view.setProgress(progress),
			onDidChangeHeight: heightChanged.event,
			onDidError: view.onDidError,
			setActive: active => spec.container.classList.toggle("review-document-code-active", active),
			setCollapsed: collapsed => view.setCollapsed(collapsed),
			setFindQuery: async query => {
				const request = ++generation;
				const result = await this.findDocument(lens, source, query);
				if (lifetime.isDisposed || request !== generation) return { matchCount: 0 };
				matches = result;
				view.decorateMatches(matches);
				return { matchCount: matches.length };
			},
			revealFindMatch: index => {
				const match = matches[index];
				if (!match) return;
				view.setCollapsed(false);
				view.revealSource({ file: match.file, side: match.side, fromLine: match.range.startLineNumber, toLine: match.range.endLineNumber });
				view.decorateMatches(matches, index);
			},
			clearActiveFindMatch: () => view.decorateMatches(matches),
			clearFind: () => { generation++; matches = []; view.decorateMatches([]); },
			dispose: () => { generation++; lifetime.dispose(); },
		};
	}

	/** Search pinned models through the same diff provider; no synthetic text/model is built. */
	async findDocument(lens: ReviewDiffLens, source: ReviewDiffViewSource, query: ReviewFindQuery): Promise<DocumentMatch[]> {
		if (!query.text) return [];
		const lifetime = new DisposableStore();
		try {
			const data = await source.load(undefined, lens);
			const entries = data.entries.filter(entry => lensRanges(lens, entry).length > 0);
			const structural = data.session ? createStructuralDiffEditors(this.instantiationService, entries, lifetime, data.session)
				: { instantiation: this.instantiationService, entries };
			const instantiation = withLens(structural.instantiation, structural.entries, lens, lifetime, () => undefined, () => ({ dispose() {} }));
			const resolver = instantiation.invokeFunction(a => a.get(ITextModelService));
			const factory = instantiation.invokeFunction(a => a.get(IDiffProviderFactoryService));
			const matches: DocumentMatch[] = [];
			for (const entry of structural.entries) {
				const original = entry.original ? lifetime.add(await resolver.createModelReference(entry.original)).object.textEditorModel : undefined;
				const modified = entry.modified ? lifetime.add(await resolver.createModelReference(entry.modified)).object.textEditorModel : undefined;
				const provider = factory.createDiffProvider({ diffAlgorithm: "advanced" });
				if (isDisposable(provider)) lifetime.add(provider);
				const diff = original && modified ? await provider.computeDiff(original, modified, { ignoreTrimWhitespace: false, maxComputationTimeMs: 0, computeMoves: false }, CancellationToken.None) : undefined;
				const pairs = diff && original && modified ? new Map(alignmentRows(diff, original.getLineCount(), modified.getLineCount()).filter((row): row is [number, number] => row[0] !== null && row[1] !== null)) : new Map<number, number>();
				for (const [side, model] of [["base", original], ["head", modified]] as const) {
					if (!model) continue;
					const ranges = lensRanges(lens, entry).filter(range => range.side === side);
					const found = model.findMatches(query.text, false, query.isRegex, query.matchCase, query.wholeWord ? USUAL_WORD_SEPARATORS : null, false);
					for (const match of found) {
						const line = match.range.startLineNumber;
						const outside = diff?.contextGaps?.some(gap => gap.label === "Outside lens" && line >= (side === "base" ? gap.originalStart : gap.modifiedStart) && line < (side === "base" ? gap.originalStart + gap.originalCount : gap.modifiedStart + gap.modifiedCount));
						if (outside || (!diff && !ranges.some(range => line >= range.fromLine && line <= range.toLine))) continue;
						const headLine = pairs.get(line - 1);
						if (side === "base" && headLine !== undefined && modified && match.range.startLineNumber === match.range.endLineNumber && model.getLineContent(line) === modified.getLineContent(headLine + 1)) continue;
						matches.push({ file: side === "base" ? entry.file.previousPath ?? entry.file.path : entry.file.path, side, range: match.range });
					}
				}
			}
			return matches;
		} finally { lifetime.dispose(); }
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

interface DocumentMatch {
	file: string;
	side: "base" | "head";
	range: Range;
}

class DiffViewController extends Disposable implements ReviewDiffViewHandle {
	private readonly _onDidError = this._register(new Emitter<string>());
	readonly onDidError = this._onDidError.event;
	private readonly activeControlStore = this._register(new DisposableStore());
	private view: ReviewFilesDiffView | undefined;
	private progress: ReviewDiffProgress | undefined;
	private readonly progressChanged = this._register(new Emitter<void>());
	private pendingSectionId: string | undefined;
	private pendingSource: ReviewDiffLens['ranges'][number] | undefined;
	setProgress(progress: ReviewDiffProgress): void { this.progress = progress; this.view?.setProgress(progress); this.progressChanged.fire(); }
	revealSource(source: ReviewDiffLens['ranges'][number], sectionId?: string): void { this.pendingSource = source; this.pendingSectionId = sectionId; this.view?.revealSource(source, sectionId); }
	private readonly _onDidScroll = this._register(new Emitter<ReviewDiffViewport>());
	readonly onDidScroll = this._onDidScroll.event;
	sourceOffset(source: ReviewDiffLens['ranges'][number]): number | undefined { return this.view?.sourceOffset(source); }
	private viewStateKey: string | undefined;
	private adoptedEditors: readonly ICodeEditor[] = [];
	private disposed = false;
	private collapsed = false;
	private matches: DocumentMatch[] = [];
	private activeMatch: number | undefined;
	private readonly findDecorations = this._register(new DisposableStore());
	setCollapsed(collapsed: boolean): void { this.collapsed = collapsed; this.view?.setCollapsed(collapsed); }
	decorateMatches(matches: DocumentMatch[], active?: number): void {
		this.matches = matches; this.activeMatch = active;
		this.findDecorations.clear();
		const control = this.view?.getActiveControl();
		if (!control) return;
		for (const [side, editor] of [["base", control.getOriginalEditor()], ["head", control.getModifiedEditor()]] as const) {
			const collection = editor.createDecorationsCollection(matches.flatMap((match, index) => match.side === side ? [{ range: match.range, options: { description: "review-document-find", className: index === active ? "currentFindMatch" : "findMatch" } }] : []));
			this.findDecorations.add({ dispose: () => collection.clear() });
		}
	}

	constructor(
		private readonly spec: ReviewDiffViewSpec,
		private readonly instantiationService: IInstantiationService,
		private readonly inlineEditors: ReviewEmbeddedEditors,
		private readonly overflowWidgetsDomNode: HTMLElement | undefined,
		private readonly diffLayout: ReviewDiffLayoutSetting,
		private readonly viewStates: Map<string, IMultiDiffEditorViewState>,
		private readonly onDispose: () => void,
		private readonly source: ReviewDiffViewSource,
	) {
		super();
		this.progress = spec.progress;
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
			const data = await this.source.load(this.spec.scope, this.spec.lens);
			const { sourceUri, entries } = data;
			const session = data.session;
			const structuralEnabled = session !== undefined && this.instantiationService.invokeFunction(a => a.get(IConfigurationService).getValue<boolean>(REVIEW_STRUCTURAL_DIFF_SETTING) === true);
			this.viewStateKey = `${sourceUri.toString()}:${structuralEnabled}:${JSON.stringify(this.spec.lens ?? null)}`;
			if (this.disposed) return;
			const store = this._register(new DisposableStore());
			const structural = session && structuralEnabled ? createStructuralDiffEditors(this.instantiationService, entries, store, session)
				: { instantiation: this.instantiationService, entries };

			if (this.disposed) return;
			const lens = this.spec.lens;
			const sections = this.progress?.sections;
			let selected = lens && sections?.length ? sections.flatMap(section => {
				const matches = structural.entries.filter(entry => lensRanges({ ...lens, ranges: section.sources }, entry).length > 0);
				return matches.map((entry, index) => ({ ...entry, sectionId: section.id, sectionStart: index === 0, original: entry.original?.with({ fragment: section.id }), modified: entry.modified?.with({ fragment: section.id }) }));
			}) : lens ? structural.entries.filter(entry => lensRanges(lens, entry).length > 0) : structural.entries;
			// File lenses have no authored sections; follow the same order as their file tree.
			if (lens && !sections?.length) {
				const byFile = new Map(selected.map(entry => [entry.file, entry]));
				selected = orderReviewDiffFiles([...byFile.keys()]).map(file => byFile.get(file)!);
			}
			const instantiation = withLens(structural.instantiation, selected, lens, store, () => this.progress, this.progressChanged.event);
			// The input owns the text-model references its view model resolves, so
			// this handle disposes it alongside the view.
			const input = store.add(instantiation.createInstance(ReviewFilesEditorInput, sourceUri, selected,
				structuralEnabled, !!lens || !!this.spec.onToggleViewed));
			const view = store.add(
				instantiation.createInstance(
					ReviewFilesDiffView,
					this.spec.container,
					this.overflowWidgetsDomNode,
					this.diffLayout,
					this.spec.fileTreeContainer, this.spec.onToggleViewed, this.spec.onToggleSection, this.spec.document,
				),
			);
			this.view = view;
			if (this.progress) view.setProgress(this.progress);
			if (structuralEnabled) view.startLoading(selected);
			store.add(view.onDidChangeActiveControl(() => this.bindActiveControl(view)));
			store.add(view.onDidScroll(() => this._onDidScroll.fire({ height: view.viewportHeight })));
			// A saved whole-list offset cannot be restored into a partial streamed list.
			await view.setInput(input, structuralEnabled ? undefined : this.viewStates.get(this.viewStateKey),
			);
			if (this.disposed) return;
			this.bindActiveControl(view);
			view.setCollapsed(this.collapsed);
			if (this.pendingSource) view.revealSource(this.pendingSource, this.pendingSectionId);
			if (!session) for (const entry of selected) view.fileCounts(entry.file.path, { added: entry.file.additions, removed: entry.file.deletions });
			if (session) this.observeSession(session, selected, view, store, structuralEnabled);

		} catch (error) {
			if (this.disposed) return;
			this._onDidError.fire(error instanceof Error ? error.message : String(error));
		}
	}

	private observeSession(session: StructuralDiffSession, entries: readonly ReviewFilesEditorEntry[], view: ReviewFilesDiffView, store: DisposableStore, structuralEnabled: boolean): void {
		const rendered = new Set<string>();
		const annotationWarnings = new Set<string>();
		const renderCurrentState = (change?: import("./reviewStructuralDiffSession.js").StructuralSessionChange) => {
			if (this.disposed) return;
			for (const entry of entries) {
				const path = entry.file.path;
				if (change && !change.files.has(path) && !change.labels.has(path)) continue;
				const result = entry.file.status === "unchanged" ? {} : session.getFileResult(path);
				if (result?.annotationError && !annotationWarnings.has(path)) {
					annotationWarnings.add(path);
					this._onDidError.fire(`Summary unavailable for ${path}: ${result.annotationError}`);
				}
				if (!result || rendered.has(path)) continue;
				rendered.add(path);
				if (structuralEnabled && result.hidden !== undefined) view.hideFile(path, result.hidden);
				if (result.diff) view.fileCounts(path, result.diff.type === "text" ? structuralChangeCounts(result.diff.structural_changes) : { added: 0, removed: 0 });
				if (structuralEnabled) view.fileLoaded(path, result.error);
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
			if (this.spec.document) ReviewEmbeddedEditors.markDocumentEditor(editor);
			this.activeControlStore.add(
				editor.onDidFocusEditorText(() => { this.inlineEditors.setExternalActiveEditor(editor); this.spec.document?.onDidFocus?.(); }),
			);
		}
		this.decorateMatches(this.matches, this.activeMatch);
	}

	private captureViewState(): void {
		const key = this.viewStateKey;
		const state = this.view?.getViewState();
		if (!key || !state) return;
		this.viewStates.set(key, state);
	}
}
