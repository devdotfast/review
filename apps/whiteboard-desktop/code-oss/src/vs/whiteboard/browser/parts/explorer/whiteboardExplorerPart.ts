/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { sourceTreeUri, sourceTreeSelection, sourceTreeRoot } from "../../../common/whiteboardSourceView.js";

import { $ } from "../../../../base/browser/dom.js";
import type { IListVirtualDelegate } from "../../../../base/browser/ui/list/list.js";
import type { IListAccessibilityProvider } from "../../../../base/browser/ui/list/listWidget.js";
import type { IAsyncDataSource, ITreeNode, ITreeRenderer } from "../../../../base/browser/ui/tree/tree.js";
import { Sequencer } from "../../../../base/common/async.js";
import { compareFileNamesDefault } from "../../../../base/common/comparers.js";
import { Disposable } from "../../../../base/common/lifecycle.js";
import { basename, dirname, isEqual, isEqualOrParent } from "../../../../base/common/resources.js";
import { URI } from "../../../../base/common/uri.js";
import { localize } from "../../../../nls.js";
import {
	IConfigurationService,
	type IConfigurationChangeEvent,
} from "../../../../platform/configuration/common/configuration.js";
import { FILES_EXCLUDE_CONFIG, FileKind, type IFileStat } from "../../../../platform/files/common/files.js";
import { IInstantiationService, createDecorator } from "../../../../platform/instantiation/common/instantiation.js";
import { WorkbenchAsyncDataTree } from "../../../../platform/list/browser/listService.js";
import { ILogService } from "../../../../platform/log/common/log.js";
import { IStorageService, StorageScope, StorageTarget } from "../../../../platform/storage/common/storage.js";
import { IThemeService } from "../../../../platform/theme/common/themeService.js";
import { DEFAULT_LABELS_CONTAINER, ResourceLabels, type IResourceLabel } from "../../../../workbench/browser/labels.js";
import { Part } from "../../../../workbench/browser/part.js";
import { EditorResourceAccessor, SideBySideEditor } from "../../../../workbench/common/editor.js";
import type { EditorInput } from "../../../../workbench/common/editor/editorInput.js";
import { ResourceGlobMatcher } from "../../../../workbench/common/resources.js";
import { createFileIconThemableTreeContainerScope } from "../../../../workbench/contrib/files/browser/views/explorerView.js";
import type { IFilesConfiguration } from "../../../../workbench/contrib/files/common/files.js";
import { IEditorGroupsService } from "../../../../workbench/services/editor/common/editorGroupsService.js";
import { IEditorService } from "../../../../workbench/services/editor/common/editorService.js";
import { IWorkbenchLayoutService, Parts } from "../../../../workbench/services/layout/browser/layoutService.js";
import { WHITEBOARD_CHROME_HEIGHT } from "../../../common/whiteboardChrome.js";
import {
	IWhiteboardApiSourceService,
	WHITEBOARD_API_SOURCE_SCHEME,
} from "../../../services/whiteboardApiSourceService.js";
import { IWhiteboardApiCatalogService } from "../../../services/whiteboardApiCatalogService.js";
import { IWhiteboardCanvasEditorTabsService } from "../../../services/whiteboardCanvasEditorTabsService.js";

import "../../media/whiteboard.css";
import { WhiteboardCanvasEditorInput } from "../canvas/whiteboardCanvasEditorInput.js";

/** The row height of one explorer entry, in CSS pixels. */
const WHITEBOARD_EXPLORER_ROW_HEIGHT = 22;

const WHITEBOARD_EXPLORER_TEMPLATE_ID = "review.explorer.entry";

/**
 * Whether the tree belongs beside this editor input.
 *
 * The rule is the resource, not the pane: a tree accompanies anything showing a
 * file from disk. Review's own surfaces — the canvas, the Diff (multi-file) view
 * and Home — are all `WhiteboardCanvasEditorInput`, whose resource carries the
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
	return resource?.scheme === WHITEBOARD_API_SOURCE_SCHEME;
}

/** The Source tab owns the current or version-selected repository tree. */
function isSourceTab(input: EditorInput | undefined): boolean {
	return input instanceof WhiteboardCanvasEditorInput && input.target.kind === "api-source";
}

interface IWhiteboardExplorerTemplate {
	readonly label: IResourceLabel;
}

