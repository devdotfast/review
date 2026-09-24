import type { ReviewDiffProgress, ReviewDiffLens, ReviewDiffViewSpec } from "../common/reviewProtocol.js";
import { Range } from "../../editor/common/core/range.js";
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import "../browser/media/review.css";
import { $, addDisposableListener, append, Dimension } from "../../base/browser/dom.js";
import { Orientation, SplitView } from "../../base/browser/ui/splitview/splitview.js";
import { Emitter, Event } from "../../base/common/event.js";
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from "../../base/common/lifecycle.js";
import { autorun } from "../../base/common/observable.js";
import { isEqual } from "../../base/common/resources.js";
import { URI } from "../../base/common/uri.js";
import { ElementSizeObserver } from "../../editor/browser/config/elementSizeObserver.js";
import { isDiffEditor, type IDiffEditor } from "../../editor/browser/editorBrowser.js";
import { MultiDiffEditorViewModel } from "../../editor/browser/widget/multiDiffEditor/multiDiffEditorViewModel.js";
import { MultiDiffEditorWidget, type RevealOptions } from "../../editor/browser/widget/multiDiffEditor/multiDiffEditorWidget.js";
import type { IMultiDiffEditorViewState } from "../../editor/browser/widget/multiDiffEditor/multiDiffEditorWidgetImpl.js";
import { IDiffEditorOptions } from "../../editor/common/config/editorOptions.js";
import { ITextModelService } from "../../editor/common/services/resolverService.js";
import { ITextResourceConfigurationService } from "../../editor/common/services/textResourceConfiguration.js";
import { IHoverService } from "../../platform/hover/browser/hover.js";
import { IInstantiationService } from "../../platform/instantiation/common/instantiation.js";
import { MultiDiffEditorInput } from "../../workbench/contrib/multiDiffEditor/browser/multiDiffEditorInput.js";
import {
	IMultiDiffSourceResolverService,
	MultiDiffEditorItem,
} from "../../workbench/contrib/multiDiffEditor/browser/multiDiffSourceResolverService.js";
import { IEditorGroupsService } from "../../workbench/services/editor/common/editorGroupsService.js";
import { IEditorService } from "../../workbench/services/editor/common/editorService.js";
import { ITextFileService } from "../../workbench/services/textfile/common/textfiles.js";
import { ReviewChangedFilesTree } from "../browser/reviewChangedFilesTree.js";
import { REVIEW_COUNTS_PENDING_TOOLTIP, reviewChangesTooltip, reviewCountsTooltip, ReviewTooltip, type ReviewTooltipContent } from "../browser/reviewTooltip.js";
import { type ReviewDiffFileWire, type StructuralLineCounts } from "../common/reviewProtocol.js";
import type { ReviewDiffLayoutSetting } from "./reviewDiffLayout.js";
import { reviewMultiDiffLabelUris, ReviewMultiDiffUIElementFactory } from "./reviewMultiDiff.js";

const FILE_TREE_MINIMUM_WIDTH = 180;
const DIFF_MINIMUM_WIDTH = 320;
const FILE_TREE_COLLAPSE_WIDTH = FILE_TREE_MINIMUM_WIDTH + DIFF_MINIMUM_WIDTH;
const REVIEW_FILES_DIFF_EDITOR_OPTIONS = {
	hideUnchangedRegions: { enabled: true },
	originalEditable: false,
	readOnly: true,
	glyphMargin: false,
	lineNumbersMinChars: 3,
	// A peek or diff on the page is read until it is clicked into; the current
	// line highlight belongs to the cursor, not to the first revealed line.
	renderLineHighlightOnlyWhenFocus: true,
} satisfies IDiffEditorOptions;

export interface ReviewFilesEditorEntry {
	readonly sectionId?: string;
	readonly sectionStart?: boolean;
	readonly file: ReviewDiffFileWire;
	readonly original: URI | undefined;
	readonly modified: URI | undefined;
	readonly goToFileResource: URI;
}

export class ReviewFilesEditorInput extends MultiDiffEditorInput {
	static override readonly ID = "workbench.input.devfast.reviewFiles";
	static readonly EDITOR_ID = "workbench.editor.devfast.reviewFiles";

	private readonly updateResources: (paths: ReadonlySet<string>, loading: boolean) => void;

