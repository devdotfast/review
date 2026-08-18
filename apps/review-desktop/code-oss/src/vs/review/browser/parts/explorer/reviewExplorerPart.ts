/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import "../../media/review.css";
import { $ } from "../../../../base/browser/dom.js";
import type { IListVirtualDelegate } from "../../../../base/browser/ui/list/list.js";
import type { IListAccessibilityProvider } from "../../../../base/browser/ui/list/listWidget.js";
import type {
	IAsyncDataSource,
	ITreeNode,
	ITreeRenderer,
} from "../../../../base/browser/ui/tree/tree.js";
import { Sequencer } from "../../../../base/common/async.js";
import { compareFileNamesDefault } from "../../../../base/common/comparers.js";
import { Disposable } from "../../../../base/common/lifecycle.js";
import { localize } from "../../../../nls.js";
import { basename, dirname, isEqual, isEqualOrParent } from "../../../../base/common/resources.js";
import { Schemas } from "../../../../base/common/network.js";
import { URI } from "../../../../base/common/uri.js";
import { IConfigurationService, type IConfigurationChangeEvent } from "../../../../platform/configuration/common/configuration.js";
import { FILES_EXCLUDE_CONFIG, FileKind, IFileService, type IFileStat } from "../../../../platform/files/common/files.js";
import { createDecorator, IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import { WorkbenchAsyncDataTree } from "../../../../platform/list/browser/listService.js";
import { ILogService } from "../../../../platform/log/common/log.js";
import { IStorageService, StorageScope, StorageTarget } from "../../../../platform/storage/common/storage.js";
import { IThemeService } from "../../../../platform/theme/common/themeService.js";
import { IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
import { Part } from "../../../../workbench/browser/part.js";
import { DEFAULT_LABELS_CONTAINER, ResourceLabels, type IResourceLabel } from "../../../../workbench/browser/labels.js";
import { EditorResourceAccessor, SideBySideEditor } from "../../../../workbench/common/editor.js";
import type { EditorInput } from "../../../../workbench/common/editor/editorInput.js";
import { DiffEditorInput } from "../../../../workbench/common/editor/diffEditorInput.js";
import { ResourceGlobMatcher } from "../../../../workbench/common/resources.js";
import type { IFilesConfiguration } from "../../../../workbench/contrib/files/common/files.js";
import { createFileIconThemableTreeContainerScope } from "../../../../workbench/contrib/files/browser/views/explorerView.js";
import { IEditorGroupsService } from "../../../../workbench/services/editor/common/editorGroupsService.js";
import { IEditorService } from "../../../../workbench/services/editor/common/editorService.js";
import {
	IWorkbenchLayoutService,
	Parts,
} from "../../../../workbench/services/layout/browser/layoutService.js";
import { reviewResourceIdentity } from "../../../common/reviewCodeResources.js";
import { REVIEW_CHROME_HEIGHT } from "../../../common/reviewChrome.js";
import type { ReviewDiffFileWire } from "../../../common/reviewProtocol.js";
import { IReviewCodeResourceService } from "../../../services/reviewCodeResourceService.js";
import { IReviewDiffTabsService } from "../../../services/reviewDiffTabs.js";
import { IReviewCanvasEditorTabsService } from "../../../services/reviewCanvasEditorTabsService.js";
import { IReviewSessionModelService } from "../../../services/reviewSessionModelService.js";
import { ReviewChangedFilesTree } from "../../reviewChangedFilesTree.js";
import { ReviewCanvasEditorInput } from "../canvas/reviewCanvasEditorInput.js";

/** The row height of one explorer entry, in CSS pixels. */
const REVIEW_EXPLORER_ROW_HEIGHT = 22;

const REVIEW_EXPLORER_TEMPLATE_ID = "review.explorer.entry";

/**
 * Whether the tree belongs beside this editor input.
 *
 * The rule is the resource, not the pane: a tree accompanies anything showing a
 * file from disk. Review's own surfaces — the canvas, the Diff (multi-file) view
 * and Home — are all `ReviewCanvasEditorInput`, whose resource carries the
 * `devfast-review-canvas` scheme, so they are excluded by construction.
 *
 * This used to be a whitelist of pane ids (`TEXT_FILE_EDITOR_ID`,
 * `TEXT_DIFF_EDITOR_ID`). That was wrong: clicking an image or any other binary
 * file *in the tree* opens a different pane, which fell outside the list and made
 * the tree collapse itself out from under the click.
 */
function accompaniesEditor(input: EditorInput | undefined): boolean {
	if (!input) {
		return false;
	}

	if (isSourceTab(input)) {
		return true;
	}

	const resource = EditorResourceAccessor.getCanonicalUri(input, { supportSideBySide: SideBySideEditor.PRIMARY });
	return resource?.scheme === Schemas.file;
}

/** The Source tab browses the whole worktree, so it gets the workspace tree. */
function isSourceTab(input: EditorInput | undefined): boolean {
	return input instanceof ReviewCanvasEditorInput && input.target.kind === "source";
}

/**
 * Which tree belongs beside this editor input.
 *
 * The rule is the editor kind, not where the open came from: diff editors and
 * Review's own canvas tabs pair with the changed-files tree, and everything
 * else that accompanies the tree — the Source tab and plain file editors — pairs
 * with the workspace tree. Deriving the mode from the input keeps it stable
 * when a file opened from the Source tree becomes the active editor.
 */
function treeModeFor(input: EditorInput | undefined): "changed" | "workspace" {
	if (isSourceTab(input)) {
		return "workspace";
	}
	if (input instanceof DiffEditorInput || input instanceof ReviewCanvasEditorInput) {
		return "changed";
	}
	return "workspace";
}

interface IReviewExplorerTemplate {
	readonly label: IResourceLabel;
}

const reviewExplorerDelegate: IListVirtualDelegate<IFileStat> = {
	getHeight: () => REVIEW_EXPLORER_ROW_HEIGHT,
	getTemplateId: () => REVIEW_EXPLORER_TEMPLATE_ID,
};

/**
 * Resolves directory children on demand and remembers every stat it produced.
 *
 * `revealResource` walks that cache to expand a file's ancestors, so the cache
 * is part of the contract rather than an optimization: a stat that never came
 * back through here cannot be revealed.
 *
 * Children the `files.exclude` setting hides never leave this class, so they are
 * absent from the tree and from the cache. Excluding here rather than in a
 * `ITreeFilter` keeps one rule: what the data source returns is what the tree
 * holds, which is what reveal can reach.
 */
class ReviewExplorerDataSource implements IAsyncDataSource<URI | null, IFileStat> {

	private readonly stats = new Map<string, IFileStat>();

	constructor(
		private readonly fileService: IFileService,
		private readonly excludes: ResourceGlobMatcher,
		private readonly logService: ILogService,
	) { }

	hasChildren(element: URI | null | IFileStat): boolean {
		if (element === null) {
			return false;
		}
		return URI.isUri(element) ? true : element.isDirectory;
	}

	async getChildren(element: URI | null | IFileStat): Promise<IFileStat[]> {
		if (element === null) {
			return []; // no active review, so no tree
		}

		const resource = URI.isUri(element) ? element : element.resource;
		try {
			const stat = await this.fileService.resolve(resource, { resolveSingleChildDescendants: false });
			const siblings = stat.children ?? [];
			// One name set for the whole directory. A `files.exclude` `when` clause
			// asks whether a sibling exists, and it is asked once per child, so
			// scanning the sibling array each time would be quadratic.
			const siblingNames = new Set(siblings.map(sibling => basename(sibling.resource)));
			const children = siblings.filter(child => !this.excludes.matches(child.resource, name => siblingNames.has(name)));
			for (const child of children) {
				this.stats.set(child.resource.toString(), child);
			}
			return children.sort(compareReviewExplorerStats);
		} catch (error) {
			// A snapshot worktree can lose a directory between resolves. An empty
			// folder is the honest rendering; the tree stays usable either way.
			this.logService.trace(`[review] explorer cannot resolve ${resource.fsPath}: ${error}`);
			return [];
		}
	}

	statFor(resource: URI): IFileStat | undefined {
		return this.stats.get(resource.toString());
	}

	reset(): void {
		this.stats.clear();
	}
}

function compareReviewExplorerStats(one: IFileStat, other: IFileStat): number {
	if (one.isDirectory !== other.isDirectory) {
		return one.isDirectory ? -1 : 1;
	}
	return compareFileNamesDefault(basename(one.resource), basename(other.resource));
}

class ReviewExplorerRenderer extends Disposable implements ITreeRenderer<IFileStat, void, IReviewExplorerTemplate> {

	readonly templateId = REVIEW_EXPLORER_TEMPLATE_ID;

	private readonly labels: ResourceLabels;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this.labels = this._register(instantiationService.createInstance(ResourceLabels, DEFAULT_LABELS_CONTAINER));
	}

	renderTemplate(container: HTMLElement): IReviewExplorerTemplate {
		return { label: this.labels.create(container, { supportHighlights: true }) };
	}

	renderElement(node: ITreeNode<IFileStat, void>, _index: number, template: IReviewExplorerTemplate): void {
		template.label.setFile(node.element.resource, {
			fileKind: node.element.isDirectory ? FileKind.FOLDER : FileKind.FILE,
			fileDecorations: { colors: false, badges: false },
			// The tree already shows the path through its indentation, so the
			// parent-folder description `setFile` adds by default is noise.
			hidePath: true,
		});
	}

	disposeTemplate(template: IReviewExplorerTemplate): void {
		template.label.dispose();
	}
}

const reviewExplorerAccessibilityProvider: IListAccessibilityProvider<IFileStat> = {
	getWidgetAriaLabel: () => localize("review.explorer.ariaLabel", "Review Files"),
	getAriaLabel: (element: IFileStat) => basename(element.resource),
};

/**
 * The read-only file tree that sits left of a full-screened reviewed file.
 *
 * Review reviews a pinned snapshot worktree, so this part deliberately is not
 * the stock explorer view: it offers no rename, delete, cut/paste, new-file or
 * drag-and-drop, and it never writes. It is a `WorkbenchAsyncDataTree` over
 * `IFileService`, which keeps virtualization, keyboard navigation, type-ahead
 * find, file icons and the `workbench.list.*` settings on stock components.
 */
export class ReviewExplorerPart extends Part {

	override readonly minimumWidth = 170;
	override readonly maximumWidth = 480;
	override readonly minimumHeight = 0;
	override readonly maximumHeight = Number.POSITIVE_INFINITY;

	/**
	 * Dragging the sash past half the minimum width collapses the leaf instead of
	 * pinning it at 170px. The split view calls `setVisible` to do that, so the
	 * collapse arrives as an ordinary part visibility change and
	 * `ReviewExplorerParts` records it as a user close.
	 */
	readonly snap = true;

	/** `null` while no review is active, which renders an empty tree. */
	private tree: WorkbenchAsyncDataTree<URI | null, IFileStat, void> | undefined;
	private dataSource: ReviewExplorerDataSource | undefined;
	private root: URI | undefined;
	private mode: "changed" | "workspace" = "changed";
	private changedFilesContainer: HTMLElement | undefined;
	private workspaceTreeContainer: HTMLElement | undefined;
	private changedFilesTree: ReviewChangedFilesTree | undefined;
	private changedFiles: readonly ReviewDiffFileWire[] = [];
	private changedFilesGeneration = 0;

	/** Serializes reveals and re-roots so two walks cannot interleave expands. */
	private readonly sequencer = new Sequencer();

	constructor(
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IFileService private readonly fileService: IFileService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
		@IReviewCodeResourceService private readonly codeResources: IReviewCodeResourceService,
		@IReviewSessionModelService private readonly sessionModelService: IReviewSessionModelService,
		@IReviewDiffTabsService private readonly reviewDiffTabsService: IReviewDiffTabsService,
		@IReviewCanvasEditorTabsService private readonly tabsService: IReviewCanvasEditorTabsService,
	) {
		super(
			Parts.REVIEW_EXPLORER_PART,
			{ hasTitle: false, borderWidth: () => 0 },
			themeService,
			storageService,
			layoutService,
		);
	}

	override create(parent: HTMLElement): void {
		this.element = parent;
		super.create(parent);
	}

	protected override createContentArea(parent: HTMLElement): HTMLElement {
		// Publish the chrome row height so review.css sizes the spacer from the same
		// constant this part lays the tree out with, rather than a second literal.
		this.layoutService.mainContainer.style.setProperty('--review-chrome-height', `${REVIEW_CHROME_HEIGHT}px`);

		// The macOS traffic lights float over the top-left of the window, and the
		// explorer is the leftmost surface, so reserve the one chrome row for them
		// and let the reserved strip drag the window.
		parent.appendChild($(".review-explorer-chrome-spacer"));

		const changedFilesContainer = $(".review-explorer-tree.review-explorer-changed-files");
		const workspaceTreeContainer = $(".review-explorer-tree.review-explorer-workspace-tree");
		parent.appendChild(changedFilesContainer);
		parent.appendChild(workspaceTreeContainer);
		this.changedFilesContainer = changedFilesContainer;
		this.workspaceTreeContainer = workspaceTreeContainer;

		this._register(createFileIconThemableTreeContainerScope(changedFilesContainer, this.themeService));
		const changedFilesTree = this._register(this.instantiationService.createInstance(
			ReviewChangedFilesTree,
			changedFilesContainer,
		));
		this.changedFilesTree = changedFilesTree;
		this._register(changedFilesTree.onDidOpenFile(file => {
			void this.reviewDiffTabsService.open({
				filePath: file.path,
				previousPath: file.previousPath,
			}).catch(error => this.logService.trace(`[review] explorer cannot open diff ${file.path}: ${error}`));
		}));
		this._register(this.sessionModelService.onDidChangeActiveModel(() => this.refreshChangedFiles()));
		// Both trees are built eagerly and laid out on every layout pass, so a
		// mode switch is a pure display toggle. A lazily created or hidden tree
		// would carry stale zero dimensions and render no rows.
		this.createWorkspaceTree(workspaceTreeContainer);
		this.setMode(this.mode);
		void this.refreshChangedFiles();

		return parent;
	}

	setMode(mode: "changed" | "workspace"): void {
		this.mode = mode;
		if (this.changedFilesContainer) {
			this.changedFilesContainer.style.display = mode === "changed" ? "" : "none";
		}
		if (this.workspaceTreeContainer) {
			this.workspaceTreeContainer.style.display = mode === "workspace" ? "" : "none";
		}
	}

	private createWorkspaceTree(treeContainer: HTMLElement): void {
		this._register(createFileIconThemableTreeContainerScope(treeContainer, this.themeService));

		// `ResourceGlobMatcher` owns the whole `files.exclude` story: per-folder
		// expressions, the absolute-to-relative conversion the globs need, the
		// configuration listener, and the workspace-folder listener. That last one is
		// why nothing here has to rebuild the patterns when the active review
		// changes the root.
		const excludes = this._register(this.instantiationService.createInstance(
			ResourceGlobMatcher,
			(folder?: URI) => this.configurationService.getValue<IFilesConfiguration>({ resource: folder }).files?.exclude,
			(event: IConfigurationChangeEvent) => event.affectsConfiguration(FILES_EXCLUDE_CONFIG),
		));

		const dataSource = new ReviewExplorerDataSource(this.fileService, excludes, this.logService);
		this.dataSource = dataSource;

		// A settings change can hide a folder that is currently expanded, so rebuild
		// every resolved level rather than trying to patch the tree in place.
		this._register(excludes.onExpressionChange(() => this.refreshTree()));

		const renderer = this._register(this.instantiationService.createInstance(ReviewExplorerRenderer));
		const tree = this._register(this.instantiationService.createInstance(
			WorkbenchAsyncDataTree<URI | null, IFileStat, void>,
			"ReviewExplorer",
			treeContainer,
			reviewExplorerDelegate,
			[renderer],
			dataSource,
			{
				identityProvider: { getId: (stat: IFileStat) => stat.resource.toString() },
				accessibilityProvider: reviewExplorerAccessibilityProvider,
				keyboardNavigationLabelProvider: {
					getKeyboardNavigationLabel: (stat: IFileStat) => basename(stat.resource),
				},
				multipleSelectionSupport: false,
				// A repository root has too many folders to auto-expand any of them.
				collapseByDefault: () => true,
			},
		));
		this.tree = tree;

		this._register(tree.onDidOpen(event => {
			const stat = event.element;
			if (!stat || stat.isDirectory) {
				return;
			}

			// Register the tab against the review it belongs to, so dismissing
			// or deleting the review closes it — the same lifecycle the
			// changed-files tree's diff tabs get from `reviewDiffTabs`.
			const model = this.sessionModelService.activeModel;
			void Promise.resolve(this.editorService.openEditor({
				resource: stat.resource,
				options: {
					pinned: event.editorOptions.pinned,
					preserveFocus: event.editorOptions.preserveFocus,
					revealIfVisible: true,
				},
			}, this.editorGroupsService.mainPart.activeGroup)).then(pane => {
				if (pane?.input && model) {
					this.tabsService.registerReviewEditor(model.reviewUuid, pane.input);
				}
			});
		}));

		// The active review's repository is the workbench's only workspace folder
		// (`reviewWorkspaceFolder.contribution.ts` keeps it there), so a folder
		// change is how the tree learns that the active review changed.
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => this.updateRoot()));

		this.root = undefined;
		this.updateRoot();
	}

	private async refreshChangedFiles(): Promise<void> {
		const generation = ++this.changedFilesGeneration;
		if (!this.sessionModelService.activeModel) {
			this.changedFiles = [];
			this.changedFilesTree?.setFiles([]);
			this.syncActiveResource();
			return;
		}
		try {
			const files = await this.codeResources.files();
			if (generation !== this.changedFilesGeneration) {
				return;
			}
			this.changedFiles = files;
			this.changedFilesTree?.setFiles(files);
			this.syncActiveResource();
		} catch (error) {
			if (generation !== this.changedFilesGeneration) {
				return;
			}
			this.changedFiles = [];
			this.changedFilesTree?.setFiles([]);
			this.syncActiveResource();
			this.logService.trace(`[review] explorer cannot load changed files: ${error}`);
		}
	}

	private syncActiveResource(): void {
		this.setActiveResource(EditorResourceAccessor.getCanonicalUri(this.editorService.activeEditor, {
			supportSideBySide: SideBySideEditor.PRIMARY,
		}));
	}

	/** Re-resolves every expanded level, for when what the tree may show changes. */
	private refreshTree(): void {
		if (!this.tree) {
			return;
		}

		this.sequencer.queue(async () => {
			this.dataSource?.reset();
			await this.tree?.updateChildren(undefined, true);
		}).catch(error => this.logService.trace(`[review] explorer cannot refresh: ${error}`));
	}

	private updateRoot(): void {
		const folder = this.workspaceContextService.getWorkspace().folders[0]?.uri;
		if (folder && this.root && isEqual(folder, this.root)) {
			return;
		}

		this.root = folder;

		this.sequencer.queue(async () => {
			const tree = this.tree;
			if (!tree) {
				return;
			}

			this.dataSource?.reset();
			await tree.setInput(folder ?? null);
		}).catch(error => this.logService.trace(`[review] explorer cannot root at ${folder?.fsPath}: ${error}`));
	}

	/**
	 * Expands the tree down to `resource` and selects it.
	 *
	 * Every step is a no-op when it cannot be met — a resource outside the root, a
	 * missing ancestor stat — because the caller is an active-editor change, and a
	 * resource the tree does not hold is not a failure.
	 */
	revealResource(resource: URI | undefined): void {
		const root = this.root;
		if (!resource || !root || resource.scheme !== Schemas.file || !isEqualOrParent(resource, root)) {
			return;
		}

		this.sequencer.queue(async () => {
			const tree = this.tree;
			const dataSource = this.dataSource;
			if (!tree || !dataSource || !this.root || !isEqual(this.root, root)) {
				return;
			}

			// Walk root -> resource so each expand resolves the level that holds the
			// next ancestor. The data source records those stats as it goes, which is
			// the only way the next step can find its element.
			for (const ancestor of ancestorsBetween(root, resource)) {
				const stat = dataSource.statFor(ancestor);
				if (!stat) {
					return;
				}
				await tree.expand(stat);
			}

			const target = dataSource.statFor(resource);
			if (!target) {
				return;
			}

			tree.setSelection([target]);
			tree.setFocus([target]);
			tree.reveal(target);
		}).catch(error => this.logService.trace(`[review] explorer cannot reveal ${resource.fsPath}: ${error}`));
	}

	setActiveResource(resource: URI | undefined): void {
		if (this.mode === "workspace") {
			this.revealResource(resource);
			return;
		}
		const model = this.sessionModelService.activeModel;
		const activePath = resource && model
			? reviewResourceIdentity(model.session, resource)?.path
			: undefined;
		const file = activePath
			? this.changedFiles.find(candidate =>
				candidate.path === activePath || candidate.previousPath === activePath,
			)
			: undefined;
		this.changedFilesTree?.setActiveFile(file?.path);
	}

	override layout(width: number, height: number, top: number, left: number): void {
		super.layout(width, height, top, left);

		// The editor tab strip pads itself past the window controls, and how much of
		// that chrome the tree already covers depends on this width. Publish it so
		// the padding in review.css can subtract it instead of assuming the tree is
		// always wider than the controls.
		this.layoutService.mainContainer.style.setProperty('--review-explorer-width', `${width}px`);

		const contentHeight = Math.max(0, height - REVIEW_CHROME_HEIGHT);
		// Both trees, visible or not: a hidden tree that skipped layout would
		// come back with stale zero dimensions and render no rows.
		this.changedFilesTree?.layout(contentHeight, width);
		this.tree?.layout(contentHeight, width);
	}

	toJSON(): object {
		return { type: Parts.REVIEW_EXPLORER_PART };
	}
}

