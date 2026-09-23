/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, getWindow, type Dimension } from "../../../../base/browser/dom.js";
import type { IHoverOptions, IHoverWidget } from "../../../../base/browser/ui/hover/hover.js";
import { HoverPosition } from "../../../../base/browser/ui/hover/hoverWidget.js";
import { createTrustedTypesPolicy } from "../../../../base/browser/trustedTypes.js";
import type { CancellationToken } from "../../../../base/common/cancellation.js";
import { Emitter } from "../../../../base/common/event.js";
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { FileAccess } from "../../../../base/common/network.js";
import type { ICursorPositionChangedEvent } from "../../../../editor/common/cursorEvents.js";
import { ICommandService } from "../../../../platform/commands/common/commands.js";
import { ConfigurationTarget, IConfigurationService } from "../../../../platform/configuration/common/configuration.js";
import { TextEditorSelectionSource, type IEditorOptions } from "../../../../platform/editor/common/editor.js";
import { IHoverService } from "../../../../platform/hover/browser/hover.js";
import { createDecorator, IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import { ILogService } from "../../../../platform/log/common/log.js";
import { FocusMode } from "../../../../platform/native/common/native.js";
import { INotificationService } from "../../../../platform/notification/common/notification.js";
import { IProductService } from "../../../../platform/product/common/productService.js";
import { IEditorProgressService, LongRunningOperation } from "../../../../platform/progress/common/progress.js";
import { IStorageService, StorageScope, StorageTarget } from "../../../../platform/storage/common/storage.js";
import { ITelemetryService } from "../../../../platform/telemetry/common/telemetry.js";
import { ColorScheme } from "../../../../platform/theme/common/theme.js";
import { IThemeService } from "../../../../platform/theme/common/themeService.js";
import { Part } from "../../../../workbench/browser/part.js";
import { EditorPane } from "../../../../workbench/browser/parts/editor/editorPane.js";
import type {
	IEditorControl,
	IEditorOpenContext,
	IEditorPaneSelection,
	IEditorPaneSelectionChangeEvent,
} from "../../../../workbench/common/editor.js";
import { EditorPaneSelectionChangeReason } from "../../../../workbench/common/editor.js";
import type { IEditorGroup } from "../../../../workbench/services/editor/common/editorGroupsService.js";
import { IHostService } from "../../../../workbench/services/host/browser/host.js";
import { IWorkbenchLayoutService, Parts } from "../../../../workbench/services/layout/browser/layoutService.js";
import {
	WHITEBOARD_KEYMAP_SETTING,
	WHITEBOARD_SOFTWARE_MAP_SETTING,
	WHITEBOARD_STRUCTURAL_DIFF_SETTING,
	WHITEBOARD_TELEMETRY_SETTING,
} from "../../../common/whiteboardConfigurationDefaults.js";
import { resolveWhiteboardSourceView, whiteboardSourceAnchor, type WhiteboardSourceView, type WhiteboardSourceSelection } from "../../../common/whiteboardProtocol.js";
import type {
	WhiteboardCanvasBridge,
	WhiteboardCanvasContent,
	WhiteboardCanvasDiagnostic,
	WhiteboardCanvasHandle,
	WhiteboardCanvasHomeSetup,
	WhiteboardCanvasInstallContent,
	WhiteboardCanvasModule,
	WhiteboardCanvasOnboarding,
	WhiteboardCanvasSettingsContent,
	WhiteboardCanvasSetupActions,
	WhiteboardCanvasTutorialBridge,
	WhiteboardCliInstallStatus,
	WhiteboardKeymapChoice,
	WhiteboardRuntimeConfig,
	WhiteboardSurfaceEvent,
	WhiteboardTheme,
	TutorialProgressV1,
	TutorialStepId,
} from "../../../common/whiteboardProtocol.js";
import {
	parseWhiteboardVerbRequest,
	WHITEBOARD_CANVAS_RESUME_EVENT,
	WHITEBOARD_TUTORIAL_PROGRESS_STORAGE_KEY,
	WHITEBOARD_TUTORIAL_STEP_IDS
} from "../../../common/whiteboardProtocol.js";
import { IWhiteboardVerbsService } from "../../../contrib/verbs/whiteboardVerbs.js";
import { IWhiteboardApiCatalogService } from "../../../services/whiteboardApiCatalogService.js";
import { IWhiteboardApiSourceService } from "../../../services/whiteboardApiSourceService.js";
import { IWhiteboardCanvasEditorTabsService } from "../../../services/whiteboardCanvasEditorTabsService.js";
import { IWhiteboardDesktopConnectionService } from "../../../services/whiteboardDesktopConnectionService.js";
import { WhiteboardDiffViewService } from "../../../services/whiteboardDiffViewService.js";
import {
	WhiteboardEmbeddedEditorSelection,
	whiteboardEmbeddedSelectionFromOptions,
} from "../../../services/whiteboardEmbeddedNavigation.js";
import { WhiteboardEmbeddedEditors } from "../../../services/whiteboardEmbeddedEditors.js";
import { IWhiteboardTelemetryService } from "../../../services/whiteboardTelemetryService.js";

import "../../media/whiteboard.css";
import { applyWhiteboardThemeChoice, currentWhiteboardThemeChoice } from "../../whiteboardThemeChoice.js";
import { IWhiteboardExplorerPartsService } from "../explorer/whiteboardExplorerPart.js";
import { WhiteboardCanvasEditorInput } from "./whiteboardCanvasEditorInput.js";

interface WhiteboardCanvasAssetsModule extends WhiteboardCanvasModule {
	readonly clearWhiteboardViewState: (config: WhiteboardRuntimeConfig) => void;
	readonly whiteboardWasmUrl: string;
	readonly whiteboardStylesheetUrls: readonly string[];
}

interface WhiteboardCanvasGlobalThis {
	__zod_globalConfig?: {
		jitless?: boolean;
	};
}

interface WhiteboardCanvasLoadLifecycle {
	ready(): void;
	reportDiagnostic(diagnostic: WhiteboardCanvasDiagnostic): void;
}

type WhiteboardCanvasState = "home" | "connecting" | "active" | "completed" | "error";

const whiteboardCanvasPolicy = createTrustedTypesPolicy("whiteboardCanvas", {
	createScriptURL: (value: string) => value,
});

const requestWhiteboardApi: typeof fetch = (url, init) => fetch(url, init);

function isTutorialStepId(step: unknown): step is TutorialStepId {
	return typeof step === "string" && WHITEBOARD_TUTORIAL_STEP_IDS.includes(step as TutorialStepId);
}
function embeddedSelectionChangeReason(event: ICursorPositionChangedEvent): EditorPaneSelectionChangeReason {
	switch (event.source) {
		case TextEditorSelectionSource.PROGRAMMATIC:
			return EditorPaneSelectionChangeReason.PROGRAMMATIC;
		case TextEditorSelectionSource.NAVIGATION:
			return EditorPaneSelectionChangeReason.NAVIGATION;
		case TextEditorSelectionSource.JUMP:
			return EditorPaneSelectionChangeReason.JUMP;
		default:
			return EditorPaneSelectionChangeReason.USER;
	}
}

export class WhiteboardCanvasEditorPane extends EditorPane {
	static readonly ID = WhiteboardCanvasEditorInput.EDITOR_ID;

	private readonly canvas = this._register(new MutableDisposable<WhiteboardCanvasHandle>());
	private readonly surfaceEvents = this._register(new Emitter<WhiteboardSurfaceEvent>());
	private readonly _onDidChangeSelection = this._register(new Emitter<IEditorPaneSelectionChangeEvent>());
	readonly onDidChangeSelection = this._onDidChangeSelection.event;
	private readonly embeddedSelectionListeners = this._register(new MutableDisposable<DisposableStore>());
	private readonly themeEvents = this._register(new Emitter<WhiteboardTheme>());
	private container: HTMLElement | null = null;
	private canvasMount: HTMLElement | null = null;
	private targetDocument: Document | null = null;
	private apiContent: Extract<WhiteboardCanvasContent, { kind: "api" }> | undefined;
	private loadGeneration = 0;
	private openingGeneration: number | undefined;
	private readonly refreshProgress: LongRunningOperation;
	private renderedInput: WhiteboardCanvasEditorInput | undefined;
	private readyInput: WhiteboardCanvasEditorInput | undefined;
	private assetsPromise: Promise<WhiteboardCanvasAssetsModule> | null = null;
	private readonly modelSubscription = this._register(new MutableDisposable());
	private readonly inlineEditors: WhiteboardEmbeddedEditors;
	private readonly diffViews: WhiteboardDiffViewService;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService private readonly whiteboardThemeService: IThemeService,
		@IStorageService private readonly storageService: IStorageService,
		@IProductService private readonly productService: IProductService,
		@IWhiteboardDesktopConnectionService
		private readonly desktopConnection: IWhiteboardDesktopConnectionService,
		@IWhiteboardApiSourceService private readonly apiSource: IWhiteboardApiSourceService,
		@IWhiteboardApiCatalogService private readonly apiCatalog: IWhiteboardApiCatalogService,
		@IWhiteboardVerbsService private readonly verbs: IWhiteboardVerbsService,
		@IWhiteboardCanvasEditorTabsService
		private readonly tabsService: IWhiteboardCanvasEditorTabsService,
		@IWhiteboardExplorerPartsService
		private readonly explorerParts: IWhiteboardExplorerPartsService,
		@IInstantiationService
		whiteboardInstantiationService: IInstantiationService,
		@IHostService private readonly hostService: IHostService,
		@IWorkbenchLayoutService
		private readonly layoutService: IWorkbenchLayoutService,
		@ICommandService private readonly commandService: ICommandService,
		@IConfigurationService
		private readonly configurationService: IConfigurationService,
		@IWhiteboardTelemetryService
		private readonly whiteboardTelemetryService: IWhiteboardTelemetryService,
		@ILogService private readonly logService: ILogService,
		@IHoverService private readonly hoverService: IHoverService,
		@INotificationService private readonly notificationService: INotificationService,
		@IEditorProgressService editorProgressService: IEditorProgressService,
	) {
		super(WhiteboardCanvasEditorPane.ID, group, telemetryService, whiteboardThemeService, storageService);
		this.inlineEditors = this._register(whiteboardInstantiationService.createInstance(WhiteboardEmbeddedEditors));
		this.refreshProgress = this._register(new LongRunningOperation(editorProgressService));
		this.diffViews = this._register(
			whiteboardInstantiationService.createInstance(WhiteboardDiffViewService, this.inlineEditors),
		);
		this._register(
			verbs.onDidEmitSurfaceEvent((event) => {
				if (
					event.event === "editorSelectionChanged" &&
					event.sessionId !== this.apiContent?.sessionId
				)
					return;
				this.surfaceEvents.fire(event);
			}),
		);
		this._register(
			verbs.onDidRequestCanvasFocus(() => {
				this.canvas.value?.focus();
				void this.hostService.focus(this.targetDocument?.defaultView ?? window);
			}),
		);
		this._register(
			this.inlineEditors.onDidChangeActiveEditor(() => {
				this._onDidChangeControl.fire();
				this.bindEmbeddedSelectionControl();
			}),
		);
		this._register(
			whiteboardThemeService.onDidColorThemeChange(() => {
				const theme = this.colorScheme();
				this.themeEvents.fire(theme);
				this.surfaceEvents.fire({ event: "themeChanged", theme });
			}),
		);
		this._register(desktopConnection.onDidFail((error) => void this.renderFailure(error)));
		this._register(
			configurationService.onDidChangeConfiguration((event) => {
				if (
					!event.affectsConfiguration(WHITEBOARD_SOFTWARE_MAP_SETTING) &&
					!event.affectsConfiguration(WHITEBOARD_STRUCTURAL_DIFF_SETTING)
				)
					return;
				if (this.apiContent) {
					this.apiContent = {
						...this.apiContent,
						structuralDiffEnabled: this.currentStructuralDiffEnabled(),
						softwareMapEnabled: this.currentSoftwareMapEnabled(),
					};
					this.canvas.value?.update(this.apiContent);
					return;
				}
			}),
		);
	}

	protected override createEditor(parent: HTMLElement): void {
		parent.classList.add("whiteboard-canvas-part");
		this.targetDocument = parent.ownerDocument;
		parent.ownerDocument.title = "Whiteboard";
		parent.ownerDocument.body.dataset["whiteboardCanvasMode"] = "renderer";
		const outer = $(".content.whiteboard-canvas-container");
		this.container = $(".whiteboard-canvas-host");
		this.container.tabIndex = -1;
		this.canvasMount = $(".whiteboard-canvas-surface");
		this.container.appendChild(this.canvasMount);
		outer.append(this.container);
		parent.appendChild(outer);
		// Inline peek editors promise fixedOverflowWidgets; their hover and
		// definition widgets must be parented outside .review-canvas-root,
		// whose container-query containment re-anchors and clips
		// position: fixed descendants — but inside .monaco-workbench, where
		// the --vscode-* theme variables that style hover widgets are scoped.
		// One shared host serves every peek in this pane.
		const overflowWidgets = $(".whiteboard-overflow-widgets.monaco-editor");
		this.layoutService.getContainer(getWindow(parent)).appendChild(overflowWidgets);
		this._register(toDisposable(() => overflowWidgets.remove()));
		this.diffViews.setOverflowWidgetsDomNode(overflowWidgets);
		this.desktopConnection.attachControl(async (value) => {
			const request = parseWhiteboardVerbRequest(value);
			if (request.name === "authoringCapabilities") {
				return { ok: true, result: { softwareMapEnabled: this.currentSoftwareMapEnabled() } };
			}
			if (request.name === "openApiWhiteboard") {
				const response = await this.verbs.dispatch(request);
				return response.ok ? { ok: true, result: { softwareMapEnabled: this.currentSoftwareMapEnabled() } } : response;
			}
			if (request.name === "focusWindow") {
				await this.hostService.focus(this.targetDocument?.defaultView ?? window, { mode: FocusMode.Force });
				return { ok: true };
			}
			return this.verbs.dispatch(request);
		});
		void this.desktopConnection.initialize().catch((error) => this.renderError(error));
	}

	override async setInput(
		input: WhiteboardCanvasEditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		const generation = ++this.loadGeneration;
		this.refreshProgress.stop();
		this.openingGeneration = generation;
		try {
			await this.setWhiteboardInput(input, options, context, token, generation);
		} finally {
			if (this.openingGeneration === generation) {
				this.openingGeneration = undefined;
			}
		}
	}

	private async setWhiteboardInput(
		input: WhiteboardCanvasEditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
		generation: number,
	): Promise<void> {
		await super.setInput(input, options, context, token);
		this.restoreEmbeddedSelection(options);
		try {
			await this.desktopConnection.initialize();
		} catch (error) {
			if (generation === this.loadGeneration && !token.isCancellationRequested) {
				await this.renderError(error, generation);
			}
			return;
		}
		if (generation !== this.loadGeneration || token.isCancellationRequested) {
			return;
		}
		if (input.target.kind === "api" && this.readyInput === input && this.renderedInput === input) {
			this.canvasMount?.dispatchEvent(new globalThis.Event(WHITEBOARD_CANVAS_RESUME_EVENT));
			return;
		}
		if (input.target.kind === "api-source") {
			// The Source placeholder replaces the mount, so the reuse shortcuts
			// above must not treat the previous review as still rendered.
			this.renderedInput = input;
			this.readyInput = undefined;
			this.setCanvasState("home");
			await this.render({ kind: "source" }, generation);
			return;
		}
		if (!(await this.resetCanvasForGeneration(generation))) {
			return;
		}
		this.modelSubscription.clear();
		if (input.target.kind === "api") {
			try {
				const { sessionId } = input.target;
				const [connection, assets] = await Promise.all([this.desktopConnection.getConnection(), this.loadAssets()]);
				if (generation !== this.loadGeneration || token.isCancellationRequested) return;
				this.renderedInput = input;
				this.setCanvasState("active", sessionId);
				void this.apiCatalog
					.attention(sessionId, "view")
					.catch((error) => this.logService.warn("[Whiteboard] Could not mark review viewed:", error));
				let sourceSelection: WhiteboardSourceSelection = { sessionId, kind: "current" };
				let sourceView: WhiteboardSourceView = resolveWhiteboardSourceView({ sessionId, version: 0, pins: {} });
				const source = this.apiSource.canvas(() => sourceView, this.inlineEditors, this.diffViews);
				const closeTutorial = () => void this.group.closeEditor(input);
				const updateTutorial = (progress: TutorialProgressV1) => {
					this.writeTutorialProgress(progress);
					if (!this.apiContent) return;
					this.apiContent = {
						...this.apiContent,
						tutorial: this.createTutorialBridge(sessionId, progress, updateTutorial, closeTutorial),
					};
					this.canvas.value?.update(this.apiContent);
				};
				await this.render(
					{
						setTutorial: (enabled) => {
							if (
								!this.apiContent ||
								generation !== this.loadGeneration ||
								enabled === Boolean(this.apiContent.tutorial)
							)
								return;
							this.apiContent = {
								...this.apiContent,
								tutorial: enabled
									? this.createTutorialBridge(sessionId, this.readTutorialProgress(), updateTutorial, closeTutorial)
									: undefined,
							};
							this.canvas.value?.update(this.apiContent);
						},
						kind: "api",
						sessionId,
						structuralDiffEnabled: this.currentStructuralDiffEnabled(),
						softwareMapEnabled: this.currentSoftwareMapEnabled(),
						setTitle: (title) => input.setApiTitle(title),
						setSourceView: (selection, next) => {
							sourceSelection = selection;
							sourceView = next;
							source.openStructuralComparison();
						},
						openSource: (source, range) => this.apiSource.open(source, range),
						bridge: {
							...source,
							...this.sharedBridge(generation, () => {
								this.readyInput = input;
							}),
							config: this.whiteboardRuntimeConfig(
								{
									...connection,
									sessionId: sessionId,
								},
								assets,
							),
							request: requestWhiteboardApi,
							post: async (request) => {
								if (request.name === "openSourceTree") {
									await this.tabsService.openApiSource(sourceSelection, input.getName());
									this.explorerParts.show();
									return { ok: true };
								}
								if (request.name === "reveal") {
									const range = { startLine: request.args.startLine, endLine: request.args.endLine };
									await this.apiSource.open(
										{ view: whiteboardSourceAnchor(sourceView, request.args.pins), file: request.args.path, side: request.args.side ?? "head" },
										range,
									);
									return { ok: true };
								}
								if (request.name === "openDiff") {
									await this.apiSource.openDiff(sourceView, request.args.path);
									return { ok: true };
								}
								return this.verbs.dispatch(request);
							},
						},
					},
					generation,
					assets,
				);
			} catch (error) {
				if (generation === this.loadGeneration) await this.renderError(error, generation);
			}
			return;
		}
		if (input.target.kind === "home") {
			this.renderedInput = input;
			this.setCanvasState("home");
			const setup = await this.resolveHomeSetup();
			await this.apiCatalog.initialize();
			let emptyStateVisible = false;
			/* The empty-list render suspends on the install fetch below, while
			   the list render has no await at all. The sequence number keeps a
			   suspended empty render from resuming after a later list render
			   and overwriting it with a stale snapshot. */
			let renderSeq = 0;
			const renderHome = async () => {
				const seq = ++renderSeq;
				const whiteboards = this.apiCatalog.reviews;
				const isEmpty = whiteboards.length === 0;
				// Only the Welcome rail needs install status; the list must
				// render without waiting on it. One fetch serves both the
				// install card and the onboarding rail.
				const install = isEmpty ? await this.resolveInstallContent() : undefined;
				if (seq !== renderSeq) return;
				if (isEmpty && !emptyStateVisible) {
					this.whiteboardTelemetryService.capture("home_empty_state_viewed");
				}
				emptyStateVisible = isEmpty;
				const openWhiteboard = (uuid: string) => {
					this.whiteboardTelemetryService.capture("review_opened", {
						via: "home",
					});
					const api = this.apiCatalog.reviews.find((whiteboard) => whiteboard.sessionId === uuid);
					return api ? this.tabsService.openApiWhiteboard(uuid, api.title) : Promise.resolve();
				};
				return this.render(
					{
						kind: "home",
						whiteboards,
						openWhiteboard: (uuid) => void openWhiteboard(uuid),
						deleteWhiteboard: (uuid) => this.apiCatalog.deleteWhiteboard(uuid),
						dismissWhiteboard: (uuid) => this.apiCatalog.attention(uuid, "dismiss"),
						restoreWhiteboard: (uuid) => this.apiCatalog.attention(uuid, "restore"),
						openSourceTree: (uuid) => {
							const api = this.apiCatalog.reviews.find((whiteboard) => whiteboard.sessionId === uuid);
							if (api) {
								void this.tabsService.openApiSource({ sessionId: api.sessionId, kind: "current" }, api.title).then(() => this.explorerParts.show());
								return;
							}
						},
						setup,
						// Home shows the Welcome rail while the list is empty.
						install,
						setupActions: this.setupActions(),
						onboarding: install ? this.resolveOnboarding(install.status) : undefined,
						openTutorial: () => this.openTutorial(),
					},
					generation,
				);
			};
			// Home stays live while it is the rendered input: a deletion or a
			// newly published review re-renders the list. render() drops stale
			// generations once another input starts loading.
			const subscriptions = new DisposableStore();
			subscriptions.add(this.desktopConnection.onDidChangeLists(() => void renderHome()));
			subscriptions.add(this.apiCatalog.onDidChange(() => void renderHome()));
			this.modelSubscription.value = subscriptions;
			await renderHome();
			return;
		}
		if (input.target.kind === "welcome") {
			void this.desktopConnection
				.prepareTutorial()
				.catch((error) => this.logService.warn("[Whiteboard] Tutorial preparation did not complete:", error));
			this.renderedInput = input;
			this.setCanvasState("home");
			/* Same stale-resume guard as Home: the install fetch suspends, and
			   a later list event must win over an earlier suspended render. */
			let renderSeq = 0;
			const renderWelcome = async () => {
				const seq = ++renderSeq;
				const install = await this.resolveInstallContent();
				if (seq !== renderSeq) return;
				return this.render(
					{
						kind: "welcome",
						install,
						setupActions: this.setupActions(),
						close: () => void this.group.closeEditor(input),
						onboarding: install ? this.resolveOnboarding(install.status) : undefined,
						openTutorial: () => this.openTutorial(),
					},
					generation,
				);
			};
			// The last step completes when a review publishes, which can happen
			// while this tab sits open.
			this.modelSubscription.value = this.desktopConnection.onDidChangeLists(() => void renderWelcome());
			await renderWelcome();
			return;
		}
		if (input.target.kind === "settings") {
			this.renderedInput = input;
			this.setCanvasState("home");
			const [settings, install] = await Promise.all([this.resolveSettingsContent(), this.resolveInstallContent()]);
			await this.render({ kind: "settings", settings: { ...settings, install } }, generation);
			return;
		}
	}

	override async clearInput(): Promise<void> {
		// Keep apiContent with the mounted canvas so resuming it preserves its review identity.
		// render() replaces both when another input is shown.
		this.refreshProgress.stop();
		await super.clearInput();
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		if (!visible) this.refreshProgress.stop();
	}

	override focus(): void {
		this.canvas.value?.focus();
	}

	showFind(): boolean {
		const editor = this.inlineEditors.activeCodeEditor;
		let seed: string | undefined;
		if (editor?.hasTextFocus()) {
			const model = editor.getModel();
			const selection = editor.getSelection();
			if (model && selection && !selection.isEmpty()) {
				seed = model.getValueInRange(selection);
			}
		}
		return this.canvas.value?.showFind(seed) ?? false;
	}

	override getControl(): IEditorControl | undefined {
		return this.inlineEditors;
	}

	override setOptions(options: IEditorOptions | undefined): void {
		super.setOptions(options);
		this.restoreEmbeddedSelection(options);
	}

	getSelection(): IEditorPaneSelection | undefined {
		const editor = this.inlineEditors.selectionCodeEditor;
		const position = editor?.getPosition();
		const model = editor?.getModel();
		if (!editor || !position || !model) return undefined;
		const domNode = editor.getDomNode();
		const view = domNode?.closest(".whiteboard-files-editor") ? "diff" : "review";
		const section = domNode?.closest<HTMLElement>("[data-whiteboard-section]")?.dataset["whiteboardSection"];
		return new WhiteboardEmbeddedEditorSelection(editor, {
			view,
			path: model.uri.path.slice(1),
			side: new URLSearchParams(model.uri.query).get("side") === "base" ? "base" : "head",
			lineNumber: position.lineNumber,
			column: position.column,
			section,
		});
	}

	private bindEmbeddedSelectionControl(): void {
		const editor = this.inlineEditors.activeCodeEditor;
		if (!editor) {
			this.embeddedSelectionListeners.clear();
			return;
		}
		const store = new DisposableStore();
		store.add(
			editor.onDidFocusEditorText(() => {
				this._onDidChangeSelection.fire({
					reason: EditorPaneSelectionChangeReason.USER,
				});
			}),
		);
		store.add(
			editor.onDidChangeCursorPosition((event) =>
				this._onDidChangeSelection.fire({
					reason: embeddedSelectionChangeReason(event),
				}),
			),
		);
		this.embeddedSelectionListeners.value = store;
	}

	private restoreEmbeddedSelection(options: IEditorOptions | undefined): void {
		const selection = whiteboardEmbeddedSelectionFromOptions(options);
		if (!selection) return;
		selection.restoreInCanvas();
	}

	/**
	 * Retargets the Toggle Inline View command at the in-tab diff. The diff
	 * editor commands duck-type this method on the active pane, so the Review
	 * tab answers for its embedded diff and no-ops in the other views.
	 */
	toggleRenderSideBySide(): void {
		this.diffViews.toggleRenderSideBySide();
	}

	override layout(_dimension: Dimension): void {
		// The canvas uses normal CSS flow and fills the editor pane.
	}

	private setupActions(): WhiteboardCanvasSetupActions {
		return {
			load: () => this.loadInstallContent(),
			installCli: async () => { await this.commandService.executeCommand("whiteboard.installCliInPath"); },
		};
	}

	private async resolveInstallContent(): Promise<WhiteboardCanvasInstallContent | undefined> {
		try {
			return await this.loadInstallContent();
		} catch (error) {
			this.logService.warn("Whiteboard agent setup status failed", error);
			return undefined;
		}
	}

	private async loadInstallContent(): Promise<WhiteboardCanvasInstallContent> {
		const status = await this.desktopConnection.getCliInstallStatus();
		return {
			status,
			apply: async (request) => {
				await this.desktopConnection.applyCliInstall(request);
				return this.desktopConnection.getCliInstallStatus();
			},
			remove: async (request) => {
				await this.desktopConnection.removeCliInstall(request);
				return this.desktopConnection.getCliInstallStatus();
			},
			decline: async () => {
				await this.desktopConnection.declineCliInstall();
				return this.desktopConnection.getCliInstallStatus();
			},
			skip: async () => {
				await this.desktopConnection.skipCliInstallPrompts();
				return this.desktopConnection.getCliInstallStatus();
			},
			enablePrompts: async () => {
				await this.desktopConnection.resetCliInstallPrompts();
				return this.desktopConnection.getCliInstallStatus();
			},
		};
	}

	private openTutorial(): void {
		// The command opens and focuses the tutorial tab itself, and reports
		// its own failures. Welcome stays open behind it: it is a hub the
		// reader comes back to, not a one-shot wizard.
		void this.commandService.executeCommand("whiteboard.openTutorial");
	}

	/**
	 * Settings state and actions for the Settings page. Every value lives in
	 * workbench configuration, apart from the retention window, which the review
	 * server owns. Extensions reuse the existing quick pick.
	 */
	private async resolveSettingsContent(): Promise<WhiteboardCanvasSettingsContent> {
		// Settings must render even when the server preference cannot be read;
		// the row then shows the default, off.
		const scratchpadEnabled = await this.desktopConnection.readScratchpadEnabled().catch(() => false);
		return {
			telemetryEnabled: this.currentTelemetryEnabled(),
			setTelemetryEnabled: async (enabled) => {
				this.whiteboardTelemetryService.capture("setting_changed", {
					setting: "telemetry_enabled",
					enabled,
				});
				if (!enabled) {
					await this.whiteboardTelemetryService.flush();
				}
				await this.configurationService.updateValue(WHITEBOARD_TELEMETRY_SETTING, enabled, ConfigurationTarget.USER);
				return this.currentTelemetryEnabled();
			},
			theme: currentWhiteboardThemeChoice(this.configurationService, this.whiteboardThemeService),
			setTheme: async (choice) => {
				await applyWhiteboardThemeChoice(this.configurationService, choice);
				return currentWhiteboardThemeChoice(this.configurationService, this.whiteboardThemeService);
			},
			keymap: this.currentKeymap(),
			setKeymap: async (choice) => {
				this.whiteboardTelemetryService.capture("setting_changed", {
					setting: "keymap",
					enabled: true,
				});
				await this.commandService.executeCommand("whiteboard.setKeymap", choice);
				return this.currentKeymap();
			},
			softwareMapEnabled: this.currentSoftwareMapEnabled(),
			setSoftwareMapEnabled: async (enabled) => {
				this.whiteboardTelemetryService.capture("setting_changed", {
					setting: "software_map_enabled",
					enabled,
				});
				await this.configurationService.updateValue(WHITEBOARD_SOFTWARE_MAP_SETTING, enabled, ConfigurationTarget.USER);
				return this.currentSoftwareMapEnabled();
			},
			scratchpadEnabled,
			setScratchpadEnabled: async (enabled) => {
				this.whiteboardTelemetryService.capture("setting_changed", {
					setting: "scratchpad_enabled",
					enabled,
				});
				return this.desktopConnection.setScratchpadEnabled(enabled);
			},
			structuralDiffEnabled: this.currentStructuralDiffEnabled(),
			setStructuralDiffEnabled: async (enabled) => {
				await this.configurationService.updateValue(
					WHITEBOARD_STRUCTURAL_DIFF_SETTING,
					enabled,
					ConfigurationTarget.USER,
				);
				return this.currentStructuralDiffEnabled();
			},
			reloadWindow: async () => { await this.commandService.executeCommand("workbench.action.reloadWindow"); },
			diffrConfig: {
				saveSummarizer: (input) => this.desktopConnection.saveDiffrSummarizer(input),
				testSummarizer: (input) => this.desktopConnection.testDiffrSummarizer(input),
				read: () => this.desktopConnection.readDiffrConfig(),
				set: (key, value) => {
					this.whiteboardTelemetryService.capture("setting_changed", {
						setting: "diffr_config",
						enabled: true,
					});
					return this.desktopConnection.setDiffrConfigValue(key, value);
				},
			},
			manageExtensions: () => void this.commandService.executeCommand("whiteboard.manageExtensions"),
		};
	}

	private currentKeymap(): WhiteboardKeymapChoice {
		return this.configurationService.getValue<WhiteboardKeymapChoice>(WHITEBOARD_KEYMAP_SETTING) ?? "none";
	}

	private currentStructuralDiffEnabled(): boolean {
		return (
			this.configurationService.getValue<boolean>(
				WHITEBOARD_STRUCTURAL_DIFF_SETTING,
			) === true
		);
	}

	private currentSoftwareMapEnabled(): boolean {
		return this.configurationService.getValue<boolean>(WHITEBOARD_SOFTWARE_MAP_SETTING) === true;
	}

	// The setting ships as true, so only an explicit false means opted out.
	private currentTelemetryEnabled(): boolean {
		return this.configurationService.getValue<boolean>(WHITEBOARD_TELEMETRY_SETTING) !== false;
	}

	/**
	 * Install status for the Home setup banner. Home must render even when the
	 * status endpoint fails, so a failure yields no banner.
	 */
	private async resolveHomeSetup(): Promise<WhiteboardCanvasHomeSetup | undefined> {
		try {
			return {
				status: await this.desktopConnection.getCliInstallStatus(),
				open: () => void this.tabsService.openWelcome(true),
			};
		} catch {
			return undefined;
		}
	}

	/**
	 * Step state for the Welcome rail, derived from the install status the
	 * caller already fetched, so one render costs one status round-trip. The
	 * rest is local: stored tutorial progress and the review list.
	 */
	private resolveOnboarding(status: WhiteboardCliInstallStatus): WhiteboardCanvasOnboarding {
		const checked = new Set(this.readTutorialProgress().checked);
		const steps = WHITEBOARD_TUTORIAL_STEP_IDS.filter((step) => step !== "openMap" || this.currentSoftwareMapEnabled());
		return {
			installed: status.agents.some((agent) => agent.installed),
			tutorialChecked: steps.filter((step) => checked.has(step)).length,
			tutorialTotal: steps.length,
			// Drafts are filtered out of this list and the tutorial never
			// joins it, so this counts only a real published review.
			published: this.apiCatalog.reviews.length > 0,
		};
	}

	private createTutorialBridge(
		sessionId: string,
		progress: TutorialProgressV1,
		onChange: (progress: TutorialProgressV1) => void,
		close: () => void,
	): WhiteboardCanvasTutorialBridge {
		/* Mutations re-read stored progress instead of using the captured
		   snapshot: two events arriving before the re-rendered bridge lands
		   (hover then goto-definition) must not clobber each other. */
		const setStep = (step: TutorialStepId, checked: boolean) => {
			if (!WHITEBOARD_TUTORIAL_STEP_IDS.includes(step)) return;
			const current = this.readTutorialProgress();
			if (current.checked.includes(step) === checked) return;
			const values = new Set(current.checked);
			if (checked) values.add(step);
			else values.delete(step);
			onChange({ ...current, checked: [...values] });
		};
		return {
			content: { sessionId, progress, keymap: this.currentKeymap() },
			setStep,
			dismiss: () => onChange({ ...this.readTutorialProgress(), dismissed: true }),
			reopen: () => onChange({ ...this.readTutorialProgress(), dismissed: false }),
			selectKeymap: async (keymap) => {
				if (keymap !== "none" && keymap !== "vim" && keymap !== "emacs") {
					throw new Error("Unsupported tutorial keymap choice.");
				}
				setStep("chooseKeymap", true);
				try {
					/* The keymap command may reload the window before its promise can
					   settle. Persist the completed step first so the restored tutorial
					   advances from the choice the user already made. */
					await this.commandService.executeCommand("whiteboard.setKeymap", keymap);
				} catch (error) {
					setStep("chooseKeymap", false);
					throw error;
				}
			},
			close,
		};
	}

	private readTutorialProgress(): TutorialProgressV1 {
		const empty: TutorialProgressV1 = {
			version: 1,
			checked: [],
			dismissed: false,
		};
		const raw = this.storageService.get(WHITEBOARD_TUTORIAL_PROGRESS_STORAGE_KEY, StorageScope.APPLICATION);
		if (!raw) return empty;
		try {
			const value = JSON.parse(raw) as {
				version?: unknown;
				checked?: unknown;
				dismissed?: unknown;
				steps?: unknown;
			};
			if (
				value.version !== 1 ||
				!Array.isArray(value.steps) ||
				!Array.isArray(value.checked) ||
				!value.checked.every(isTutorialStepId) ||
				typeof value.dismissed !== "boolean"
			) {
				throw new Error("Invalid tutorial progress.");
			}
			const checked = new Set(value.checked);
			const known = value.steps.filter(isTutorialStepId);
			if (known.length > 0 && known.every((step) => checked.has(step))) {
				for (const step of WHITEBOARD_TUTORIAL_STEP_IDS) {
					checked.add(step);
				}
			}
			return {
				version: 1,
				checked: [...checked],
				dismissed: value.dismissed,
			};
		} catch {
			this.writeTutorialProgress(empty);
			return empty;
		}
	}

	private writeTutorialProgress(progress: TutorialProgressV1): void {
		this.storageService.store(
			WHITEBOARD_TUTORIAL_PROGRESS_STORAGE_KEY,
			// `steps` marks which step ids existed at write time, so a later
			// release can tell a finished tour from one its new steps reopened.
			JSON.stringify({ ...progress, steps: WHITEBOARD_TUTORIAL_STEP_IDS }),
			StorageScope.APPLICATION,
			StorageTarget.MACHINE,
		);
	}

	private async renderFailure(error: Error): Promise<void> {
		this.refreshProgress.stop();
		const generation = ++this.loadGeneration;
		if (await this.resetCanvasForGeneration(generation)) {
			await this.renderError(error, generation);
		}
	}

	private async renderError(error: unknown, generation?: number): Promise<void> {
		const activeGeneration = generation ?? ++this.loadGeneration;
		this.setCanvasState("error");
		await this.render(
			{
				kind: "error",
				message: error instanceof Error ? error.message : String(error),
			},
			activeGeneration,
		);
	}

	private async render(
		content: WhiteboardCanvasContent,
		generation: number,
		loadedAssets?: WhiteboardCanvasAssetsModule,
	): Promise<void> {
		if (!this.canvasMount) return;
		const assets = loadedAssets ?? (await this.loadAssets());
		if (generation !== this.loadGeneration) return;
		this.apiContent = content.kind === "api" ? content : undefined;
		if (this.canvas.value) {
			this.canvas.value.update(content);
		} else {
			this.canvas.value = assets.mountWhiteboardCanvas(this.canvasMount, content);
		}
	}

	private loadAssets(): Promise<WhiteboardCanvasAssetsModule> {
		this.assetsPromise ??= this.importAssets().catch((error) => {
			this.assetsPromise = null;
			throw error;
		});
		return this.assetsPromise;
	}

	private async importAssets(): Promise<WhiteboardCanvasAssetsModule> {
		// Zod 4 probes the Function constructor unless its CSP-safe mode is set
		// before the canvas module graph is evaluated. Chromium reports the caught
		// probe as a Trusted Types violation, so configure the bundled authoring
		// runtime before importing it instead of weakening the workbench policy.
		const canvasGlobal = globalThis as WhiteboardCanvasGlobalThis;
		canvasGlobal.__zod_globalConfig ??= {};
		canvasGlobal.__zod_globalConfig.jitless = true;

		const url = FileAccess.asBrowserUri("vs/whiteboard/canvas/canvas-loader.js").toString(true);
		const trustedUrl = whiteboardCanvasPolicy?.createScriptURL(url) ?? (url as string);
		const assets = (await import(
			/* webpackIgnore: true */ trustedUrl as unknown as string
		)) as WhiteboardCanvasAssetsModule;
		if (typeof assets.mountWhiteboardCanvas !== "function") {
			throw new Error("Whiteboard canvas bundle has no mount function.");
		}
		await Promise.all(assets.whiteboardStylesheetUrls.map((stylesheet) => loadStylesheet(document, stylesheet)));
		return assets;
	}

	/** The bridge members every canvas shares; `onReady` runs once the mount reports ready. */
	private sharedBridge(
		generation: number,
		onReady: () => void,
		lifecycle?: WhiteboardCanvasLoadLifecycle,
	): Pick<
		WhiteboardCanvasBridge,
		| "appSessionId"
		| "subscribe"
		| "currentTheme"
		| "onDidChangeTheme"
		| "currentDiffLayout"
		| "setDiffLayout"
		| "onDidChangeDiffLayout"
		| "setupTooltip"
		| "notify"
		| "ready"
		| "reportDiagnostic"
	> {
		return {
			appSessionId: this.whiteboardTelemetryService.appSessionId,
			subscribe: (listener) => this.surfaceEvents.event(listener),
			currentTheme: () => this.colorScheme(),
			onDidChangeTheme: (listener) => this.themeEvents.event(listener),
			currentDiffLayout: () => this.diffViews.diffLayout.get(),
			setDiffLayout: (layout) => this.diffViews.diffLayout.set(layout),
			onDidChangeDiffLayout: (listener) => this.diffViews.diffLayout.onDidChange(listener),
			notify: ({ kind, text }) => {
				if (kind === "error") this.notificationService.error(text);
				else this.notificationService.info(text);
			},
			setupTooltip: (target, content) => {
				const store = new DisposableStore();
				const hover = store.add(new MutableDisposable<IHoverWidget>());
				const options: IHoverOptions = {
					target,
					content,
					position: { hoverPosition: HoverPosition.ABOVE },
					appearance: { compact: true, showPointer: true },
					persistence: { hideOnKeyDown: true },
				};
				store.add(addDisposableListener(target, "mouseenter", () => {
					if (target.getAttribute("aria-expanded") === "true") return;
					hover.value = this.hoverService.showDelayedHover(options, { groupId: "whiteboard-topbar", reducedDelay: true });
				}));
				store.add(addDisposableListener(target, "focus", () => {
					if (!target.matches(":focus-visible") || target.getAttribute("aria-expanded") === "true") return;
					hover.value = this.hoverService.showInstantHover(options);
				}));
				for (const event of ["blur", "pointerdown", "click", "keydown"]) {
					store.add(addDisposableListener(target, event, () => hover.clear()));
				}
				return store;
			},
			ready: () => {
				if (generation !== this.loadGeneration || !this.targetDocument) return;
				this.targetDocument.body.dataset["whiteboardCanvasReady"] = "true";
				onReady();
			},
			reportDiagnostic: (diagnostic) => {
				if (generation === this.loadGeneration && diagnostic.level === "error") {
					delete this.targetDocument?.body.dataset["whiteboardCanvasReady"];
				}
				const method = diagnostic.level === "error" ? console.error : console.warn;
				method(`[Whiteboard canvas ${diagnostic.source}] ${diagnostic.message}`, diagnostic.stack ?? "");
				lifecycle?.reportDiagnostic(diagnostic);
			},
		};
	}

	private whiteboardRuntimeConfig(
		connection: Pick<WhiteboardRuntimeConfig, "serverUrl" | "sessionId" | "token">,
		assets: WhiteboardCanvasAssetsModule,
	): WhiteboardRuntimeConfig {
		return {
			...connection,
			wasmUrl: assets.whiteboardWasmUrl,
			appVersion: this.productService.reviewVersion ?? this.productService.version,
			theme: this.colorScheme(),
			host: "desktop",
		};
	}

	private async resetCanvasForGeneration(generation: number): Promise<boolean> {
		if (generation !== this.loadGeneration) {
			return false;
		}
		this.readyInput = undefined;
		this.inlineEditors.reset();
		this.diffViews.reset();
		return generation === this.loadGeneration;
	}

	private setCanvasState(state: WhiteboardCanvasState, sessionId?: string): void {
		if (!this.targetDocument) return;
		this.targetDocument.body.dataset["whiteboardCanvasState"] = state;
		if (state === "active" && sessionId) {
			this.targetDocument.body.dataset["sessionId"] = sessionId;
			delete this.targetDocument.body.dataset["whiteboardCanvasReady"];
		} else {
			delete this.targetDocument.body.dataset["sessionId"];
			delete this.targetDocument.body.dataset["whiteboardCanvasReady"];
		}
	}

	private colorScheme(): WhiteboardTheme {
		const type = this.whiteboardThemeService.getColorTheme().type;
		return type === ColorScheme.LIGHT || type === ColorScheme.HIGH_CONTRAST_LIGHT ? "light" : "dark";
	}
}