	setReadyFiles(paths: ReadonlySet<string>, loading: boolean): void {
		this.updateResources(paths, loading);
	}

	constructor(
		source: URI,
		readonly entries: readonly ReviewFilesEditorEntry[],
		readonly structural: boolean = false,
		lens: boolean = false,
		@ITextModelService textModelService: ITextModelService,
		@ITextResourceConfigurationService
		textResourceConfigurationService: ITextResourceConfigurationService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IMultiDiffSourceResolverService
		multiDiffSourceResolverService: IMultiDiffSourceResolverService,
		@ITextFileService textFileService: ITextFileService,
	) {
		const items = entries.map(
				(entry) =>
					new MultiDiffEditorItem(
						entry.original,
						entry.modified,
						entry.goToFileResource,
						undefined,
						undefined,
						reviewMultiDiffLabelUris(entry.file),
					// Every hidden line comes from the one fold model: diffr's regions, never the diff editor's own unchanged-region hiding.
					// Every collapsed region diffr sends is a hidden-region band; the editor's own folding stays off.
					(structural || lens)
						? {
							...REVIEW_FILES_DIFF_EDITOR_OPTIONS,
							hideOriginalLineNumbers: entry.file.status === "added",
							hideUnchangedRegions: {
								enabled: true,
								minimumLineCount: 1,
								contextLineCount: 0,
							},
							folding: false,
							glyphMargin: true,
							experimental: { useTrueInlineView: false },
						}
						: { ...REVIEW_FILES_DIFF_EDITOR_OPTIONS, hideOriginalLineNumbers: entry.file.status === "added" },
					),
		);
		const changes = new Emitter<void>();
		let current: readonly MultiDiffEditorItem[] = [];
		let loading = items.length > 0;
		const streamSource = {
			isLoading: { get value() { return loading; }, onDidChange: changes.event },
			resources: {
				get value() {
					return current;
				},
				onDidChange: changes.event,
			},
		};
		super(
			source,
			"Files",
			structural ? undefined : items,
			true,
			textModelService,
			textResourceConfigurationService,
			instantiationService,
			structural
				? {
					_serviceBrand: undefined,
					registerResolver: (resolver) =>
						multiDiffSourceResolverService.registerResolver(resolver),
					resolve: async () => streamSource,
				}
				: multiDiffSourceResolverService,
			textFileService,
		);
		this._register(changes);
		this.updateResources = (paths, pending) => {
			loading = pending; current = items.filter((_, index) => paths.has(entries[index].file.path));
			changes.fire();
		};
	}

	override get typeId(): string {
		return ReviewFilesEditorInput.ID;
	}

	override get editorId(): string {
		return ReviewFilesEditorInput.EDITOR_ID;
	}
}

/**
 * The changed-files diff UI — a file list beside a multi-diff widget — as a
 * plain widget. It owns no editor pane, so the Review canvas can mount it into
 * a container the app supplies. The container's size drives the layout: the
 * canvas gives the host element its bounds through CSS, not through a pane
 * layout call.
 */
export class ReviewFilesDiffView extends Disposable {
	private readonly _onDidChangeActiveControl = this._register(new Emitter<void>());
	readonly onDidChangeActiveControl = this._onDidChangeActiveControl.event;
	private readonly _onDidScroll = this._register(new Emitter<void>());
	/** The list scrolled or its topmost file changed. */
	readonly onDidScroll = this._onDidScroll.event;
	private readonly diffContainer: HTMLElement;

	private readonly root: HTMLElement;
	private readonly splitView: SplitView<number>;
	private readonly changedFilesTree: ReviewChangedFilesTree | undefined;
	private readonly widget: MultiDiffEditorWidget;
	private viewModel: MultiDiffEditorViewModel | undefined;
	private input: ReviewFilesEditorInput | undefined;
	private readonly readyFiles = new Set<string>();
	private readonly fileStates = new Map<string, string>();
	private readonly revealHold = this._register(new MutableDisposable<DisposableStore>());
	/** Full structural counts for views without persisted coverage. */
	private readonly streamStats = new Map<
		string,
		{ counts: StructuralLineCounts; tooltip: ReviewTooltipContent }
	>();
	private readonly headerFactory: ReviewMultiDiffUIElementFactory;
	private readonly summary: HTMLElement;
	private readonly summaryTooltip: ReviewTooltip;
	/** Files the stream says start hidden, with the reason shown in their header. */
	private readonly hiddenFiles = new Map<string, string>();
	private readonly hiddenApplied = new Set<string>();
	private pendingPath: string | undefined;
	private pendingSectionId: string | undefined;
	private pendingSource: ReviewDiffLens["ranges"][number] | undefined;
	private progress: ReviewDiffProgress | undefined;
	private documentCollapsed = false;
	private readonly initializedDocumentItems = new WeakSet<object>();
	private readonly viewedApplied = new Map<string, string>();
	private readonly streamStatus: HTMLElement;