/**
 * The directories between `root` (exclusive) and `resource` (exclusive), nearest
 * the root first. Expanding them in this order reveals `resource`.
 */
function ancestorsBetween(root: URI, resource: URI): URI[] {
	const ancestors: URI[] = [];
	let current = dirname(resource);
	while (!isEqual(current, root)) {
		ancestors.unshift(current);
		const parent = dirname(current);
		if (isEqual(parent, current)) {
			return []; // walked past the root; nothing to expand
		}
		current = parent;
	}
	return ancestors;
}

export const IReviewExplorerPartsService = createDecorator<IReviewExplorerPartsService>("reviewExplorerPartsService");

export interface IReviewExplorerPartsService {
	readonly _serviceBrand: undefined;

	/**
	 * Closes the file tree when it is open, reopens it when it is closed. A no-op
	 * unless the active editor is one the tree accompanies.
	 */
	toggle(): void;

	/**
	 * Clears a sticky close so the tree accompanies the active editor. The
	 * "Open source tree" CTAs call this after opening the Source tab, so the
	 * CTA always reveals the tree even after the user dismissed it.
	 */
	show(): void;
}

/** Marks the workbench while the tree has a tab to accompany, so the toolbar toggle can fade in. */
const REVIEW_EXPLORER_AVAILABLE_CLASS = 'review-explorer-available';