const whiteboardExplorerDelegate: IListVirtualDelegate<IFileStat> = {
	getHeight: () => WHITEBOARD_EXPLORER_ROW_HEIGHT,
	getTemplateId: () => WHITEBOARD_EXPLORER_TEMPLATE_ID,
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
class WhiteboardExplorerDataSource implements IAsyncDataSource<URI | null, IFileStat> {
	private readonly stats = new Map<string, IFileStat>();

	constructor(
		private readonly excludes: ResourceGlobMatcher,
		private readonly logService: ILogService,
		private readonly apiSource: IWhiteboardApiSourceService,
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
			const siblings = await this.apiSource.children(resource);
			// One name set for the whole directory. A `files.exclude` `when` clause
			// asks whether a sibling exists, and it is asked once per child, so
			// scanning the sibling array each time would be quadratic.
			const siblingNames = new Set(siblings.map((sibling) => basename(sibling.resource)));
			const children = siblings.filter(
				(child) => !this.excludes.matches(child.resource, (name) => siblingNames.has(name)),
			);
			for (const child of children) {
				this.stats.set(child.resource.path, child);
			}
			return children.sort(compareWhiteboardExplorerStats);
		} catch (error) {
			// Keep other directories usable when a pinned source request fails.
			this.logService.trace(`[review] explorer cannot resolve ${resource.fsPath}: ${error}`);
			return [];
		}
	}

	statFor(resource: URI): IFileStat | undefined {
		return this.stats.get(resource.path);
	}

	reset(): void {
		this.stats.clear();
	}
}

function compareWhiteboardExplorerStats(one: IFileStat, other: IFileStat): number {
	if (one.isDirectory !== other.isDirectory) {
		return one.isDirectory ? -1 : 1;
	}
	return compareFileNamesDefault(basename(one.resource), basename(other.resource));
}

class WhiteboardExplorerRenderer extends Disposable implements ITreeRenderer<IFileStat, void, IWhiteboardExplorerTemplate> {
	readonly templateId = WHITEBOARD_EXPLORER_TEMPLATE_ID;

	private readonly labels: ResourceLabels;

	constructor(@IInstantiationService instantiationService: IInstantiationService) {
		super();
		this.labels = this._register(instantiationService.createInstance(ResourceLabels, DEFAULT_LABELS_CONTAINER));
	}

	renderTemplate(container: HTMLElement): IWhiteboardExplorerTemplate {
		return { label: this.labels.create(container, { supportHighlights: true }) };
	}

	renderElement(node: ITreeNode<IFileStat, void>, _index: number, template: IWhiteboardExplorerTemplate): void {
		template.label.setFile(node.element.resource, {
			fileKind: node.element.isDirectory ? FileKind.FOLDER : FileKind.FILE,
			fileDecorations: { colors: false, badges: false },
			// The tree already shows the path through its indentation, so the
			// parent-folder description `setFile` adds by default is noise.
			hidePath: true,
		});
	}

	disposeTemplate(template: IWhiteboardExplorerTemplate): void {
		template.label.dispose();
	}
}

