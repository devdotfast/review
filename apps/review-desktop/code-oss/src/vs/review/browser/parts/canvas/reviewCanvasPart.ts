/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import "../../media/review.css";
import { $, getWindow, type Dimension } from "../../../../base/browser/dom.js";
import { createTrustedTypesPolicy } from "../../../../base/browser/trustedTypes.js";
import type { CancellationToken } from "../../../../base/common/cancellation.js";
import { Emitter } from "../../../../base/common/event.js";
import {
	Disposable,
	DisposableStore,
	MutableDisposable,
	toDisposable,
} from "../../../../base/common/lifecycle.js";
import type { ICursorPositionChangedEvent } from "../../../../editor/common/cursorEvents.js";
import { FileAccess } from "../../../../base/common/network.js";
import { ICommandService } from "../../../../platform/commands/common/commands.js";
import {
	ConfigurationTarget,
	IConfigurationService,
} from "../../../../platform/configuration/common/configuration.js";
import { createDecorator, IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import { FocusMode } from "../../../../platform/native/common/native.js";
import {
	TextEditorSelectionSource,
	type IEditorOptions,
} from "../../../../platform/editor/common/editor.js";
import { ILogService } from "../../../../platform/log/common/log.js";
import { IProductService } from "../../../../platform/product/common/productService.js";
import {
	IStorageService,
	StorageScope,
	StorageTarget,
} from "../../../../platform/storage/common/storage.js";
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
import {
	IWorkbenchLayoutService,
	Parts,
} from "../../../../workbench/services/layout/browser/layoutService.js";
import { ITelemetryService } from "../../../../platform/telemetry/common/telemetry.js";
import {
	parseReviewListResponse,
	parseReviewVerbRequest,
	parseReviewSessionResponse,
	DEFAULT_DISMISSED_RETENTION_DAYS,
	REVIEW_CANVAS_RESUME_EVENT,
	REVIEW_TUTORIAL_PROGRESS_STORAGE_KEY,
	REVIEW_TUTORIAL_STEP_IDS,
} from "../../../common/reviewProtocol.js";
import {
	canRestoreReviewCanvasScrollSnapshot,
	canReuseReviewCanvas,
	preserveReviewCanvasScrollSnapshot,
	type ReviewCanvasScrollSnapshot,
} from "../../../common/reviewCanvasReuse.js";
import type {
	ReviewCanvasBridge,
	ReviewCanvasDiagnostic,
	ReviewCanvasContent,
	ReviewCanvasHandle,
	ReviewCanvasOnboarding,
	ReviewCanvasHomeSetup,
	ReviewCanvasInstallContent,
	ReviewCanvasModule,
	ReviewCanvasSettingsContent,
	ReviewCanvasTutorialBridge,
	ReviewCliInstallStatus,
	ReviewKeymapChoice,
	ReviewRuntimeConfig,
	ReviewSessionDescriptor,
	ReviewSurfaceEvent,
	ReviewTheme,
	TutorialProgressV1,
	TutorialStepId,
	ReviewVerbResponse,
} from "../../../common/reviewProtocol.js";
import {
	REVIEW_KEYMAP_SETTING,
	REVIEW_SOFTWARE_MAP_SETTING,
	REVIEW_TELEMETRY_SETTING,
} from "../../../common/reviewConfigurationDefaults.js";
import {
	applyReviewThemeChoice,
	currentReviewThemeChoice,
} from "../../reviewThemeChoice.js";
import { IReviewVerbsService } from "../../../contrib/verbs/reviewVerbs.js";
import { ReviewInlineEditorService } from "../../../services/reviewInlineEditorService.js";
import { ReviewDiffViewService } from "../../../services/reviewDiffViewService.js";
import { IReviewDiffService } from "../../../services/reviewDiffService.js";
import {
	ReviewEmbeddedEditorSelection,
	reviewEmbeddedSelectionFromOptions,
} from "../../../services/reviewEmbeddedNavigation.js";
import {
	REVIEW_BASE_SCHEME,
	reviewResourceIdentity,
} from "../../../common/reviewCodeResources.js";
import { reviewTelemetryEventRequest } from "../../../common/reviewTelemetryRequest.js";
import { IReviewTelemetryService } from "../../../services/reviewTelemetryService.js";
import { IReviewSessionService } from "../../../services/reviewSessionService.js";
import { ReviewCommentStore } from "../../../services/reviewCommentStore.js";
import {
	IReviewSessionModelService,
	loadReviewSessionCanvasDocument,
	loadReviewSessionSoftwareMap,
	type ReviewDesktopSession,
	type ReviewSessionModel,
	reviewSessionApiRequest,
} from "../../../services/reviewSessionModelService.js";
import { IReviewCanvasEditorTabsService } from "../../../services/reviewCanvasEditorTabsService.js";
import { IReviewExplorerPartsService } from "../explorer/reviewExplorerPart.js";
import { ReviewCanvasEditorInput } from "./reviewCanvasEditorInput.js";
import {
	loadReviewDocumentModule,
	loadReviewSoftwareMapModules,
} from "./reviewDocumentModule.js";

interface ReviewCanvasAssetsModule extends ReviewCanvasModule {
	readonly clearReviewViewState: (config: ReviewRuntimeConfig) => void;
	readonly reviewDocRuntimeUrl: string;
	readonly reviewWasmUrl: string;
	readonly reviewStylesheetUrls: readonly string[];
}

interface ReviewCanvasGlobalThis {
	__zod_globalConfig?: {
		jitless?: boolean;
	};
}

interface ReviewCanvasLoadLifecycle {
	ready(): void;
	reportDiagnostic(diagnostic: ReviewCanvasDiagnostic): void;
}

type ReviewCanvasState =
	| "home"
	| "connecting"
	| "active"
	| "completed"
	| "error";

const reviewCanvasPolicy = createTrustedTypesPolicy("reviewCanvas", {
	createScriptURL: (value: string) => value,
});

const detachedScrollRestoreDeadlineMs = 30_000;

// The tutorial step list as it first shipped. Stored progress payloads
// without a `steps` field date from this era.
const LAUNCH_TUTORIAL_STEP_IDS: readonly TutorialStepId[] = [
	"openPeek",
	"gotoDefinition",
	"showHover",
	"openSequence",
	"chooseKeymap",
];

function isTutorialStepId(step: unknown): step is TutorialStepId {
	return (
		typeof step === "string" &&
		REVIEW_TUTORIAL_STEP_IDS.includes(step as TutorialStepId)
	);
}
// First commit is not proof of document health: effect-driven errors land
// just after it. Mount validation holds its success signal for this settle
// window so an error diagnostic reported from an effect still fails the
// publish. Interaction-driven errors (for example a tour opened later) are
// out of reach for any window.
const mountValidationSettleMs = 2_000;

function embeddedSelectionChangeReason(
	event: ICursorPositionChangedEvent,
): EditorPaneSelectionChangeReason {
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

export class ReviewCanvasEditorPane extends EditorPane {
	static readonly ID = ReviewCanvasEditorInput.EDITOR_ID;

	private readonly canvas = this._register(
		new MutableDisposable<ReviewCanvasHandle>(),
	);
	private readonly surfaceEvents = this._register(
		new Emitter<ReviewSurfaceEvent>(),
	);
	private readonly _onDidChangeSelection = this._register(
		new Emitter<IEditorPaneSelectionChangeEvent>(),
	);
	readonly onDidChangeSelection = this._onDidChangeSelection.event;
	private readonly embeddedSelectionListeners = this._register(
		new MutableDisposable<DisposableStore>(),
	);
	private readonly themeEvents = this._register(new Emitter<ReviewTheme>());
	private container: HTMLElement | null = null;
	private canvasMount: HTMLElement | null = null;
	private targetDocument: Document | null = null;
	private loadGeneration = 0;
	private renderedInput: ReviewCanvasEditorInput | undefined;
	private renderedModel: ReviewSessionModel | null = null;
	private readyInput: ReviewCanvasEditorInput | undefined;
	private detachedScrollSnapshot: ReviewCanvasScrollSnapshot | undefined;
	private detachedScrollRestoreFrame: number | null = null;
	private detachedScrollRestoreDeadline: number | null = null;
	private assetsPromise: Promise<ReviewCanvasAssetsModule> | null = null;
	private readonly modelSubscription = this._register(
		new MutableDisposable(),
	);
	private readonly inlineEditors: ReviewInlineEditorService;
	private readonly diffViews: ReviewDiffViewService;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService private readonly reviewThemeService: IThemeService,
		@IStorageService private readonly storageService: IStorageService,
		@IProductService private readonly productService: IProductService,
		@IReviewSessionService
		private readonly sessionService: IReviewSessionService,
		@IReviewSessionModelService
		private readonly sessionModelService: IReviewSessionModelService,
		@IReviewDiffService private readonly diffService: IReviewDiffService,
		@IReviewVerbsService private readonly verbs: IReviewVerbsService,
		@IReviewCanvasEditorTabsService
		private readonly tabsService: IReviewCanvasEditorTabsService,
		@IReviewExplorerPartsService
		private readonly explorerParts: IReviewExplorerPartsService,
		@IInstantiationService
		reviewInstantiationService: IInstantiationService,
		@IHostService private readonly hostService: IHostService,
		@IWorkbenchLayoutService
		private readonly layoutService: IWorkbenchLayoutService,
		@ICommandService private readonly commandService: ICommandService,
		@IConfigurationService
		private readonly configurationService: IConfigurationService,
		@IReviewTelemetryService
		private readonly reviewTelemetryService: IReviewTelemetryService,
		@ILogService private readonly logService: ILogService,
	) {
		super(
			ReviewCanvasEditorPane.ID,
			group,
			telemetryService,
			reviewThemeService,
			storageService,
		);
		this.inlineEditors = this._register(
			reviewInstantiationService.createInstance(ReviewInlineEditorService),
		);
		this.diffViews = this._register(
			reviewInstantiationService.createInstance(
				ReviewDiffViewService,
				this.inlineEditors,
			),
		);
		this._register(
			verbs.onDidEmitSurfaceEvent((event) => {
				if (this.targetDocument) {
					this.targetDocument.body.dataset["reviewLastSurfaceEvent"] =
						event.event === "threadDecorationClicked"
							? `${event.event}:${event.threadId}`
							: event.event;
				}
				this.surfaceEvents.fire(event);
			}),
		);
		this._register(
			verbs.onDidRequestCanvasFocus(() => {
				this.canvas.value?.focus();
				void this.hostService.focus(
					this.targetDocument?.defaultView ?? window,
				);
			}),
		);
		this._register(
			this.inlineEditors.onDidChangeActiveEditor(() => {
				this._onDidChangeControl.fire();
				this.bindEmbeddedSelectionControl();
			}),
		);
		this._register(
			reviewThemeService.onDidColorThemeChange(() => {
				const theme = this.colorScheme();
				this.themeEvents.fire(theme);
				this.surfaceEvents.fire({ event: "themeChanged", theme });
			}),
		);
		this._register(
			sessionService.onDidFail((error) => void this.renderFailure(error)),
		);
		this._register(
			configurationService.onDidChangeConfiguration((event) => {
				if (!event.affectsConfiguration(REVIEW_SOFTWARE_MAP_SETTING)) return;
				const input = this.renderedInput;
				const model = this.renderedModel;
				if (!input || !model || model.state !== "active") return;
				void this.refreshModel(input, model);
			}),
		);
	}

	protected override createEditor(parent: HTMLElement): void {
		parent.classList.add("review-canvas-part");
		this.targetDocument = parent.ownerDocument;
		parent.ownerDocument.title = "Review";
		parent.ownerDocument.body.dataset["reviewCanvasMode"] = "renderer";
		const outer = $(".content.review-canvas-container");
		this.container = $(".review-canvas-host");
		this.container.tabIndex = -1;
		this.canvasMount = $(".review-canvas-surface");
		this.container.appendChild(this.canvasMount);
		outer.append(this.container);
		parent.appendChild(outer);
		// Inline peek editors promise fixedOverflowWidgets; their hover and
		// definition widgets must be parented outside .review-canvas-root,
		// whose container-query containment re-anchors and clips
		// position: fixed descendants — but inside .monaco-workbench, where
		// the --vscode-* theme variables that style hover widgets are scoped.
		// One shared host serves every peek in this pane.
		const overflowWidgets = $(".review-overflow-widgets.monaco-editor");
		this.layoutService
			.getContainer(getWindow(parent))
			.appendChild(overflowWidgets);
		this._register(toDisposable(() => overflowWidgets.remove()));
		this.inlineEditors.setOverflowWidgetsDomNode(overflowWidgets);
		this.diffViews.setOverflowWidgetsDomNode(overflowWidgets);
		this.sessionService.attachControl(async (sessionId, value) => {
			const request = parseReviewVerbRequest(value);
			if (request.name === "focusWindow") {
				await this.hostService.focus(
					this.targetDocument?.defaultView ?? window,
					{ mode: FocusMode.Force },
				);
				return { ok: true };
			}
			// Mount validation targets an unpromoted session; it must never open
			// a visible tab or touch the active model.
			if (request.name === "validateCanvasMount") {
				return this.validateSessionMount(sessionId);
			}
			const input = await this.tabsService.openSession(sessionId, true);
			const model = await input.resolve();
			if (
				!model ||
				model.state !== "active" ||
				model.session.session.sessionId !== sessionId
			) {
				return {
					ok: false,
					error: `Review session ${sessionId} could not be activated.`,
				};
			}
			this.sessionModelService.setActiveModel(model);
			return this.verbs.dispatch(sessionId, request);
		});
		void this.sessionService
			.initialize()
			.catch((error) => this.renderError(error));
	}

	override async setInput(
		input: ReviewCanvasEditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		const generation = ++this.loadGeneration;
		await super.setInput(input, options, context, token);
		this.restoreEmbeddedSelection(options);
		try {
			await this.sessionService.initialize();
		} catch (error) {
			if (
				generation === this.loadGeneration &&
				!token.isCancellationRequested
			) {
				await this.renderError(error, generation);
			}
			return;
		}
		if (
			generation !== this.loadGeneration ||
			token.isCancellationRequested
		) {
			return;
		}
		const warmModel = input.resolvedModel;
		if (
			input.target.kind === "review" &&
			warmModel &&
			canReuseReviewCanvas({
				input,
				readyInput: this.readyInput,
				model: warmModel,
				renderedModel: this.renderedModel,
				modelState: warmModel.state,
			})
		) {
			this.sessionModelService.setActiveModel(warmModel);
			this.canvasMount?.dispatchEvent(
				new globalThis.Event(REVIEW_CANVAS_RESUME_EVENT),
			);
			this.restoreDetachedScrollSnapshot(input, warmModel, generation);
			return;
		}
		if (input.target.kind === "source") {
			this.renderedInput = input;
			this.renderedModel = null;
			this.readyInput = undefined;
			this.inlineEditors.reset();
			this.diffViews.reset();
			this.modelSubscription.clear();
			// Not the full session reset the other branches run: the Source tab
			// exists to browse the active review's worktree beside the tabs the
			// tree opened. `verbs.resetSession()` would close those tabs, and
			// clearing the active model would drop the workspace folder — the
			// tree's root — out from under the browse.
			//
			// With no active session (Home clears it), activate the tab's
			// preferred review instead — without opening its document tab. The
			// held reference keeps the pinned worktree leased while browsing.
			if (!this.sessionModelService.activeModel && input.preferredReview) {
				try {
					// The input owns the acquisition: the session and its
					// pinned-worktree lease live exactly as long as the tab.
					const model = await input.resolveSourceModel();
					if (generation !== this.loadGeneration) {
						return;
					}
					if (model) {
						this.sessionModelService.setActiveModel(model);
					}
				} catch (error) {
					this.logService.warn(
						`[review] source tab cannot activate review ${input.preferredReview}: ${error}`,
					);
					this.setSessionState("home");
					await this.render(
						{
							kind: "source",
							error:
								error instanceof Error ? error.message : String(error),
						},
						generation,
					);
					return;
				}
			}
			this.setSessionState("home");
			await this.render({ kind: "source" }, generation);
			return;
		}
		this.detachedScrollSnapshot = undefined;
		this.detachedScrollRestoreDeadline = null;
		if (!(await this.resetSessionForGeneration(generation))) {
			return;
		}
		this.modelSubscription.clear();
		if (input.target.kind === "home") {
			this.renderedInput = input;
			this.renderedModel = null;
			this.sessionModelService.setActiveModel(null);
			this.setSessionState("home");
			const setup = await this.resolveHomeSetup();
			let emptyStateVisible = false;
			/* The empty-list render suspends on the install fetch below, while
			   the list render has no await at all. The sequence number keeps a
			   suspended empty render from resuming after a later list render
			   and overwriting it with a stale snapshot. */
			let renderSeq = 0;
			const renderHome = async () =>
				{
					const seq = ++renderSeq;
					const isEmpty = this.sessionService.reviews.length === 0;
					// Only the Welcome rail needs install status; the list must
					// render without waiting on it. One fetch serves both the
					// install card and the onboarding rail.
					const install = isEmpty
						? await this.resolveInstallContent()
						: undefined;
					if (seq !== renderSeq) return;
					if (isEmpty && !emptyStateVisible) {
						this.reviewTelemetryService.capture("home_empty_state_viewed");
					}
					emptyStateVisible = isEmpty;
					const openReview = (uuid: string) => {
						this.reviewTelemetryService.capture("review_opened", {
							via: "home",
						});
						return this.tabsService.openReview(uuid, true);
					};
					return this.render(
					{
						kind: "home",
						reviews: this.sessionService.reviews,
						reviewErrors: this.sessionService.reviewErrors,
						openReview: (uuid) => void openReview(uuid),
						deleteReview: (uuid) => this.sessionService.deleteReview(uuid),
						dismissReview: (uuid) => this.sessionService.dismissReview(uuid),
						restoreReview: (uuid) => this.sessionService.restoreReview(uuid),
						openSourceTree: (uuid) => {
							this.reviewTelemetryService.capture("source_tree_opened", {
								via: "home",
							});
							// Only the Source tab opens. Its activation acquires the
							// review's session itself, which roots the workspace
							// folder — and therefore the tree — at the pinned
							// worktree, without opening the review document.
							void this.tabsService
								.openSource(true, uuid)
								.then(() => this.explorerParts.show());
						},
						setup,
						// Home shows the Welcome rail while the list is empty.
						install,
						onboarding: install
							? this.resolveOnboarding(install.status)
							: undefined,
						openTutorial: () => this.openTutorial(),
					},
					generation,
					);
				};
			// Home stays live while it is the rendered input: a deletion or a
			// newly published review re-renders the list. render() drops stale
			// generations once another input starts loading.
			this.modelSubscription.value = this.sessionService.onDidChangeLists(
				() => void renderHome(),
			);
			await renderHome();
			return;
		}
		if (input.target.kind === "welcome") {
			void this.sessionService.prepareTutorial().catch((error) =>
				this.logService.warn(
					"[Review] Tutorial preparation did not complete:",
					error,
				),
			);
			this.renderedInput = input;
			this.renderedModel = null;
			this.sessionModelService.setActiveModel(null);
			this.setSessionState("home");
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
						close: () => void this.group.closeEditor(input),
						onboarding: install
							? this.resolveOnboarding(install.status)
							: undefined,
						openTutorial: () => this.openTutorial(),
					},
					generation,
				);
			};
			// The last step completes when a review publishes, which can happen
			// while this tab sits open.
			this.modelSubscription.value = this.sessionService.onDidChangeLists(
				() => void renderWelcome(),
			);
			await renderWelcome();
			return;
		}
		if (input.target.kind === "settings") {
			this.renderedInput = input;
			this.renderedModel = null;
			this.sessionModelService.setActiveModel(null);
			this.setSessionState("home");
			const [settings, install] = await Promise.all([
				this.resolveSettingsContent(),
				this.resolveInstallContent(),
			]);
			await this.render(
				{ kind: "settings", settings: { ...settings, install } },
				generation,
			);
			return;
		}
		this.setSessionState("connecting");
		let model: ReviewSessionModel | null;
		try {
			model = await input.resolve();
		} catch (error) {
			if (
				generation === this.loadGeneration &&
				!token.isCancellationRequested
			) {
				this.sessionModelService.setActiveModel(null);
				await this.renderError(error, generation);
			}
			return;
		}
		if (!model) {
			throw new Error("The review editor input has no session model.");
		}
		if (generation !== this.loadGeneration || token.isCancellationRequested) {
			return;
		}
		this.modelSubscription.value = model.onDidChange(() => {
			if (
				this.sessionModelService.activeModel === model ||
				this.renderedModel === model
			) {
				void this.refreshModel(input, model);
			}
		});
		await this.renderModel(input, model, generation);
	}

	override async clearInput(): Promise<void> {
		if (this.detachedScrollRestoreFrame !== null) {
			cancelAnimationFrame(this.detachedScrollRestoreFrame);
			this.detachedScrollRestoreFrame = null;
		}
		this.detachedScrollRestoreDeadline = null;
		this.detachedScrollSnapshot =
			this.renderedInput &&
			this.renderedModel &&
			this.targetDocument
				? preserveReviewCanvasScrollSnapshot(
						this.detachedScrollSnapshot,
						this.renderedInput,
						this.renderedModel,
						this.targetDocument,
					)
				: undefined;
		await super.clearInput();
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

	private restoreDetachedScrollSnapshot(
		input: ReviewCanvasEditorInput,
		model: ReviewSessionModel,
		generation: number,
	): void {
		const snapshot = this.detachedScrollSnapshot;
		if (
			!canRestoreReviewCanvasScrollSnapshot(snapshot, {
				input,
				model,
				modelState: model.state,
			})
		) {
			this.detachedScrollSnapshot = undefined;
			this.detachedScrollRestoreDeadline = null;
			return;
		}
		this.detachedScrollRestoreDeadline =
			performance.now() + detachedScrollRestoreDeadlineMs;
		const finish = () => {
			if (this.detachedScrollSnapshot === snapshot) {
				this.detachedScrollSnapshot = undefined;
			}
			this.detachedScrollRestoreDeadline = null;
		};
		const schedule = () => {
			this.detachedScrollRestoreFrame = requestAnimationFrame(apply);
		};
		const apply = () => {
			this.detachedScrollRestoreFrame = null;
			if (
				generation !== this.loadGeneration ||
				this.renderedInput !== input ||
				this.renderedModel !== model ||
				this.sessionModelService.activeModel !== model
			) {
				finish();
				return;
			}
			const region = this.targetDocument?.querySelector<HTMLElement>(
				".review-view-region",
			);
			if (
				this.readyInput === input &&
				this.canvasMount?.isConnected &&
				region?.isConnected &&
				region.clientHeight > 0
			) {
				const expected = Math.min(
					snapshot.scrollTop,
					Math.max(0, region.scrollHeight - region.clientHeight),
				);
				region.scrollTop = snapshot.scrollTop;
				if (Math.abs(region.scrollTop - expected) <= 1) {
					finish();
					return;
				}
			}
			if (
				performance.now() < (this.detachedScrollRestoreDeadline ?? 0)
			) {
				schedule();
			} else {
				finish();
			}
		};
		schedule();
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
		const session = this.renderedModel?.state === "active"
			? this.renderedModel.session
			: undefined;
		if (!editor || !position || !model || !session) {
			return undefined;
		}
		const identity = reviewResourceIdentity(session, model.uri);
		if (!identity) return undefined;
		const domNode = editor.getDomNode();
		const view = domNode?.closest(".review-files-editor") ? "diff" : "review";
		const section = domNode
			?.closest<HTMLElement>("[data-review-section]")
			?.dataset["reviewSection"];
		return new ReviewEmbeddedEditorSelection(editor, {
			view,
			path: identity.path,
			side: identity.scheme === REVIEW_BASE_SCHEME ? "base" : "head",
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
		const selection = reviewEmbeddedSelectionFromOptions(options);
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

	/**
	 * Install status for the Agent Setup page. The page must render even when
	 * the status endpoint fails (an older server, a race during startup), so a
	 * failure yields no install content rather than an error state.
	 */
	private async resolveInstallContent(): Promise<
		ReviewCanvasInstallContent | undefined
	> {
		try {
			const status = await this.sessionService.getCliInstallStatus();
			return {
				status,
				apply: async (request) => {
					await this.sessionService.applyCliInstall(request);
					return this.sessionService.getCliInstallStatus();
				},
				remove: async (request) => {
					await this.sessionService.removeCliInstall(request);
					return this.sessionService.getCliInstallStatus();
				},
				decline: async () => {
					await this.sessionService.declineCliInstall();
					return this.sessionService.getCliInstallStatus();
				},
				skip: async () => {
					await this.sessionService.skipCliInstallPrompts();
					return this.sessionService.getCliInstallStatus();
				},
				enablePrompts: async () => {
					await this.sessionService.resetCliInstallPrompts();
					return this.sessionService.getCliInstallStatus();
				},
			};
		} catch {
			return undefined;
		}
	}

	private openTutorial(): void {
		// The command opens and focuses the tutorial tab itself, and reports
		// its own failures. Welcome stays open behind it: it is a hub the
		// reader comes back to, not a one-shot wizard.
		void this.commandService.executeCommand("review.openTutorial");
	}

	/**
	 * Settings state and actions for the Settings page. Every value lives in
	 * workbench configuration, apart from the retention window, which the review
	 * server owns. Extensions reuse the existing quick pick.
	 */
	private async resolveSettingsContent(): Promise<ReviewCanvasSettingsContent> {
		return {
			telemetryEnabled: this.currentTelemetryEnabled(),
			setTelemetryEnabled: async (enabled) => {
				this.reviewTelemetryService.capture("setting_changed", {
					setting: "telemetry_enabled",
					enabled,
				});
				if (!enabled) {
					await this.reviewTelemetryService.flush();
				}
				await this.configurationService.updateValue(
					REVIEW_TELEMETRY_SETTING,
					enabled,
					ConfigurationTarget.USER,
				);
				return this.currentTelemetryEnabled();
			},
			theme: currentReviewThemeChoice(
				this.configurationService,
				this.reviewThemeService,
			),
			setTheme: async (choice) => {
				await applyReviewThemeChoice(this.configurationService, choice);
				return currentReviewThemeChoice(
					this.configurationService,
					this.reviewThemeService,
				);
			},
			keymap: this.currentKeymap(),
			setKeymap: async (choice) => {
				this.reviewTelemetryService.capture("setting_changed", {
					setting: "keymap",
					enabled: true,
				});
				await this.commandService.executeCommand("review.setKeymap", choice);
				return this.currentKeymap();
			},
			dismissedRetentionDays: await this.currentRetentionDays(),
			setDismissedRetentionDays: async (days) => {
				this.reviewTelemetryService.capture("setting_changed", {
					setting: "dismissed_retention_days",
					enabled: days !== null,
				});
				return this.sessionService.setDismissedRetentionDays(days);
			},
			softwareMapEnabled: this.currentSoftwareMapEnabled(),
			setSoftwareMapEnabled: async (enabled) => {
				this.reviewTelemetryService.capture("setting_changed", {
					setting: "software_map_enabled",
					enabled,
				});
				await this.configurationService.updateValue(
					REVIEW_SOFTWARE_MAP_SETTING,
					enabled,
					ConfigurationTarget.USER,
				);
				return this.currentSoftwareMapEnabled();
			},
			manageExtensions: () =>
				void this.commandService.executeCommand("review.manageExtensions"),
		};
	}

	/**
	 * The retention window lives in the review server, so a read can fail. The
	 * shipped default is the honest answer then: it is what the reaper uses when
	 * it finds no stored preference.
	 */
	private async currentRetentionDays(): Promise<number | null> {
		try {
			return await this.sessionService.readDismissedRetentionDays();
		} catch (error) {
			this.logService.warn(
				`Could not read the review retention preference: ${error}`,
			);
			return DEFAULT_DISMISSED_RETENTION_DAYS;
		}
	}

	private currentKeymap(): ReviewKeymapChoice {
		return (
			this.configurationService.getValue<ReviewKeymapChoice>(
				REVIEW_KEYMAP_SETTING,
			) ?? "none"
		);
	}

	private currentSoftwareMapEnabled(): boolean {
		return (
			this.configurationService.getValue<boolean>(
				REVIEW_SOFTWARE_MAP_SETTING,
			) === true
		);
	}

	// The setting ships as true, so only an explicit false means opted out.
	private currentTelemetryEnabled(): boolean {
		return (
			this.configurationService.getValue<boolean>(REVIEW_TELEMETRY_SETTING) !==
			false
		);
	}

	/**
	 * Install status for the Home setup banner. Home must render even when the
	 * status endpoint fails, so a failure yields no banner.
	 */
	private async resolveHomeSetup(): Promise<
		ReviewCanvasHomeSetup | undefined
	> {
		try {
			return {
				status: await this.sessionService.getCliInstallStatus(),
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
	private resolveOnboarding(
		status: ReviewCliInstallStatus,
	): ReviewCanvasOnboarding {
		const checked = new Set(this.readTutorialProgress().checked);
		const steps = REVIEW_TUTORIAL_STEP_IDS.filter(
			(step) => step !== "openMap" || this.currentSoftwareMapEnabled(),
		);
		return {
			installed: status.agents.some((agent) => agent.installed),
			tutorialChecked: steps.filter((step) =>
				checked.has(step),
			).length,
			tutorialTotal: steps.length,
			// Drafts are filtered out of this list and the tutorial never
			// joins it, so this counts only a real published review.
			published: this.sessionService.reviews.length > 0,
		};
	}

	private resolveTutorialBridge(
		reviewUuid: string,
		onChange: (progress: TutorialProgressV1) => void,
		close: () => void,
	): ReviewCanvasTutorialBridge | undefined {
		// The tutorial descriptor is cached by the open call, and a tutorial
		// tab can only exist after that call. Identifying the tutorial from
		// the cache keeps ordinary review renders free of any status fetch,
		// and cannot transiently fail and drop the checklist.
		if (this.sessionService.tutorialReview?.uuid !== reviewUuid) {
			return undefined;
		}
		return this.createTutorialBridge(
			reviewUuid,
			this.readTutorialProgress(),
			onChange,
			close,
		);
	}

	private createTutorialBridge(
		reviewUuid: string,
		progress: TutorialProgressV1,
		onChange: (progress: TutorialProgressV1) => void,
		close: () => void,
	): ReviewCanvasTutorialBridge {
		/* Mutations re-read stored progress instead of using the captured
		   snapshot: two events arriving before the re-rendered bridge lands
		   (hover then goto-definition) must not clobber each other. */
		const setStep = (step: TutorialStepId, checked: boolean) => {
			if (!REVIEW_TUTORIAL_STEP_IDS.includes(step)) return;
			const current = this.readTutorialProgress();
			if (current.checked.includes(step) === checked) return;
			const values = new Set(current.checked);
			if (checked) values.add(step);
			else values.delete(step);
			onChange({ ...current, checked: [...values] });
		};
		return {
			content: { reviewUuid, progress, keymap: this.currentKeymap() },
			setStep,
			dismiss: () =>
				onChange({ ...this.readTutorialProgress(), dismissed: true }),
			reopen: () =>
				onChange({ ...this.readTutorialProgress(), dismissed: false }),
			selectKeymap: async (keymap) => {
				if (keymap !== "none" && keymap !== "vim" && keymap !== "emacs") {
					throw new Error("Unsupported tutorial keymap choice.");
				}
				setStep("chooseKeymap", true);
				try {
					/* The keymap command may reload the window before its promise can
					   settle. Persist the completed step first so the restored tutorial
					   advances from the choice the user already made. */
					await this.commandService.executeCommand("review.setKeymap", keymap);
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
		const raw = this.storageService.get(
			REVIEW_TUTORIAL_PROGRESS_STORAGE_KEY,
			StorageScope.APPLICATION,
		);
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
				!Array.isArray(value.checked) ||
				!value.checked.every(isTutorialStepId) ||
				typeof value.dismissed !== "boolean"
			) {
				throw new Error("Invalid tutorial progress.");
			}
			const checked = new Set(value.checked);
			/* `steps` records the step list the writer knew (older payloads
			   predate the field and default to the launch list). A release
			   that adds a step must not un-finish an already finished tour:
			   when every step the writer knew is checked, the steps added
			   since count as checked too. */
			const known = Array.isArray(value.steps)
				? value.steps.filter(isTutorialStepId)
				: LAUNCH_TUTORIAL_STEP_IDS;
			if (known.length > 0 && known.every((step) => checked.has(step))) {
				for (const step of REVIEW_TUTORIAL_STEP_IDS) {
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
			REVIEW_TUTORIAL_PROGRESS_STORAGE_KEY,
			// `steps` marks which step ids existed at write time, so a later
			// release can tell a finished tour from one its new steps reopened.
			JSON.stringify({ ...progress, steps: REVIEW_TUTORIAL_STEP_IDS }),
			StorageScope.APPLICATION,
			StorageTarget.MACHINE,
		);
	}

	private async renderModel(
		input: ReviewCanvasEditorInput,
		model: ReviewSessionModel,
		generation: number,
	): Promise<void> {
		this.renderedInput = input;
		this.renderedModel = model;
		this.readyInput = undefined;
		if (model.state === "completed") {
			this.sessionModelService.setActiveModel(null);
			this.setSessionState("completed");
			await this.render(
				{
					kind: "completed",
					reviewPath: model.session.session.reviewPath,
					showHome: () => void this.tabsService.openHome(true),
				},
				generation,
			);
			return;
		}
		if (model.state === "unavailable") {
			this.sessionModelService.setActiveModel(null);
			await this.renderError(
				model.unavailableMessage ?? "Review session is unavailable.",
				generation,
			);
			return;
		}
		this.sessionModelService.setActiveModel(model);
		await this.load(input, model, generation);
	}

	private async load(
		input: ReviewCanvasEditorInput,
		model: ReviewSessionModel,
		generation: number,
	): Promise<Error | null> {
		if (!this.container) {
			return new Error("Review canvas container is unavailable.");
		}
		const session = model.session;
		this.readyInput = undefined;
		this.setSessionState("active", session.session.sessionId);
		let loadTimeout: ReturnType<typeof setTimeout> | undefined;
		let finishLoad!: (error: Error | null) => void;
		const loadResult = new Promise<Error | null>((resolve) => {
			let finished = false;
			finishLoad = (error) => {
				if (finished) return;
				finished = true;
				resolve(error);
			};
		});
		try {
			void this.diffService.prefetch().catch((error) => {
				this.logService.debug(`[review] diff prefetch failed: ${error}`);
			});
			const assets = await this.loadAssets();
			if (generation !== this.loadGeneration) {
				return new Error("Review canvas load was superseded.");
			}
			const document = model.resolveDocument((activeSession, moduleUrl) =>
				loadReviewDocumentModule(
					activeSession,
					moduleUrl,
					assets.reviewDocRuntimeUrl,
				),
			);
			const softwareMapEnabled = this.currentSoftwareMapEnabled();
			const softwareMap = softwareMapEnabled
				? model.resolveSoftwareMap(
						(activeSession, headModuleUrl, baseModuleUrl) =>
							loadReviewSoftwareMapModules(
								activeSession,
								headModuleUrl,
								baseModuleUrl,
							),
					)
				: Promise.resolve(null);
			const bridge = this.createBridge(model, assets, generation, {
				ready: () => {
					if (this.renderedInput === input && this.renderedModel === model) {
						this.readyInput = input;
					}
					finishLoad(null);
				},
				reportDiagnostic: (diagnostic) => {
					if (diagnostic.level === "error") {
						finishLoad(new Error(diagnostic.message));
					}
				},
			});
			if (input.takeViewStateResetRequest()) {
				assets.clearReviewViewState(bridge.config);
			}
			let tutorial: ReviewCanvasTutorialBridge | undefined;
			const renderSession = () =>
				this.render(
					{
					kind: "session",
					bridge,
					document,
					softwareMap,
					softwareMapEnabled,
					reviewErrors: this.sessionService.reviewErrors,
					commits: model.session.review.commits ?? [],
					range: {
						baseRef: model.session.review.baseRef ?? session.session.baseRef,
						headRef: model.session.review.headRef ?? session.session.headRef ?? session.session.baseRef,
						baseCommit: session.session.baseRef,
						headCommit: session.session.headRef ?? session.session.baseRef,
					},
					...(tutorial ? { tutorial } : {}),
					},
					generation,
					assets,
				);
			if (input.target.kind === "review") {
				const reviewUuid = input.target.reviewUuid;
				const closeTutorial = () => void this.group.closeEditor(input);
				const updateTutorial = (next: TutorialProgressV1) => {
					this.writeTutorialProgress(next);
					tutorial = this.createTutorialBridge(
						reviewUuid,
						next,
						updateTutorial,
						closeTutorial,
					);
					void renderSession();
				};
				tutorial = this.resolveTutorialBridge(
					reviewUuid,
					updateTutorial,
					closeTutorial,
				);
			}
			await renderSession();
			loadTimeout = setTimeout(
				() =>
					finishLoad(
						new Error(
							"Review canvas did not complete its first React commit within 30 seconds.",
						),
					),
				30_000,
			);
			const result = await loadResult;
			if (generation !== this.loadGeneration) {
				return new Error("Review canvas load was superseded.");
			}
			// A watchdog timeout or a document diagnostic resolves loadResult
			// with an error instead of throwing. Render it, or the canvas keeps
			// its skeleton forever with no message.
			if (result) {
				await this.renderError(result, generation);
			}
			return result;
		} catch (error) {
			if (generation === this.loadGeneration) {
				await this.renderError(error, generation);
			}
			return reviewLoadError(error);
		} finally {
			if (loadTimeout) clearTimeout(loadTimeout);
		}
	}

	private async refreshModel(
		input: ReviewCanvasEditorInput,
		model: ReviewSessionModel,
	): Promise<void> {
		const generation = ++this.loadGeneration;
		if (
			model.state !== "active" &&
			!(await this.resetSessionForGeneration(generation))
		) {
			return;
		}
		await this.renderModel(input, model, generation);
	}

	private async renderFailure(error: Error): Promise<void> {
		const generation = ++this.loadGeneration;
		if (await this.resetSessionForGeneration(generation)) {
			await this.renderError(error, generation);
		}
	}

	private async renderError(
		error: unknown,
		generation?: number,
	): Promise<void> {
		const activeGeneration = generation ?? ++this.loadGeneration;
		this.setSessionState("error");
		await this.render(
			{
				kind: "error",
				message: error instanceof Error ? error.message : String(error),
				reviewErrors: this.sessionService.reviewErrors,
			},
			activeGeneration,
		);
	}

	private async render(
		content: ReviewCanvasContent,
		generation: number,
		loadedAssets?: ReviewCanvasAssetsModule,
	): Promise<void> {
		if (!this.canvasMount) return;
		const assets = loadedAssets ?? (await this.loadAssets());
		if (generation !== this.loadGeneration) return;
		if (this.canvas.value) {
			this.canvas.value.update(content);
		} else {
			this.canvas.value = assets.mountReviewCanvas(this.canvasMount, content);
		}
	}

	private loadAssets(): Promise<ReviewCanvasAssetsModule> {
		this.assetsPromise ??= this.importAssets().catch((error) => {
			this.assetsPromise = null;
			throw error;
		});
		return this.assetsPromise;
	}

	private async importAssets(): Promise<ReviewCanvasAssetsModule> {
		// Zod 4 probes the Function constructor unless its CSP-safe mode is set
		// before the canvas module graph is evaluated. Chromium reports the caught
		// probe as a Trusted Types violation, so configure the bundled authoring
		// runtime before importing it instead of weakening the workbench policy.
		const canvasGlobal = globalThis as ReviewCanvasGlobalThis;
		canvasGlobal.__zod_globalConfig ??= {};
		canvasGlobal.__zod_globalConfig.jitless = true;

		const url = FileAccess.asBrowserUri(
			"vs/review/canvas/canvas-loader.js",
		).toString(true);
		const trustedUrl =
			reviewCanvasPolicy?.createScriptURL(url) ?? (url as string);
		const assets = (await import(
			/* webpackIgnore: true */ trustedUrl as unknown as string
		)) as ReviewCanvasAssetsModule;
		if (typeof assets.mountReviewCanvas !== "function") {
			throw new Error("Review canvas bundle has no mount function.");
		}
		await Promise.all(
			assets.reviewStylesheetUrls.map((stylesheet) =>
				loadStylesheet(document, stylesheet),
			),
		);
		return assets;
	}

	private createBridge(
		model: ReviewSessionModel,
		assets: ReviewCanvasAssetsModule,
		generation: number,
		lifecycle?: ReviewCanvasLoadLifecycle,
	): ReviewCanvasBridge {
		const session = model.session;
		const config = this.reviewRuntimeConfig(session, assets);
		return {
			appSessionId: this.reviewTelemetryService.appSessionId,
			config,
			comments: model.comments,
			inlineEditors: this.inlineEditors,
			diffView: this.diffViews,
			request: (url, init) => model.request(url, init),
			post: (request) =>
				this.verbs.dispatch(session.session.sessionId, request),
			subscribe: (listener) => this.surfaceEvents.event(listener),
			currentTheme: () => this.colorScheme(),
			onDidChangeTheme: (listener) => this.themeEvents.event(listener),
			ready: () => {
				if (generation !== this.loadGeneration || !this.targetDocument) return;
				this.targetDocument.body.dataset["reviewCanvasReady"] = "true";
				lifecycle?.ready();
				void this.captureReviewPresented(model);
			},
			reportDiagnostic: (diagnostic) => {
				if (generation === this.loadGeneration && diagnostic.level === "error") {
					delete this.targetDocument?.body.dataset["reviewCanvasReady"];
				}
				const method =
					diagnostic.level === "error" ? console.error : console.warn;
				method(
					`[Review canvas ${diagnostic.source}] ${diagnostic.message}`,
					diagnostic.stack ?? "",
				);
				lifecycle?.reportDiagnostic(diagnostic);
			},
		};
	}

	private reviewRuntimeConfig(
		session: ReviewDesktopSession,
		assets: ReviewCanvasAssetsModule,
	): ReviewRuntimeConfig {
		return {
			serverUrl: session.serverUrl,
			sessionUrl: session.sessionUrl,
			routePath: session.descriptor.routePath,
			sessionId: session.session.sessionId,
			token: session.token,
			wasmUrl: assets.reviewWasmUrl,
			docRuntimeUrl: assets.reviewDocRuntimeUrl,
			appVersion:
				this.productService.reviewVersion ?? this.productService.version,
			theme: this.colorScheme(),
			host: "desktop",
		};
	}

	private async captureReviewPresented(model: ReviewSessionModel): Promise<void> {
		const session = model.session;
		await model.request(
			`${session.sessionUrl}/__progressive-review/telemetry/event`,
			reviewTelemetryEventRequest(
				{
					token: session.token,
					appSessionId: this.reviewTelemetryService.appSessionId,
				},
				{ name: "review_presented" },
				{ keepalive: true },
			),
		).catch(() => undefined);
	}

	/**
	 * Publish gate: mount a not-yet-promoted session's document into an
	 * off-screen container and report whether it reaches its first React
	 * commit and stays free of error diagnostics through the settle window.
	 * The visible canvas and the active model stay untouched. A clean
	 * validation also warms the document-module cache for the visible mount
	 * that follows promotion.
	 */
	private async validateSessionMount(
		sessionId: string,
	): Promise<ReviewVerbResponse> {
		const targetDocument = this.targetDocument;
		if (!targetDocument) {
			return { ok: false, error: "Review canvas is unavailable." };
		}
		let container: HTMLElement | undefined;
		let handle: ReviewCanvasHandle | undefined;
		let comments: ReviewCommentStore | undefined;
		let loadTimeout: ReturnType<typeof setTimeout> | undefined;
		let settleTimeout: ReturnType<typeof setTimeout> | undefined;
		try {
			const assets = await this.loadAssets();
			const session = await this.resolveValidationSession(sessionId);
			const documentPromise = loadReviewSessionCanvasDocument(
				session,
				(draftSession, moduleUrl) =>
					loadReviewDocumentModule(
						draftSession,
						moduleUrl,
						assets.reviewDocRuntimeUrl,
					),
			);
			const softwareMapPromise = loadReviewSessionSoftwareMap(
				session,
				loadReviewSoftwareMapModules,
			);
			comments = new ReviewCommentStore({
				request: (endpoint, init) =>
					reviewSessionApiRequest(session, endpoint, init),
			});
			let finished = false;
			let finishMount!: (error: Error | null) => void;
			const mountResult = new Promise<Error | null>((resolve) => {
				finishMount = (error) => {
					if (finished) return;
					finished = true;
					resolve(error);
				};
			});
			const bridge: ReviewCanvasBridge = {
				appSessionId: this.reviewTelemetryService.appSessionId,
				config: this.reviewRuntimeConfig(session, assets),
				comments,
				inlineEditors: this.inlineEditors,
				// A validation mount must build no diff widgets off-screen and
				// must not write the visible pane's view-state cache.
				diffView: {
					create: () => ({
						dispose: () => undefined,
						focus: () => undefined,
						onDidError: () => ({ dispose: () => undefined }),
					}),
				},
				request: (url, init) => fetch(url, init),
				// Verbs act on the visible workbench; a validation mount must not
				// touch it, so verb posts succeed as no-ops.
				post: async () => ({ ok: true }),
				subscribe: () => ({ dispose: () => undefined }),
				currentTheme: () => this.colorScheme(),
				onDidChangeTheme: () => ({ dispose: () => undefined }),
				ready: () => {
					if (finished || settleTimeout) {
						return;
					}
					settleTimeout = setTimeout(
						() => finishMount(null),
						mountValidationSettleMs,
					);
				},
				reportDiagnostic: (diagnostic) => {
					if (diagnostic.level === "error") {
						finishMount(new Error(diagnostic.message));
					}
				},
			};
			container = targetDocument.createElement("div");
			container.style.position = "fixed";
			container.style.left = "-10000px";
			container.style.top = "0";
			container.style.width = "1280px";
			container.style.height = "800px";
			container.style.overflow = "hidden";
			container.style.pointerEvents = "none";
			targetDocument.body.appendChild(container);
			handle = assets.mountReviewCanvas(container, {
				kind: "session",
				bridge,
				document: documentPromise,
				softwareMap: softwareMapPromise,
				softwareMapEnabled: true,
				reviewErrors: this.sessionService.reviewErrors,
				commits: session.review.commits ?? [],
				range: {
					baseRef: session.review.baseRef ?? session.session.baseRef,
					headRef: session.review.headRef ?? session.session.headRef ?? session.session.baseRef,
					baseCommit: session.session.baseRef,
					headCommit: session.session.headRef ?? session.session.baseRef,
				},
			});
			loadTimeout = setTimeout(
				() =>
					finishMount(
						new Error(
							"Review document did not complete its first React commit within 30 seconds.",
						),
					),
				30_000,
			);
			const error = await mountResult;
			return error ? { ok: false, error: error.message } : { ok: true };
		} catch (error) {
			return {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			};
		} finally {
			if (loadTimeout) clearTimeout(loadTimeout);
			if (settleTimeout) clearTimeout(settleTimeout);
			handle?.dispose();
			container?.remove();
			comments?.dispose();
		}
	}

	private async resolveValidationSession(
		sessionId: string,
	): Promise<ReviewDesktopSession> {
		// The draft session must stay invisible to the UI: fetch descriptors
		// straight from the server instead of refreshing the session service,
		// whose list events would open a tab for the unpromoted session.
		const connection = await this.sessionService.getConnection();
		const sessionsResponse = await fetch(
			`${connection.serverUrl}/sessions?limit=100`,
			{
				headers: { "x-review-token": connection.token },
				signal: AbortSignal.timeout(5_000),
			},
		);
		if (!sessionsResponse.ok) {
			throw new Error(
				`Review sessions returned ${sessionsResponse.status}.`,
			);
		}
		const descriptor = (
			(await sessionsResponse.json()) as {
				items: ReviewSessionDescriptor[];
			}
		).items.find((candidate) => candidate.sessionId === sessionId);
		if (!descriptor) {
			throw new Error(`Review session is unavailable: ${sessionId}`);
		}
		const reviewsResponse = await fetch(
			`${connection.serverUrl}/reviews?limit=100`,
			{
				headers: { "x-review-token": connection.token },
				signal: AbortSignal.timeout(5_000),
			},
		);
		if (!reviewsResponse.ok) {
			throw new Error(`Review list returned ${reviewsResponse.status}.`);
		}
		const review = parseReviewListResponse(
			await reviewsResponse.json(),
		).reviews.find((candidate) => candidate.uuid === descriptor.reviewUuid);
		if (!review) {
			throw new Error(`Review is unavailable: ${descriptor.reviewUuid}`);
		}
		const response = await fetch(
			`${descriptor.sessionUrl}/__progressive-review/session`,
			{
				headers: { "x-review-token": connection.token },
				signal: AbortSignal.timeout(5_000),
			},
		);
		const payload = parseReviewSessionResponse(await response.json());
		if (!response.ok || !payload.ok) {
			throw new Error(
				payload.ok
					? `Review session returned ${response.status}.`
					: payload.error,
			);
		}
		if (!payload.session.sessionId || !payload.session.storageDir) {
			throw new Error("Review server session is missing desktop fields.");
		}
		return {
			serverUrl: connection.serverUrl,
			sessionUrl: descriptor.sessionUrl,
			token: connection.token,
			descriptor,
			review,
			session: payload.session as ReviewDesktopSession["session"],
		};
	}

	private async resetSessionForGeneration(
		generation: number,
	): Promise<boolean> {
		if (generation !== this.loadGeneration) {
			return false;
		}
		this.readyInput = undefined;
		this.inlineEditors.reset();
		this.diffViews.reset();
		await this.verbs.resetSession();
		return generation === this.loadGeneration;
	}

	private setSessionState(
		state: ReviewCanvasState,
		sessionId?: string,
	): void {
		if (!this.targetDocument) return;
		this.targetDocument.body.dataset["reviewSessionState"] = state;
		if (state === "active" && sessionId) {
			this.targetDocument.body.dataset["reviewSessionId"] = sessionId;
			delete this.targetDocument.body.dataset["reviewCanvasReady"];
		} else {
			delete this.targetDocument.body.dataset["reviewSessionId"];
			delete this.targetDocument.body.dataset["reviewCanvasReady"];
		}
	}

	private colorScheme(): ReviewTheme {
		const type = this.reviewThemeService.getColorTheme().type;
		return type === ColorScheme.LIGHT ||
			type === ColorScheme.HIGH_CONTRAST_LIGHT
			? "light"
			: "dark";
	}
}

class ReviewCanvasPlaceholderPart extends Part {
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
			Parts.REVIEW_CANVAS_PART,
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
		return { type: Parts.REVIEW_CANVAS_PART };
	}
}

export const IReviewCanvasPartsService = createDecorator<IReviewCanvasPartsService>('reviewCanvasPartsService');

export interface IReviewCanvasPartsService {
	readonly _serviceBrand: undefined;
}

export class ReviewCanvasParts extends Disposable implements IReviewCanvasPartsService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this._register(
			instantiationService.createInstance(ReviewCanvasPlaceholderPart),
		);
	}
}

function loadStylesheet(document: Document, url: string): Promise<void> {
	const existing = [
		...document.querySelectorAll<HTMLLinkElement>(
			'link[data-review-canvas-stylesheet="true"]',
		),
	].find((link) => link.href === url);
	if (existing) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const link = document.createElement("link");
		link.rel = "stylesheet";
		link.href = url;
		link.dataset["reviewCanvasStylesheet"] = "true";
		link.addEventListener("load", () => resolve(), { once: true });
		link.addEventListener(
			"error",
			() => reject(new Error(`Review canvas stylesheet failed: ${url}`)),
			{ once: true },
		);
		document.head.appendChild(link);
	});
}

function reviewLoadError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