/** Remembers a close across reloads. Workspace-scoped: it is a per-review preference. */
const REVIEW_EXPLORER_USER_CLOSED_KEY = 'review.explorer.userClosed';

/**
 * Creates the explorer part and owns its show/hide policy.
 *
 * The part is a grid leaf, so the grid — not the editor — decides how much room
 * the file surface gets. This service is the only thing that toggles it. It is
 * eager so the part registers itself before `renderWorkbench` looks it up.
 *
 * Visibility has two inputs:
 *
 * - `available` — the active editor shows a file from disk, per
 *   {@link accompaniesEditor}. Derived, never persisted, and what the toolbar
 *   toggle fades in on.
 * - `userClosed` — the user dismissed the tree. This *is* persisted, because a
 *   close is a decision rather than derived state: it has to survive the next tab
 *   switch, the next session, and a reload. See the note in
 *   `common/reviewWorkbenchVisibility.ts`.
 *
 * The tree shows only when it is available and not closed.
 */
export class ReviewExplorerParts extends Disposable implements IReviewExplorerPartsService {
	declare readonly _serviceBrand: undefined;

	private readonly part: ReviewExplorerPart;

	private available = false;
	private userClosed: boolean;

	/**
	 * Set while this service is driving the grid, so the part-visibility listener
	 * below does not read our own `setPartHidden` back as a user action.
	 */
	private applying = false;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IEditorService private readonly editorService: IEditorService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		this.part = this._register(instantiationService.createInstance(ReviewExplorerPart));
		this.userClosed = this.storageService.getBoolean(REVIEW_EXPLORER_USER_CLOSED_KEY, StorageScope.WORKSPACE, false);