class WhiteboardCanvasPlaceholderPart extends Part {
	override readonly minimumWidth = 0;
	override readonly maximumWidth = Number.POSITIVE_INFINITY;
	override readonly minimumHeight = 0;
	override readonly maximumHeight = Number.POSITIVE_INFINITY;

	constructor(
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
	) {
		super(
			Parts.WHITEBOARD_CANVAS_PART,
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
		return parent;
	}

	toJSON(): object {
		return { type: Parts.WHITEBOARD_CANVAS_PART };
	}
}

export const IWhiteboardCanvasPartsService = createDecorator<IWhiteboardCanvasPartsService>("whiteboardCanvasPartsService");

export interface IWhiteboardCanvasPartsService {
	readonly _serviceBrand: undefined;
}

export class WhiteboardCanvasParts extends Disposable implements IWhiteboardCanvasPartsService {
	declare readonly _serviceBrand: undefined;

	constructor(@IInstantiationService instantiationService: IInstantiationService) {
		super();
		this._register(instantiationService.createInstance(WhiteboardCanvasPlaceholderPart));
	}
}

function loadStylesheet(document: Document, url: string): Promise<void> {
	const existing = [...document.querySelectorAll<HTMLLinkElement>('link[data-whiteboard-canvas-stylesheet="true"]')].find(
		(link) => link.href === url,
	);
	if (existing) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const link = document.createElement("link");
		link.rel = "stylesheet";
		link.href = url;
		link.dataset["whiteboardCanvasStylesheet"] = "true";
		link.addEventListener("load", () => resolve(), { once: true });
		link.addEventListener("error", () => reject(new Error(`Whiteboard canvas stylesheet failed: ${url}`)), { once: true });
		document.head.appendChild(link);
	});
}