	constructor(
		private readonly container: HTMLElement,
		overflowWidgetsDomNode: HTMLElement | undefined,
		layout: ReviewDiffLayoutSetting,
		private readonly fileTreeContainer: HTMLElement | undefined,
		private readonly onToggleViewed: ((path: string, sectionId?: string) => void) | undefined,
		private readonly onToggleSection: ((id: string) => void) | undefined,
		private readonly document: ReviewDiffViewSpec["document"],
		@IInstantiationService
		private readonly reviewInstantiationService: IInstantiationService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService
		private readonly editorGroupService: IEditorGroupsService,
		@IHoverService hoverService: IHoverService,
	) {
		super();
		this.root = append(container, $(".review-files-editor"));
		const fileTree = document ? container.ownerDocument.createElement("div") : append(this.fileTreeContainer ?? this.root, $(".review-files-editor-tree"));
		const diffContainer = append(this.root, $(".review-files-editor-diffs"));
		this.diffContainer = diffContainer;
		if (document) fileTree.hidden = true;

		const factory = this.reviewInstantiationService.createInstance(
			ReviewMultiDiffUIElementFactory,
			() =>
				this.input
					? this.input.entries.map((entry) => ({
							original: entry.original,
							modified: entry.modified,
							additions: entry.file.status === "unchanged" ? undefined : this.entryProgress(entry)?.remaining.additions ?? (this.fileTreeContainer || this.document ? undefined : this.streamStats.get(entry.file.path)?.counts.added),
							deletions: entry.file.status === "unchanged" ? undefined : this.entryProgress(entry)?.remaining.deletions ?? (this.fileTreeContainer || this.document ? undefined : this.streamStats.get(entry.file.path)?.counts.removed),
						countsTooltip: this.progressTooltip(entry) ?? this.streamStats.get(entry.file.path)?.tooltip,
						viewedState: this.entryProgress(entry)?.state,
						onToggleViewed: entry.file.status !== "unchanged" && this.onToggleViewed ? () => this.onToggleViewed!(entry.file.path, entry.sectionId) : undefined,
						sectionId: entry.sectionId,
						sectionCollapsed: !!entry.sectionId && this.collapsedSections.has(entry.sectionId),
						onToggleSectionCollapsed: () => { if (entry.sectionId) { if (this.collapsedSections.has(entry.sectionId)) this.collapsedSections.delete(entry.sectionId); else this.collapsedSections.add(entry.sectionId); this.headerFactory.refreshHeaders(); } },
						section: entry.sectionStart ? this.progress?.sections?.find(section => section.id === entry.sectionId) : undefined,
						onToggleSection: () => entry.sectionId && this.onToggleSection?.(entry.sectionId),
						note: entry.file.status === "unchanged" ? "Unchanged" : this.hiddenFiles.get(entry.file.path),
							onDidOpen: () => {
								if (document?.onDidOpen) { document.onDidOpen(); return; }
								const target = this.widget.tryGetCodeEditor(entry.goToFileResource);
								const change = isDiffEditor(target?.diffEditor) ? target.diffEditor.getDiffComputationResult()?.changes2[0] : undefined;
								const line = change && (entry.modified ? change.modified : change.original).startLineNumber;
								const selection = line === undefined ? undefined : target?.editor.getModel()?.validateRange(new Range(line, 1, line, 1));
								void this.editorService.openEditor(
									{
										resource: entry.goToFileResource,
										options: { pinned: true, revealIfVisible: true, selection },
									},
									this.editorGroupService.mainPart.activeGroup,
								);
							},
						}))
					: [],
			"auto",
			// Hover and definition widgets must escape the canvas root, whose
			// container-query containment clips position: fixed descendants.
			overflowWidgetsDomNode,
			false,
			undefined,
		);
		this.headerFactory = factory;

		this.widget = this._register(
			this.reviewInstantiationService.createInstance(MultiDiffEditorWidget, diffContainer, factory, undefined),
		);
		// The widget's own switch, not the per-item option refresh: it pins the
		// width heuristic off, so the chosen layout is what renders at any width.
		const applyLayout = () => this.widget.setRenderSideBySide(!document && layout.get() === "split");
		this._register(layout.onDidChange(applyLayout));
		applyLayout();
		if (document) {
			this._register(this.widget.onDidChangeContentHeight(() => {
				const height = Math.max(40, this.widget.getContentHeight());
				document.onDidChangeHeight(document.heightMode === "capped" ? Math.min(400, height) : height);
			}));
		}
		this.streamStatus = append(diffContainer,
			$(".review-structural-stream-status"));
		this.streamStatus.setAttribute("role", "status");
		this.streamStatus.hidden = true;
		this._register(this.widget.onDidChangeActiveControl(() => this._onDidChangeActiveControl.fire()));
		this._register(this.widget.onDidScroll(() => this._onDidScroll.fire()));
		this._register(this.widget.onDidChangeActiveItem(() => this.syncFileSelectionFromWidget()));
		this.summary = append(fileTree, $(".review-files-editor-summary"));
		this.summary.hidden = true;
		this.summaryTooltip = this._register(new ReviewTooltip(hoverService, this.summary));
		this.changedFilesTree = document ? undefined : this._register(
			this.reviewInstantiationService.createInstance(ReviewChangedFilesTree, fileTree),
		);
		if (this.changedFilesTree) this._register(
			this.changedFilesTree.onDidOpenFile((file) => this.revealFile(file.path)),
		);
		this.splitView = this._register(
			new SplitView<number>(this.root, {
				orientation: Orientation.HORIZONTAL,
				proportionalLayout: true,
			}),
		);
		if (!this.fileTreeContainer && !document) this.splitView.addView(
			{
				element: fileTree,
				layout: (width, _offset, height) => {
					fileTree.style.width = `${width}px`;
					this.changedFilesTree?.layout((height ?? 0) -
						(this.summary.hidden ? 0 : this.summary.offsetHeight), width,
					);
				},
				maximumSize: 380,
				minimumSize: FILE_TREE_MINIMUM_WIDTH,
				onDidChange: Event.None,
			},
			260,
		);
		this.splitView.addView(
			{
				element: diffContainer,
				layout: (width, _offset, height) => {
					diffContainer.style.width = `${width}px`;
					this.widget.layout(new Dimension(width, height ?? 0));
				},
				maximumSize: Number.POSITIVE_INFINITY,
				minimumSize: DIFF_MINIMUM_WIDTH,
				onDidChange: Event.None,
			},
			740,
		);

		if (this.fileTreeContainer) {
			const treeSize = this._register(new ElementSizeObserver(this.fileTreeContainer, undefined));
			this._register(treeSize.onDidChange(() => this.layout()));
			treeSize.startObserving();
			this._register(toDisposable(() => fileTree.remove()));
		}
		const sizeObserver = this._register(new ElementSizeObserver(this.container, undefined));
		this._register(sizeObserver.onDidChange(() => this.layout()));
		sizeObserver.startObserving();
		this.layout();
		// Registered last so it runs last: the widgets above tear their own DOM
		// down, and they must do that while the tree is still attached.
		this._register(toDisposable(() => this.root.remove()));
	}

