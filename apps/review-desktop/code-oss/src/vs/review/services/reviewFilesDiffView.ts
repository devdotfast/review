/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import "../browser/media/review.css";
import { $, append, Dimension } from "../../base/browser/dom.js";
import { Orientation, SplitView } from "../../base/browser/ui/splitview/splitview.js";
import { Emitter, Event } from "../../base/common/event.js";
import { Disposable, toDisposable } from "../../base/common/lifecycle.js";
import { autorun } from "../../base/common/observable.js";
import { isEqual } from "../../base/common/resources.js";
import { URI } from "../../base/common/uri.js";
import { ElementSizeObserver } from "../../editor/browser/config/elementSizeObserver.js";
import type { IDiffEditor } from "../../editor/browser/editorBrowser.js";
import { MultiDiffEditorViewModel } from "../../editor/browser/widget/multiDiffEditor/multiDiffEditorViewModel.js";
import { MultiDiffEditorWidget } from "../../editor/browser/widget/multiDiffEditor/multiDiffEditorWidget.js";
import type { IMultiDiffEditorViewState } from "../../editor/browser/widget/multiDiffEditor/multiDiffEditorWidgetImpl.js";
import { IDiffEditorOptions } from "../../editor/common/config/editorOptions.js";
import { ITextModelService } from "../../editor/common/services/resolverService.js";
import { ITextResourceConfigurationService } from "../../editor/common/services/textResourceConfiguration.js";
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
import { type ReviewDiffFileWire } from "../common/reviewProtocol.js";
import {
	structuralCountsTooltip,
	type StructuralFileCounts,
} from "../common/reviewStructuralDiff.js";
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
} satisfies IDiffEditorOptions;

export interface ReviewFilesEditorEntry {
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
					structural
						? {
							...REVIEW_FILES_DIFF_EDITOR_OPTIONS,
							hideUnchangedRegions: {
								enabled: true,
								minimumLineCount: 1,
								contextLineCount: 0,
							},
							folding: false,
							glyphMargin: true,
							experimental: { useTrueInlineView: false },
						}
						: REVIEW_FILES_DIFF_EDITOR_OPTIONS,
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

	private readonly root: HTMLElement;
	private readonly splitView: SplitView<number>;
	private readonly changedFilesTree: ReviewChangedFilesTree;
	private readonly widget: MultiDiffEditorWidget;
	private viewModel: MultiDiffEditorViewModel | undefined;
	private input: ReviewFilesEditorInput | undefined;
	private readonly readyFiles = new Set<string>();
	private readonly fileStates = new Map<string, string>();
	/** Counts from the structural stream: visible lines replace the git counts once a file lands. */
	private readonly streamStats = new Map<
		string,
		{ counts: StructuralFileCounts; title: string }
	>();
	private readonly headerFactory: ReviewMultiDiffUIElementFactory;
	private readonly summary: HTMLElement;
	private readonly summaryBlocks: HTMLElement[] = [];
	/** Files the stream says start hidden, with the reason shown in their header. */
	private readonly hiddenFiles = new Map<string, string>();
	private readonly hiddenApplied = new Set<string>();
	private pendingPath: string | undefined;
	private readonly streamStatus: HTMLElement;