		this._register(this.editorService.onDidActiveEditorChange(() => this.update()));

		// A sash drag past the snap threshold collapses the leaf through the grid,
		// never through `toggle`. Treat any hide that arrives while the tree is
		// available as the user closing it, so dragging it shut is as sticky as
		// pressing the button.
		this._register(this.layoutService.onDidChangePartVisibility(event => {
			if (this.applying || event.partId !== Parts.REVIEW_EXPLORER_PART || !this.available) {
				return;
			}
			this.setUserClosed(!event.visible);
		}));

		// The grid starts the leaf hidden on every launch, so a restored file
		// editor needs this one run to bring it back.
		this.update();
	}

	toggle(): void {
		if (!this.available) {
			return;
		}

		this.setUserClosed(!this.userClosed);
		this.update();
	}

	show(): void {
		this.setUserClosed(false);
		this.update();
	}

	private setUserClosed(userClosed: boolean): void {
		if (this.userClosed === userClosed) {
			return;
		}

		this.userClosed = userClosed;
		this.storageService.store(REVIEW_EXPLORER_USER_CLOSED_KEY, userClosed, StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private update(): void {
		const input = this.editorService.activeEditor ?? undefined;
		this.available = accompaniesEditor(input);
		const visible = this.available && !this.userClosed;

		this.layoutService.mainContainer.classList.toggle(REVIEW_EXPLORER_AVAILABLE_CLASS, this.available);

		this.applying = true;
		try {
			this.layoutService.setPartHidden(!visible, Parts.REVIEW_EXPLORER_PART);
		} finally {
			this.applying = false;
		}

		if (!visible) {
			return;
		}

		this.part.setMode(treeModeFor(input));
		this.part.setActiveResource(EditorResourceAccessor.getCanonicalUri(input, {
			supportSideBySide: SideBySideEditor.PRIMARY,
		}));
	}
}