	async setInput(input: ReviewFilesEditorInput, viewState: IMultiDiffEditorViewState | undefined): Promise<void> {
		this.revealHold.clear();
		this.input = input;
		this.changedFilesTree?.setFiles(Array.from(new Map(input.entries.map(entry => [entry.file.path, entry.file])).values()));
		const viewModel = await input.getViewModel();
		if (this._store.isDisposed) return;
		this.viewModel = viewModel;
		// The canvas mounts this view without a user gesture, so the widget's
		// first-change navigation must never take keyboard focus.
		this.widget.setViewModel(viewModel, { preserveFocus: true, viewState, initialScrollPosition: this.document ? "top" : "firstChange" });
		this.changedFilesTree?.setFiles(Array.from(new Map(input.entries.map(entry => [entry.file.path, entry.file])).values()));
		this.syncFileSelectionFromWidget();
		this._register(
			autorun((reader) => {
				const items = viewModel.items.read(reader);
				if (this.document) for (const item of items) {
					if (this.initializedDocumentItems.has(item)) continue;
					this.initializedDocumentItems.add(item);
					item.collapsed.set(this.documentCollapsed, undefined);
				}
				this.applyHiddenFiles(items);
				this.applyViewedFiles();
				const entry = this.input?.entries.find(
					(e) => e.file.path === this.pendingPath,
				);
				if (!entry || !this.readyFiles.has(entry.file.path)) return;
				if (
					!items.some(
						(item) =>
							sameResource(item.originalUri, entry.original) &&
							sameResource(item.modifiedUri, entry.modified),
					)
				)
					return;
				this.pendingPath = undefined;
				this.showStreamStatus();
				queueMicrotask(() => {
					if (!this._store.isDisposed) { if (this.pendingSource) this.revealSource(this.pendingSource, this.pendingSectionId); else this.reveal(entry); }
				});
			}),
		);
	}