	constructor(
		private readonly container: HTMLElement,
		overflowWidgetsDomNode: HTMLElement | undefined,
		layout: ReviewDiffLayoutSetting,
		@IInstantiationService
		private readonly reviewInstantiationService: IInstantiationService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService
		private readonly editorGroupService: IEditorGroupsService,
	) {
		super();
		this.root = append(container, $(".review-files-editor"));
		const fileTree = append(this.root, $(".review-files-editor-tree"));
		const diffContainer = append(this.root, $(".review-files-editor-diffs"));

		const factory = this.reviewInstantiationService.createInstance(
			ReviewMultiDiffUIElementFactory,
			() =>
				this.input
					? this.input.entries.map((entry) => ({
							original: entry.original,
							modified: entry.modified,
						additions: this.streamStats.get(entry.file.path)?.counts.visible.added ??
							entry.file.additions,
						deletions: this.streamStats.get(entry.file.path)?.counts.visible.removed ??
							entry.file.deletions,
						countsTitle: this.streamStats.get(entry.file.path)?.title,
						note: this.hiddenFiles.get(entry.file.path),
							onDidOpen: () => {
								void this.editorService.openEditor(
									{
										resource: entry.goToFileResource,
										options: { pinned: true, revealIfVisible: true },
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
		const applyLayout = () => this.widget.setRenderSideBySide(layout.get() === "split");
		this._register(layout.onDidChange(applyLayout));
		applyLayout();
		this.streamStatus = append(diffContainer,
			$(".review-structural-stream-status"));
		this.streamStatus.setAttribute("role", "status");
		this.streamStatus.hidden = true;
		this._register(this.widget.onDidChangeActiveControl(() => this._onDidChangeActiveControl.fire()));
		this._register(this.widget.onDidChangeActiveItem(() => this.syncFileSelectionFromWidget()));
		this.summary = append(fileTree, $(".review-files-editor-summary"));
		this.summary.hidden = true;
		this.changedFilesTree = this._register(
			this.reviewInstantiationService.createInstance(ReviewChangedFilesTree, fileTree),
		);
		this._register(
			this.changedFilesTree.onDidOpenFile((file) => {
				const element = this.input?.entries.find((entry) => entry.file.path === file.path);
				if (!element) return;
				if (this.fileStates.has(file.path)) {
					this.pendingPath = file.path;
					this.showStreamStatus();
					return;
				}
				this.pendingPath = undefined;
				this.showStreamStatus();
				this.reveal({
					original: element.original,
					modified: element.modified,
				});
			}),
		);
		this.splitView = this._register(
			new SplitView<number>(this.root, {
				orientation: Orientation.HORIZONTAL,
				proportionalLayout: true,
			}),
		);
		this.splitView.addView(
			{
				element: fileTree,
				layout: (width, _offset, height) => {
					fileTree.style.width = `${width}px`;
					this.changedFilesTree.layout((height ?? 0) -
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

		const sizeObserver = this._register(new ElementSizeObserver(this.container, undefined));
		this._register(sizeObserver.onDidChange(() => this.layout()));
		sizeObserver.startObserving();
		this.layout();
		// Registered last so it runs last: the widgets above tear their own DOM
		// down, and they must do that while the tree is still attached.
		this._register(toDisposable(() => this.root.remove()));
	}

	async setInput(input: ReviewFilesEditorInput, viewState: IMultiDiffEditorViewState | undefined): Promise<void> {
		this.input = input;
		this.changedFilesTree.setFiles(input.entries.map((entry) => entry.file));
		const viewModel = await input.getViewModel();
		if (this._store.isDisposed) return;
		this.viewModel = viewModel;
		// The canvas mounts this view without a user gesture, so the widget's
		// first-change navigation must never take keyboard focus.
		this.widget.setViewModel(viewModel, { preserveFocus: true, viewState });
		this.changedFilesTree.setFiles(input.entries.map((entry) => entry.file));
		this.syncFileSelectionFromWidget();
		this._register(
			autorun((reader) => {
				const items = viewModel.items.read(reader);
				this.applyHiddenFiles(items);
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
					if (!this._store.isDisposed) this.reveal(entry);
				});
			}),
		);
	}

	startLoading(entries: readonly ReviewFilesEditorEntry[]): void {
		this.changedFilesTree.setFiles(entries.map((e) => e.file));
		for (const entry of entries) {
			this.fileStates.set(entry.file.path, "Loading diff…");
			this.changedFilesTree.setFileState(entry.file.path, "loading");
		}
		this.showStreamStatus();
	}

	fileLoaded(
		path: string,
		error?: string,
		stats?: { added: number; removed: number },
	): void {
		if (error) {
			this.fileStates.set(path, error);
			this.changedFilesTree.setFileState(path, "error", error);
		} else {
			this.fileStates.delete(path);
			this.readyFiles.add(path);
			this.changedFilesTree.setFileState(path, undefined);
		}
		this.input?.setReadyFiles(this.readyFiles, [...this.fileStates.values()].some(state => state === "Loading diff…"));
		this.showStreamStatus();
	}

	/** Visible counts from the stream, first on arrival and again after every fold toggle. */
	fileCounts(path: string, counts: StructuralFileCounts): void {
		this.streamStats.set(path, {
			counts,
			title: structuralCountsTooltip(counts),
		});
		this.changedFilesTree.setFiles(this.filesWithStreamStats());
		this.headerFactory.refreshHeaders();
		this.renderSummary();
	}

	/** The review-level total: the same visible counts summed over files, with GitHub's five-block bar. */
	private renderSummary(): void {
		const entries = this.input?.entries ?? [];
		const total = {
			visible: { added: 0, removed: 0 },
			textual: { added: 0, removed: 0 },
		};
		let lineDiffs = 0;
		for (const entry of entries) {
			const stats = this.streamStats.get(entry.file.path);
			if (!stats) continue;
			total.visible.added += stats.counts.visible.added;
			total.visible.removed += stats.counts.visible.removed;
			total.textual.added += stats.counts.textual.added;
			total.textual.removed += stats.counts.textual.removed;
			if (stats.counts.fallback) lineDiffs++;
		}
		if (this.summaryBlocks.length === 0) {
			const files = $("span.review-files-editor-summary-files");
			const added = $("span.review-files-editor-summary-added");
			const removed = $("span.review-files-editor-summary-removed");
			const bar = $("span.review-files-editor-summary-bar");
			for (let i = 0; i < 5; i++)
				this.summaryBlocks.push(
					append(bar, $("span.review-files-editor-summary-block")),
				);
			this.summary.append(files, added, removed, bar);
		}
		const [files, added, removed] = this.summary
			.children as unknown as HTMLElement[];
		files.textContent =
			entries.length === 1 ? "1 file" : `${entries.length} files`;
		added.textContent = `+${total.visible.added}`;
		removed.textContent = `−${total.visible.removed}`;
		const sum = total.visible.added + total.visible.removed;
		const greens = sum === 0 ? 0 : Math.round((total.visible.added / sum) * 5);
		const reds = sum === 0 ? 0 : Math.round((total.visible.removed / sum) * 5);
		this.summaryBlocks.forEach((block, index) => {
			block.className = `review-files-editor-summary-block ${index < greens ? "added" : index < greens + reds ? "removed" : "neutral"}`;
		});
		this.summary.title = [
			`visible +${total.visible.added} −${total.visible.removed}`,
			`textual +${total.textual.added} −${total.textual.removed}`,
			...(lineDiffs
				? [`line diff: ${lineDiffs === 1 ? "1 file" : `${lineDiffs} files`}`]
				: []),
		].join("\n");
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

	private filesWithStreamStats(): ReviewDiffFileWire[] {
		return (this.input?.entries ?? []).map((entry) => {
			const stats = this.streamStats.get(entry.file.path);
			return stats
				? {
					...entry.file,
					additions: stats.counts.visible.added,
					deletions: stats.counts.visible.removed,
				}
				: entry.file;
		});
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

	focus(): void {
		this.widget.getActiveControl()?.focus();
	}

	layout(): void {
		const width = this.container.clientWidth;
		const height = this.container.clientHeight;
		if (width <= 0 || height <= 0) return;

		const fileTreeVisible = width >= FILE_TREE_COLLAPSE_WIDTH;
		if (this.splitView.isViewVisible(0) !== fileTreeVisible) {
			this.splitView.setViewVisible(0, fileTreeVisible);
		}

		this.splitView.layout(width, height);
	}
	private reveal(resource: { original: URI | undefined; modified: URI | undefined }): void {
		this.widget.reveal(resource, { highlight: true });
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
		this.changedFilesTree.setActiveFile(input.entries[index].file.path, false);
	}
}
function sameResource(left: URI | undefined, right: URI | undefined): boolean {
	return left === undefined ? right === undefined : !!right && isEqual(left, right);
}