const whiteboardExplorerAccessibilityProvider: IListAccessibilityProvider<IFileStat> = {
	getWidgetAriaLabel: () => localize("review.explorer.ariaLabel", "Session files"),
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
export class WhiteboardExplorerPart extends Part {
	override readonly minimumWidth = 170;
	override readonly maximumWidth = 480;
	override readonly minimumHeight = 0;
	override readonly maximumHeight = Number.POSITIVE_INFINITY;

	/**
	 * Dragging the sash past half the minimum width collapses the leaf instead of
	 * pinning it at 170px. The split view calls `setVisible` to do that, so the
	 * collapse arrives as an ordinary part visibility change and
	 * `WhiteboardExplorerParts` records it as a user close.
	 */
	readonly snap = true;

	/** `null` while no review is active, which renders an empty tree. */
	private tree: WorkbenchAsyncDataTree<URI | null, IFileStat, void> | undefined;
	private dataSource: WhiteboardExplorerDataSource | undefined;
	private root: URI | undefined;

	/** Serializes reveals and re-roots so two walks cannot interleave expands. */
	private readonly sequencer = new Sequencer();

	constructor(
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
		@IWhiteboardApiSourceService private readonly apiSource: IWhiteboardApiSourceService,
		@IWhiteboardApiCatalogService private readonly catalog: IWhiteboardApiCatalogService,
		@IWhiteboardCanvasEditorTabsService private readonly tabsService: IWhiteboardCanvasEditorTabsService,
	) {
		super(
			Parts.WHITEBOARD_EXPLORER_PART,
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
		// Publish the chrome row height so whiteboard.css sizes the spacer from the same
		// constant this part lays the tree out with, rather than a second literal.
		parent.style.setProperty("--whiteboard-chrome-height", `${WHITEBOARD_CHROME_HEIGHT}px`);

		// The macOS traffic lights float over the top-left of the window, and the
		// explorer is the leftmost surface, so reserve the one chrome row for them
		// and let the reserved strip drag the window.
		parent.appendChild($(".whiteboard-explorer-chrome-spacer"));

		const workspaceTreeContainer = $(".whiteboard-explorer-tree.review-explorer-workspace-tree");
		parent.appendChild(workspaceTreeContainer);
		this.createWorkspaceTree(workspaceTreeContainer);

		return parent;
	}

	private createWorkspaceTree(treeContainer: HTMLElement): void {
		this._register(createFileIconThemableTreeContainerScope(treeContainer, this.themeService));

		// `ResourceGlobMatcher` owns the whole `files.exclude` story: per-folder
		// expressions, the absolute-to-relative conversion the globs need, the
		// configuration listener, and the workspace-folder listener. That last one is
		// why nothing here has to rebuild the patterns when the active review
		// changes the root.
		const excludes = this._register(
			this.instantiationService.createInstance(
				ResourceGlobMatcher,
				(folder?: URI) => this.configurationService.getValue<IFilesConfiguration>({ resource: folder }).files?.exclude,
				(event: IConfigurationChangeEvent) => event.affectsConfiguration(FILES_EXCLUDE_CONFIG),
			),
		);

		const dataSource = new WhiteboardExplorerDataSource(excludes, this.logService, this.apiSource);
		this.dataSource = dataSource;

		// A settings change can hide a folder that is currently expanded, so rebuild
		// every resolved level rather than trying to patch the tree in place.
		this._register(excludes.onExpressionChange(() => this.refreshTree()));

		const renderer = this._register(this.instantiationService.createInstance(WhiteboardExplorerRenderer));
		const tree = this._register(
			this.instantiationService.createInstance(
				WorkbenchAsyncDataTree<URI | null, IFileStat, void>,
				"WhiteboardExplorer",
				treeContainer,
				whiteboardExplorerDelegate,
				[renderer],
				dataSource,
				{
					identityProvider: { getId: (stat: IFileStat) => `${this.root?.toString()}/${stat.resource.path}` },
					accessibilityProvider: whiteboardExplorerAccessibilityProvider,
					keyboardNavigationLabelProvider: {
						getKeyboardNavigationLabel: (stat: IFileStat) => basename(stat.resource),
					},
					multipleSelectionSupport: false,
					// A repository root has too many folders to auto-expand any of them.
					collapseByDefault: () => true,
				},
			),
		);
		this.tree = tree;

		this._register(
			tree.onDidOpen((event) => {
				const stat = event.element;
				if (!stat || stat.isDirectory) {
					return;
				}

				// Register the tab against the review it belongs to, so dismissing
				// or deleting the review closes it — the same lifecycle the
				// changed-files tree's diff tabs get from `whiteboardDiffTabs`.
				const sessionId = stat.resource.scheme === WHITEBOARD_API_SOURCE_SCHEME ? stat.resource.authority : undefined;
				void Promise.resolve(
					this.editorService.openEditor(
						{
							resource: stat.resource,
							options: {
								pinned: event.editorOptions.pinned,
								preserveFocus: event.editorOptions.preserveFocus,
								revealIfVisible: true,
							},
						},
						this.editorGroupsService.mainPart.activeGroup,
					),
				).then((pane) => {
					if (pane?.input && sessionId) {
						this.tabsService.registerWhiteboardEditor(sessionId, pane.input);
					}
				});
			}),
		);

		this._register(this.editorService.onDidActiveEditorChange(() => this.updateRoot()));
		let revision: string | undefined;
		this._register(this.catalog.onDidChange(() => {
			if (!this.root || sourceTreeSelection(this.root).kind !== "current") return;
			const review = this.catalog.reviews.find(review => review.sessionId === this.root!.authority);
			const next = JSON.stringify([review?.sessionId, review?.version, review?.pins?.worktreeRevision]);
			if (next === revision) return;
			revision = next;
			this.refreshTree();
		}));

		this.root = undefined;
		this.updateRoot();
	}

	/** Re-resolves every expanded level, for when what the tree may show changes. */
	private refreshTree(): void {
		if (!this.tree) {
			return;
		}

		this.sequencer
			.queue(async () => {
				this.dataSource?.reset();
				await this.tree?.updateChildren(undefined, true);
			})
			.catch((error) => this.logService.trace(`[review] explorer cannot refresh: ${error}`));
	}

	private updateRoot(): void {
		const input = this.editorService.activeEditor;
		const resource = EditorResourceAccessor.getCanonicalUri(input, { supportSideBySide: SideBySideEditor.PRIMARY });
		const folder =
			input instanceof WhiteboardCanvasEditorInput && input.target.kind === "api-source"
				? sourceTreeUri(input.target.selection)
				: resource?.scheme === WHITEBOARD_API_SOURCE_SCHEME
					? sourceTreeRoot(resource, this.root)
					: undefined;
		if (folder && this.root && isEqual(folder, this.root)) {
			return;
		}

		this.root = folder;

		this.sequencer
			.queue(async () => {
				const tree = this.tree;
				if (!tree) {
					return;
				}

				this.dataSource?.reset();
				await tree.setInput(folder ?? null);
			})
			.catch((error) => this.logService.trace(`[review] explorer cannot root at ${folder?.fsPath}: ${error}`));
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
		if (resource && root && resource.scheme === WHITEBOARD_API_SOURCE_SCHEME && sourceTreeRoot(resource, root).toString() === root.toString()) {
			// A base-side or commit-scoped editor still belongs to the selected tree.
			resource = resource.with({ scheme: root.scheme, query: root.query });
		}
		if (!resource || !root || !isEqualOrParent(resource, root)) {
			return;
		}

		this.sequencer
			.queue(async () => {
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
			})
			.catch((error) => this.logService.trace(`[review] explorer cannot reveal ${resource.fsPath}: ${error}`));
	}

	setActiveResource(resource: URI | undefined): void {
		this.revealResource(resource);
	}

	override layout(width: number, height: number, top: number, left: number): void {
		super.layout(width, height, top, left);

		const contentHeight = Math.max(0, height - WHITEBOARD_CHROME_HEIGHT);
		// Both trees, visible or not: a hidden tree that skipped layout would
		// come back with stale zero dimensions and render no rows.
		this.tree?.layout(contentHeight, width);
	}

	toJSON(): object {
		return { type: Parts.WHITEBOARD_EXPLORER_PART };
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

export const IWhiteboardExplorerPartsService = createDecorator<IWhiteboardExplorerPartsService>("whiteboardExplorerPartsService");

export interface IWhiteboardExplorerPartsService {
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
const WHITEBOARD_EXPLORER_AVAILABLE_CLASS = "whiteboard-explorer-available";

/** Remembers a close across reloads. Workspace-scoped: it is a per-review preference. */
const WHITEBOARD_EXPLORER_USER_CLOSED_KEY = "review.explorer.userClosed";

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
 *   `common/whiteboardWorkbenchVisibility.ts`.
 *
 * The tree shows only when it is available and not closed.
 */
export class WhiteboardExplorerParts extends Disposable implements IWhiteboardExplorerPartsService {
	declare readonly _serviceBrand: undefined;

	private readonly part: WhiteboardExplorerPart;

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
		this.part = this._register(instantiationService.createInstance(WhiteboardExplorerPart));
		this.userClosed = this.storageService.getBoolean(WHITEBOARD_EXPLORER_USER_CLOSED_KEY, StorageScope.WORKSPACE, false);

		this._register(this.editorService.onDidActiveEditorChange(() => this.update()));

		// A sash drag past the snap threshold collapses the leaf through the grid,
		// never through `toggle`. Treat any hide that arrives while the tree is
		// available as the user closing it, so dragging it shut is as sticky as
		// pressing the button.
		this._register(
			this.layoutService.onDidChangePartVisibility((event) => {
				if (this.applying || event.partId !== Parts.WHITEBOARD_EXPLORER_PART || !this.available) {
					return;
				}
				this.setUserClosed(!event.visible);
			}),
		);

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
		this.storageService.store(
			WHITEBOARD_EXPLORER_USER_CLOSED_KEY,
			userClosed,
			StorageScope.WORKSPACE,
			StorageTarget.MACHINE,
		);
	}

	private update(): void {
		const input = this.editorService.activeEditor ?? undefined;
		this.available = accompaniesEditor(input);
		const visible = this.available && !this.userClosed;

		this.layoutService.mainContainer.classList.toggle(WHITEBOARD_EXPLORER_AVAILABLE_CLASS, this.available);

		this.applying = true;
		try {
			this.layoutService.setPartHidden(!visible, Parts.WHITEBOARD_EXPLORER_PART);
		} finally {
			this.applying = false;
		}

		if (!visible) {
			return;
		}

		this.part.setActiveResource(
			EditorResourceAccessor.getCanonicalUri(input, {
				supportSideBySide: SideBySideEditor.PRIMARY,
			}),
		);
	}
}