	startLoading(entries: readonly ReviewFilesEditorEntry[]): void {
		this.changedFilesTree?.setFiles(Array.from(new Map(entries.map(entry => [entry.file.path, entry.file])).values()));
		for (const entry of entries) {
			this.fileStates.set(entry.file.path, "Loading diff…");
			this.changedFilesTree?.setFileState(entry.file.path, "loading");
		}
		this.showStreamStatus();
	}

	fileLoaded(
		path: string,
		error?: string,
	): void {
		if (error) {
			this.fileStates.set(path, error);
			this.changedFilesTree?.setFileState(path, "error", error);
		} else {
			this.fileStates.delete(path);
			this.readyFiles.add(path);
			this.changedFilesTree?.setFileState(path, undefined);
		}
		this.input?.setReadyFiles(this.readyFiles, [...this.fileStates.values()].some(state => state === "Loading diff…"));
		this.showStreamStatus();
	}

	/** Coverage counts are independent of fold state. */
	fileCounts(path: string, counts: StructuralLineCounts): void {
		this.streamStats.set(path, {
			counts,
			tooltip: reviewChangesTooltip(counts.added, counts.removed),
		});
		if (!this.fileTreeContainer) this.changedFilesTree?.setCounts(path, counts);
		this.headerFactory.refreshHeaders();
		this.renderSummary();
	}

	private renderSummary(): void {
		if (this.fileTreeContainer) return;
		const paths = new Set((this.input?.entries ?? []).map(entry => entry.file.path));
		const complete = [...paths].every(path => this.streamStats.has(path));
		const total = { added: 0, removed: 0 };
		for (const path of paths) {
			const counts = this.streamStats.get(path)?.counts;
			if (counts) { total.added += counts.added; total.removed += counts.removed; }
		}
		this.summary.replaceChildren();
		const files = append(this.summary, $("span.review-files-editor-summary-files"));
		files.textContent = `${paths.size} files`;
		if (complete) {
			const format = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
			append(this.summary, $("span.review-files-editor-summary-added")).textContent = `+${format.format(total.added).toLowerCase()}`;
			append(this.summary, $("span.review-files-editor-summary-removed")).textContent = `−${format.format(total.removed).toLowerCase()}`;
		} else append(this.summary, $("span")).textContent = "Counting changes…";
		this.summaryTooltip.content = complete ? reviewChangesTooltip(total.added, total.removed) : REVIEW_COUNTS_PENDING_TOOLTIP;
		const wasHidden = this.summary.hidden;
		this.summary.hidden = false;
		if (wasHidden) this.layout();
	}

	/** A file the stream says starts collapsed, and why: its record's `visibility`. */
	hideFile(path: string, label: string): void {
		this.hiddenFiles.set(path, label);
		this.headerFactory.refreshHeaders();
		if (this.viewModel) this.applyHiddenFiles(this.viewModel.items.get());
	}

	/** GitHub's shape for a hidden file: the header stays, the body waits for a click. */
	private applyHiddenFiles(
		items: readonly {
			originalUri: URI | undefined;
			modifiedUri: URI | undefined;
			collapsed: { set(value: boolean, tx: undefined): void };
		}[],
	): void {
		for (const entry of this.input?.entries ?? []) {
			if (
				!this.hiddenFiles.has(entry.file.path) ||
				this.hiddenApplied.has(entry.file.path)
			)
				continue;
			const item = items.find(
				(item) =>
					sameResource(item.originalUri, entry.original) &&
					sameResource(item.modifiedUri, entry.modified),
			);
			if (!item) continue;
			item.collapsed.set(true, undefined);
			this.hiddenApplied.add(entry.file.path);
		}
	}

	private readonly collapsedSections = new Set<string>();
	private readonly sectionViewed = new Map<string, string>();
	private entryProgress(entry: ReviewFilesEditorEntry) {
		return (entry.sectionId ? this.progress?.sections?.find(section => section.id === entry.sectionId)?.files : this.progress?.files)?.find(file => file.path === entry.file.path);
	}
	private progressTooltip(entry: ReviewFilesEditorEntry): ReviewTooltipContent | undefined {
		const file = this.entryProgress(entry);
		return file ? reviewCountsTooltip(file) : undefined;
	}
	setProgress(progress: ReviewDiffProgress): void {
		this.progress = progress;
		for (const section of progress.sections ?? []) {
			const previous = this.sectionViewed.get(section.id);
			if (section.state === 'viewed' && previous !== 'viewed') this.collapsedSections.add(section.id);
			else if (previous === 'viewed' && section.state !== 'viewed') this.collapsedSections.delete(section.id);
			this.sectionViewed.set(section.id, section.state);
		}

		this.changedFilesTree?.setProgressFiles(progress.files);
		this.headerFactory.refreshHeaders();
		this.applyViewedFiles();
	}
	private applyViewedFiles(): void {
		for (const entry of this.input?.entries ?? []) {
			const file = this.entryProgress(entry);
			if (!file) continue;
			const key = `${entry.sectionId ?? ''}:${file.path}`;
			const previous = this.viewedApplied.get(key);
			if (previous === file.state) continue;
			const item = this.itemFor(entry);
			if (!item) continue;
			if (file.state === 'viewed') item.collapsed.set(true, undefined);
			else if (previous === 'viewed' || this.progress?.changedPaths?.includes(file.path)) item.collapsed.set(false, undefined);
			this.viewedApplied.set(key, file.state);
		}
	}
	revealSource(source: ReviewDiffLens['ranges'][number], sectionId?: string): void {
		const entry = this.input?.entries.find(entry => (!sectionId || entry.sectionId === sectionId) && (!entry.sectionId || this.progress?.sections?.find(section => section.id === entry.sectionId)?.sources.some(range => range.file === source.file && range.side === source.side && range.fromLine <= source.fromLine && range.toLine >= source.fromLine)) && source.file === (source.side === 'base' ? entry.file.previousPath ?? entry.file.path : entry.file.path));
		if (!entry) return;
		if (entry.sectionId && this.collapsedSections.delete(entry.sectionId)) this.headerFactory.refreshHeaders();
		this.pendingSource = source; this.pendingSectionId = sectionId;
		if (this.fileStates.has(entry.file.path)) { this.pendingPath = entry.file.path; return; }
		this.itemFor(entry)?.collapsed.set(false, undefined);
		this.reveal(entry, { highlight: true, side: source.side === 'base' ? 'original' : 'modified', range: new Range(source.fromLine, 1, source.toLine, 1) });
		this.pendingSource = undefined;
	}

	/** Scroll to a file, or to it once its diff has loaded. */
	revealFile(path: string): void {
		const entry = this.input?.entries.find((entry) => entry.file.path === path);
		if (!entry) return;
		this.pendingPath = this.fileStates.has(path) ? path : undefined;
		this.showStreamStatus();
		if (!this.pendingPath) this.reveal(entry);
	}

	get viewportHeight(): number { return this.diffContainer.clientHeight; }

	/**
	 * Pixels from the reading line (the list's top edge) to the first line of
	 * `source`, negative once scrolled past. Rendered files measure their
	 * editor; the rest are placed by file order around the topmost file, a
	 * million pixels per file, which keeps them sorted and on the right side.
	 */
	sourceOffset(source: ReviewDiffLens['ranges'][number]): number | undefined {
		const entries = this.input?.entries ?? [];
		const pathOf = (entry: (typeof entries)[number]) => source.side === 'base' ? entry.file.previousPath ?? entry.file.path : entry.file.path;
		const index = entries.findIndex(entry => pathOf(entry) === source.file);
		if (index < 0) return undefined;
		const entry = entries[index]!;
		const resource = source.side === 'base' ? entry.original : entry.modified;
		const editor = resource && this.widget.tryGetCodeEditor(resource)?.editor;
		const node = editor?.getDomNode();
		if (editor && node) {
			return node.getBoundingClientRect().top - this.diffContainer.getBoundingClientRect().top
				+ editor.getTopForLineNumber(source.fromLine) - editor.getScrollTop();
		}
		const active = this.viewModel?.activeDiffItem.get();
		const activeIndex = active ? entries.findIndex(e => sameResource(active.modifiedUri, e.modified) && sameResource(active.originalUri, e.original)) : 0;
		return (index - Math.max(0, activeIndex)) * 1_000_000 + source.fromLine;
	}

	loadingFailed(message: string): void {
		for (const [path, state] of this.fileStates)
			if (state === "Loading diff…") this.fileLoaded(path, message);
		this.showStreamStatus();
	}

	private showStreamStatus(): void {
		const message = this.pendingPath
			? this.fileStates.get(this.pendingPath)
			: undefined;
		this.streamStatus.hidden =
			(!message && this.readyFiles.size > 0) || this.fileStates.size === 0;
		this.streamStatus.textContent = message
			? `${this.pendingPath}: ${message}`
			: this.readyFiles.size === 0
				? ([...this.fileStates.values()][0] ?? "")
				: "";
		this.streamStatus.classList.toggle(
			"loading",
			[...this.fileStates.values()].some((s) => s === "Loading diff…"),
		);
	}

	getViewState(): IMultiDiffEditorViewState | undefined {
		return this.viewModel ? this.widget.getViewState() : undefined;
	}

	getActiveControl(): IDiffEditor | undefined {
		return this.widget.getActiveControl();
	}

	setCollapsed(collapsed: boolean): void {
		this.documentCollapsed = collapsed;
		for (const item of this.viewModel?.items.get() ?? []) item.collapsed.set(collapsed, undefined);
	}

	focus(): void {
		this.widget.getActiveControl()?.focus();
	}

	layout(): void {
		const width = this.container.clientWidth;
		const height = this.container.clientHeight;
		if (width <= 0 || height <= 0) return;

		const fileTreeVisible = !this.fileTreeContainer && width >= FILE_TREE_COLLAPSE_WIDTH;
		if (!this.fileTreeContainer && !this.document && this.splitView.isViewVisible(0) !== fileTreeVisible) {
			this.splitView.setViewVisible(0, fileTreeVisible);
		}

		this.splitView.layout(width, height);
		if (this.fileTreeContainer) this.changedFilesTree?.layout(this.fileTreeContainer.clientHeight, this.fileTreeContainer.clientWidth);
	}
	private reveal(resource: { original: URI | undefined; modified: URI | undefined }, options: RevealOptions = { highlight: true }): void {
		this.widget.reveal(resource, options);
		// The widget scrolls by the heights laid out so far, and files above still
		// loading or measuring move the target; reveal it again as they settle,
		// until the reader takes over or the input changes.
		const hold = this.revealHold.value = new DisposableStore();
		hold.add(this.widget.onDidChangeContentHeight(() => {
			if (this.itemFor(resource)) this.widget.reveal(resource, { ...options, highlight: false });
		}));
		for (const type of ["wheel", "pointerdown", "keydown"])
			hold.add(addDisposableListener(this.diffContainer, type, () => this.revealHold.clear(), { capture: true, passive: true }));
	}

	private itemFor(resource: { original: URI | undefined; modified: URI | undefined }) {
		return this.viewModel?.items.get().find(item => sameResource(item.originalUri, resource.original) && sameResource(item.modifiedUri, resource.modified));
	}

	private syncFileSelectionFromWidget(): void {
		const resource = this.widget.getActiveItem();
		const input = this.input;
		if (!resource || !input || this.pendingPath) return;
		const index = input.entries.findIndex(
			(entry) => sameResource(entry.original, resource.original) && sameResource(entry.modified, resource.modified),
		);
		if (index === -1) return;
		// Passive editor updates must not move a sidebar the reader scrolled independently.
		this.changedFilesTree?.setActiveFile(input.entries[index].file.path, false);
	}
}
function sameResource(left: URI | undefined, right: URI | undefined): boolean {
	return left === undefined ? right === undefined : !!right && isEqual(left, right);
}
