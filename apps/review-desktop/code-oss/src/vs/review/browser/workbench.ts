/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../workbench/browser/style.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../base/common/lifecycle.js';
import { Emitter, Event, setGlobalLeakWarningThreshold } from '../../base/common/event.js';
import { Dimension, IDimension, addDisposableListener, getActiveDocument, getActiveElement, getClientArea, getWindowId, getWindows, isAncestorUsingFlowTo, isHTMLElement, runWhenWindowIdle, size } from '../../base/browser/dom.js';
import { DeferredPromise, RunOnceScheduler } from '../../base/common/async.js';
import { isChrome, isFirefox, isFullscreen, isSafari, onDidChangeFullscreen } from '../../base/browser/browser.js';
import { mark } from '../../base/common/performance.js';
import { onUnexpectedError, setUnexpectedErrorHandler } from '../../base/common/errors.js';
import { ReviewErrorReportLimiter } from '../common/reviewErrorReport.js';
import { IReviewTelemetryService } from '../services/reviewTelemetryService.js';
import { isLinux, isMacintosh, isNative, isWeb, isWindows } from '../../base/common/platform.js';
import { IPartVisibilityChangeEvent, IWorkbenchLayoutService, MULTI_WINDOW_PARTS, PanelAlignment, Parts, Position, SINGLE_WINDOW_PARTS } from '../../workbench/services/layout/browser/layoutService.js';
import { ILayoutOffsetInfo } from '../../platform/layout/browser/layoutService.js';
import { Part } from '../../workbench/browser/part.js';
import { Direction, ISerializableView, ISerializedGrid, ISerializedLeafNode, ISerializedNode, IViewSize, Orientation, SerializableGrid } from '../../base/browser/ui/grid/grid.js';
import { IEditorGroupsService } from '../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../workbench/services/editor/common/editorService.js';
import { IPaneCompositePartService } from '../../workbench/services/panecomposite/browser/panecomposite.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../workbench/common/views.js';
import { ILogService } from '../../platform/log/common/log.js';
import { IInstantiationService, ServicesAccessor, refineServiceDecorator } from '../../platform/instantiation/common/instantiation.js';
import { ITitleService } from '../../workbench/services/title/browser/titleService.js';
import { CodeWindow, mainWindow } from '../../base/browser/window.js';
import { coalesce } from '../../base/common/arrays.js';
import { ServiceCollection } from '../../platform/instantiation/common/serviceCollection.js';
import { InstantiationService } from '../../platform/instantiation/common/instantiationService.js';
import { getSingletonServiceDescriptors } from '../../platform/instantiation/common/extensions.js';
import { ILifecycleService, LifecyclePhase, WillShutdownEvent } from '../../workbench/services/lifecycle/common/lifecycle.js';
import { IStorageService, StorageScope, StorageTarget, WillSaveStateReason } from '../../platform/storage/common/storage.js';
import { IConfigurationChangeEvent, IConfigurationService } from '../../platform/configuration/common/configuration.js';
import { IHostService } from '../../workbench/services/host/browser/host.js';
import { IDialogService } from '../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../platform/notification/common/notification.js';
import { NotificationService } from '../../workbench/services/notification/common/notificationService.js';
import { IHoverService, WorkbenchHoverDelegate } from '../../platform/hover/browser/hover.js';
import { setHoverDelegateFactory } from '../../base/browser/ui/hover/hoverDelegateFactory.js';
import { setBaseLayerHoverDelegate } from '../../base/browser/ui/hover/hoverDelegate2.js';
import { Registry } from '../../platform/registry/common/platform.js';
import { IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../workbench/common/contributions.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorWillOpenEvent } from '../../workbench/common/editor.js';
import { setARIAContainer } from '../../base/browser/ui/aria/aria.js';
import { FontMeasurements } from '../../editor/browser/config/fontMeasurements.js';
import { createBareFontInfoFromRawSettings } from '../../editor/common/config/fontInfoFromSettings.js';
import { toErrorMessage } from '../../base/common/errorMessage.js';
import { WorkbenchContextKeysHandler } from '../../workbench/browser/contextkeys.js';
import { PixelRatio } from '../../base/browser/pixelRatio.js';
import { AccessibilityProgressSignalScheduler } from '../../platform/accessibilitySignal/browser/progressAccessibilitySignalScheduler.js';
import { setProgressAccessibilitySignalScheduler } from '../../base/browser/ui/progressbar/progressAccessibilitySignal.js';
import { AccessibleViewRegistry } from '../../platform/accessibility/browser/accessibleViewRegistry.js';
import { NotificationAccessibleView } from '../../workbench/browser/parts/notifications/notificationAccessibleView.js';
import { NotificationsCenter } from '../../workbench/browser/parts/notifications/notificationsCenter.js';
import { NotificationsAlerts } from '../../workbench/browser/parts/notifications/notificationsAlerts.js';
import { NotificationsStatus } from '../../workbench/browser/parts/notifications/notificationsStatus.js';
import { registerNotificationCommands } from '../../workbench/browser/parts/notifications/notificationsCommands.js';
import { NotificationsToasts } from '../../workbench/browser/parts/notifications/notificationsToasts.js';
import { IMarkdownRendererService } from '../../platform/markdown/browser/markdownRenderer.js';
import { EditorMarkdownCodeBlockRenderer } from '../../editor/browser/widget/markdownRenderer/browser/editorMarkdownCodeBlockRenderer.js';
import { SyncDescriptor } from '../../platform/instantiation/common/descriptors.js';
import { ReviewTitleService } from './parts/reviewTitlebarPart.js';
import { IContextKeyService, RawContextKey } from '../../platform/contextkey/common/contextkey.js';
import { IsReviewWindowContext } from '../../workbench/common/contextkeys.js';
import {
	NotificationsPosition,
	NotificationsSettings,
	getNotificationsPosition
} from '../../workbench/common/notifications.js';
import { IReviewCanvasPartsService } from './parts/canvas/reviewCanvasPart.js';
import { IReviewExplorerPartsService } from './parts/explorer/reviewExplorerPart.js';
import { initialReviewPartVisibility } from '../common/reviewWorkbenchVisibility.js';
import { REVIEW_CHROME_HEIGHT } from '../common/reviewChrome.js';

const EDITOR_PART_MINIMUM_WIDTH = 300;
const EDITOR_PART_DEFAULT_WIDTH = 600;
const EXPLORER_PART_DEFAULT_WIDTH = 260;
const EditorMaximizedContext = new RawContextKey<boolean>('editorMaximized', false);

//#region ReviewWorkbench Options

export interface IWorkbenchOptions {
	/**
	 * Extra classes to be added to the workbench container.
	 */
	extraClasses?: string[];
}

//#endregion

//#region Layout Classes

enum LayoutClasses {
	SIDEBAR_HIDDEN = 'nosidebar',
	MAIN_EDITOR_AREA_HIDDEN = 'nomaineditorarea',
	PANEL_HIDDEN = 'nopanel',
	AUXILIARYBAR_HIDDEN = 'noauxiliarybar',
	SESSIONS_HIDDEN = 'nosessionspart',
	/** Positive polarity: the explorer is hidden on most tabs, so the class marks the exception. */
	EXPLORER_VISIBLE = 'review-explorer-visible',
	STATUSBAR_HIDDEN = 'nostatusbar',
	SHELL_GRADIENT_BACKGROUND = 'shell-gradient-background',
	FULLSCREEN = 'fullscreen',
	MAXIMIZED = 'maximized'
}

//#endregion

//#region Part Visibility State

/** Visibility of each workbench part in the Agents window layout. */
export interface IPartVisibilityState {
	sidebar: boolean;
	auxiliaryBar: boolean;
	editor: boolean;
	panel: boolean;
	sessions: boolean;
	explorer: boolean;
}

interface IPartSizesState {
	sidebar?: number;
	auxiliaryBar?: number;
	sessions?: number;
	editor?: number;
	panel?: number;
	explorer?: number;
}

/** Opaque per-transition capture returned by `ReviewWorkbench._prepareSideBarResize`. */
export interface ISideBarResizeContext { }

//#endregion

export interface IAgentWorkbenchLayoutService extends IWorkbenchLayoutService, IDockedEditorLayout {
	isEditorMaximized(): boolean;
	setEditorMaximized(maximized: boolean): void;

	readonly onDidChangeEditorMaximized: Event<void>;

	/**
	 * Whether the Agents window is using the single-pane (docked detail panel)
	 * layout. Fixed at construction — `false` for the classic/mobile workbench,
	 * `true` for {@link SinglePaneWorkbench}.
	 */
	readonly isSinglePaneLayoutEnabled: boolean;

	/**
	 * Whether this workbench draws its parts as inset cards -- the margins, border
	 * and corner radii under `.agent-sessions-workbench` in sessions/browser/media/
	 * style.css. Parts reserve layout space for that chrome only when it is drawn;
	 * the Review workbench adds no such class, so it is `false` here.
	 *
	 * Only the editor part honours this today. The panel, auxiliary bar and sessions
	 * parts still subtract their card insets unconditionally, which is dormant rather
	 * than correct: Review never instantiates them. Gate them here before Review grows
	 * a panel or a docked detail pane.
	 */
	readonly drawsPartCards: boolean;

	/**
	 * Suppresses the automatic editor part show/hide that normally fires from
	 * `editorService.onWillOpenEditor` / `onDidCloseEditor`. Use this around
	 * programmatic editor operations (e.g. applying a working set) so that the
	 * editor part visibility is not changed as a side-effect. Dispose the
	 * returned handle to release the suppression. Calls nest via a counter.
	 */
	suppressEditorPartAutoVisibility(): IDisposable;
}

/**
 * Docked-editor (single-pane detail panel) concerns of the layout service, kept
 * separate from the general contract so features that do not care about the
 * docked layout are not coupled to it.
 */
export interface IDockedEditorLayout {
	handleDockedEditorPartLayout(nodeWidth: number): void;

	/**
	 * Whether the editor's current visible state was produced by an explicit user
	 * reveal (opening an editor, or toggling the detail panel off) rather than an
	 * automatic layout/working-set reveal. The single-pane new-session rule (R1)
	 * uses this to avoid re-hiding an editor the user explicitly asked to show.
	 */
	isEditorRevealedExplicitly(): boolean;

	/**
	 * Reveals the (possibly hidden) editor part as an *explicit* user reveal, so
	 * the automatic single-pane hide rules (R1 / working-set apply) do not undo it.
	 * Use for deliberate opens like the session-header Changes pill or opening a
	 * file diff — not for automatic/layout-driven reveals.
	 */
	revealEditorPartExplicitly(): void;

	/**
	 * The docked auxiliary bar (detail panel) width, owned by the workbench's
	 * single-pane layout state and read/written by the docked controller that the
	 * editor part owns. Trivial in the classic layout.
	 */
	getDockedAuxiliaryBarWidth(): number;
	setDockedAuxiliaryBarWidth(width: number): void;
}

export const IAgentWorkbenchLayoutService = refineServiceDecorator<IWorkbenchLayoutService, IAgentWorkbenchLayoutService>(IWorkbenchLayoutService);

export class ReviewWorkbench extends Disposable implements IAgentWorkbenchLayoutService {

	declare readonly _serviceBrand: undefined;

	//#region Lifecycle Events

	private readonly _onWillShutdown = this._register(new Emitter<WillShutdownEvent>());
	readonly onWillShutdown = this._onWillShutdown.event;

	private readonly _onDidShutdown = this._register(new Emitter<void>());
	readonly onDidShutdown = this._onDidShutdown.event;

	//#endregion

	//#region Events

	private readonly _onDidChangeZenMode = this._register(new Emitter<boolean>());
	readonly onDidChangeZenMode = this._onDidChangeZenMode.event;

	private readonly _onDidChangeMainEditorCenteredLayout = this._register(new Emitter<boolean>());
	readonly onDidChangeMainEditorCenteredLayout = this._onDidChangeMainEditorCenteredLayout.event;

	private readonly _onDidChangePanelAlignment = this._register(new Emitter<PanelAlignment>());
	readonly onDidChangePanelAlignment = this._onDidChangePanelAlignment.event;

	private readonly _onDidChangeWindowMaximized = this._register(new Emitter<{ windowId: number; maximized: boolean }>());
	readonly onDidChangeWindowMaximized = this._onDidChangeWindowMaximized.event;

	private readonly _onDidChangePanelPosition = this._register(new Emitter<string>());
	readonly onDidChangePanelPosition = this._onDidChangePanelPosition.event;

	private readonly _onDidChangePartVisibility = this._register(new Emitter<IPartVisibilityChangeEvent>());
	readonly onDidChangePartVisibility = this._onDidChangePartVisibility.event;

	private readonly _onDidChangeNotificationsVisibility = this._register(new Emitter<boolean>());
	readonly onDidChangeNotificationsVisibility = this._onDidChangeNotificationsVisibility.event;

	private readonly _onDidChangeAuxiliaryBarMaximized = this._register(new Emitter<void>());
	readonly onDidChangeAuxiliaryBarMaximized = this._onDidChangeAuxiliaryBarMaximized.event;

	private readonly _onDidChangeEditorMaximized = this._register(new Emitter<void>());
	readonly onDidChangeEditorMaximized = this._onDidChangeEditorMaximized.event;

	private readonly _onDidLayoutMainContainer = this._register(new Emitter<IDimension>());
	readonly onDidLayoutMainContainer = this._onDidLayoutMainContainer.event;

	private readonly _onDidLayoutActiveContainer = this._register(new Emitter<IDimension>());
	readonly onDidLayoutActiveContainer = this._onDidLayoutActiveContainer.event;

	private readonly _onDidLayoutContainer = this._register(new Emitter<{ container: HTMLElement; dimension: IDimension }>());
	readonly onDidLayoutContainer = this._onDidLayoutContainer.event;

	private readonly _onDidAddContainer = this._register(new Emitter<{ container: HTMLElement; disposables: DisposableStore }>());
	readonly onDidAddContainer = this._onDidAddContainer.event;

	private readonly _onDidChangeActiveContainer = this._register(new Emitter<void>());
	readonly onDidChangeActiveContainer = this._onDidChangeActiveContainer.event;

	//#endregion

	//#region Properties

	readonly mainContainer = document.createElement('div');

	get activeContainer(): HTMLElement {
		return this.getContainerFromDocument(getActiveDocument());
	}

	get containers(): Iterable<HTMLElement> {
		const containers: HTMLElement[] = [];
		for (const { window } of getWindows()) {
			containers.push(this.getContainerFromDocument(window.document));
		}
		return containers;
	}

	private getContainerFromDocument(targetDocument: Document): HTMLElement {
		if (targetDocument === this.mainContainer.ownerDocument) {
			return this.mainContainer;
		} else {
			// eslint-disable-next-line no-restricted-syntax
			return targetDocument.body.getElementsByClassName('monaco-workbench')[0] as HTMLElement;
		}
	}

	private _mainContainerDimension!: IDimension;
	get mainContainerDimension(): IDimension { return this._mainContainerDimension; }

	get activeContainerDimension(): IDimension {
		return this.getContainerDimension(this.activeContainer);
	}

	private getContainerDimension(container: HTMLElement): IDimension {
		if (container === this.mainContainer) {
			return this.mainContainerDimension;
		} else {
			return getClientArea(container);
		}
	}

	get mainContainerOffset(): ILayoutOffsetInfo {
		return this.computeContainerOffset();
	}

	get activeContainerOffset(): ILayoutOffsetInfo {
		return this.computeContainerOffset();
	}

	private computeContainerOffset(): ILayoutOffsetInfo {
		let top = 0;
		let quickPickTop = 0;

		if (this.isVisible(Parts.TITLEBAR_PART, mainWindow)) {
			top = REVIEW_CHROME_HEIGHT;
			quickPickTop = top;
		}

		return { top, quickPickTop };
	}

	//#endregion

	//#region State

	private readonly parts = new Map<string, Part>();
	protected workbenchGrid!: SerializableGrid<ISerializableView>;

	protected sideBarPartView!: ISerializableView;
	private panelPartView!: ISerializableView;
	protected auxiliaryBarPartView!: ISerializableView;
	protected editorPartView!: ISerializableView;

	protected sessionsPartView!: ISerializableView;
	protected explorerPartView!: ISerializableView;

	/** The editor part container; the auxiliary bar is docked inside it. */
	protected _editorPartContainer: HTMLElement | undefined;
	/** `false` for the classic/mobile layout; {@link SinglePaneWorkbench} overrides to `true`. */
	get isSinglePaneLayoutEnabled(): boolean {
		return false;
	}
	/** Review never adds `agent-sessions-workbench`, so its parts run flush. */
	get drawsPartCards(): boolean {
		return false;
	}
	/** `true` while the editor's current visible state was produced by an explicit user reveal (opening an editor, or toggling the detail panel off) rather than an automatic layout/working-set reveal. Read by the single-pane new-session rule (R1) so it does not undo an explicit reveal. */
	protected _editorRevealedExplicitly = false;

	protected readonly partVisibility: IPartVisibilityState = {
		sidebar: true,
		auxiliaryBar: true,
		editor: false,
		panel: false,
		sessions: true,
		explorer: false
	};

	private mainWindowFullscreen = false;
	private readonly maximized = new Set<number>();
	private _editorMaximized = false;
	private _editorLastNonMaximizedVisibility: IPartVisibilityState | undefined;
	private _editorLastNonMaximizedSize: IViewSize | undefined;
	private _restoreAttachedEditorMaximizedOnShow = false;
	protected _editorPartAutoVisibilitySuppressionCount = 0;
	protected _hasAppliedInitialEditorSplit = false;
	private reviewChromeInsetElement: HTMLElement | undefined;
	private readonly reviewChromeDragListeners = this._register(new DisposableStore());
	private readonly reviewChromeInsetScheduler = this._register(new RunOnceScheduler(() => this.updateReviewChromeInset(), 0));

	private readonly restoredPromise = new DeferredPromise<void>();
	readonly whenRestored = this.restoredPromise.p;
	private restored = false;

	readonly openedDefaultEditors = false;

	protected _savedPartSizes: IPartSizesState = {};

	//#endregion

	private static readonly _PART_VISIBILITY_KEY = 'workbench.sessions.partVisibility';
	private static readonly _PART_SIZES_KEY = 'workbench.sessions.partSizes';

	//#region Services

	protected editorGroupService!: IEditorGroupsService;
	private editorService!: IEditorService;
	private paneCompositeService!: IPaneCompositePartService;
	private viewDescriptorService!: IViewDescriptorService;
	private storageService!: IStorageService;

	//#endregion

	constructor(
		protected readonly parent: HTMLElement,
		private readonly options: IWorkbenchOptions | undefined,
		private readonly serviceCollection: ServiceCollection,
		private readonly logService: ILogService
	) {
		super();

		// Sessions-scoped mobile viewport tweaks. These are applied here
		// (rather than in the shared workbench.html) so that the regular
		// code-web workbench — which does not handle safe-area insets — is
		// not affected on notched mobile devices.
		// The viewport `<meta>` tag is injected by the shared workbench.html,
		// so we cannot use dom.ts `h()` to create it. Look it up by tag name
		// and filter by the `name` attribute to avoid a selector query.
		// eslint-disable-next-line no-restricted-syntax
		const metaElements = mainWindow.document.head.getElementsByTagName('meta');
		let viewportMeta: HTMLMetaElement | undefined;
		for (let i = 0; i < metaElements.length; i++) {
			if (metaElements[i].name === 'viewport') {
				viewportMeta = metaElements[i];
				break;
			}
		}
		if (viewportMeta && !viewportMeta.content.includes('viewport-fit=')) {
			viewportMeta.content = `${viewportMeta.content}, viewport-fit=cover`;
		}

		// Perf: measure workbench startup time
		mark('code/willStartWorkbench');

		this.registerErrorHandler(logService);
	}

	//#region Error Handling

	private registerErrorHandler(logService: ILogService): void {
		// Increase stack trace limit for better errors stacks
		if (!isFirefox) {
			Error.stackTraceLimit = 100;
		}

		// Listen on unhandled rejection events
		// Note: intentionally not registered as disposable to handle
		//       errors that can occur during shutdown phase.
		mainWindow.addEventListener('unhandledrejection', (event) => {
			// See https://developer.mozilla.org/en-US/docs/Web/API/PromiseRejectionEvent
			onUnexpectedError(event.reason);

			// Prevent the printing of this event to the console
			event.preventDefault();
		});

		// Listen on synchronous errors that never reach a promise. Without this
		// they only reach the console, so they are invisible to the log and to
		// telemetry alike.
		mainWindow.addEventListener('error', (event) => {
			onUnexpectedError(event.error ?? event.message);
		});

		// Install handler for unexpected errors
		setUnexpectedErrorHandler(error => this.handleUnexpectedError(error, logService));
	}

	private previousUnexpectedError: { message: string | undefined; time: number } = { message: undefined, time: 0 };
	private handleUnexpectedError(error: unknown, logService: ILogService): void {
		const message = toErrorMessage(error, true);
		if (!message) {
			return;
		}

		const now = Date.now();
		if (message === this.previousUnexpectedError.message && now - this.previousUnexpectedError.time <= 1000) {
			return; // Return if error message identical to previous and shorter than 1 second
		}

		this.previousUnexpectedError.time = now;
		this.previousUnexpectedError.message = message;

		// Log it
		logService.error(message);

		// Report it
		this.reportUnexpectedError(error);
	}

	private readonly errorReportLimiter = new ReviewErrorReportLimiter();
	private workbenchInstantiationService: IInstantiationService | undefined;
	private reviewTelemetryService: IReviewTelemetryService | undefined;

	/**
	 * Send the error to the loopback Review server, which strips the message and
	 * every stack frame outside the shipped bundle before anything leaves this
	 * machine. Errors raised before `startup()` have no service to report
	 * through and are dropped rather than buffered: buffering would hold raw
	 * messages before the telemetry setting can be read.
	 */
	private reportUnexpectedError(error: unknown): void {
		this.errorReportLimiter.report(error, report => {
			this.reviewTelemetryService ??= this.workbenchInstantiationService?.invokeFunction(accessor => accessor.get(IReviewTelemetryService));
			this.reviewTelemetryService?.capture('client_error', {
				error_source: 'renderer_unexpected',
				error_process: 'renderer',
			}, report);
		});
	}

	//#endregion

	//#region Startup

	startup(): IInstantiationService {
		try {
			// Configure emitter leak warning threshold
			this._register(setGlobalLeakWarningThreshold(175));

			// Services
			const instantiationService = this.initServices(this.serviceCollection);

			// The error handler is installed in the constructor, long before any
			// service exists. Keep the instantiation service here so it can
			// resolve the telemetry service on the first error.
			this.workbenchInstantiationService = instantiationService;

			instantiationService.invokeFunction(accessor => {
				const lifecycleService = accessor.get(ILifecycleService);
				const storageService = accessor.get(IStorageService);
				const configurationService = accessor.get(IConfigurationService);
				const hostService = accessor.get(IHostService);
				const hoverService = accessor.get(IHoverService);
				const dialogService = accessor.get(IDialogService);
				const notificationService = accessor.get(INotificationService) as NotificationService;
				const markdownRendererService = accessor.get(IMarkdownRendererService);

				// On web, the configuration service needs access to the
				// instantiation service for dynamic configuration resolution.
				if (isWeb && typeof (configurationService as IConfigurationService & { acquireInstantiationService?(i: IInstantiationService): void }).acquireInstantiationService === 'function') {
					(configurationService as IConfigurationService & { acquireInstantiationService(i: IInstantiationService): void }).acquireInstantiationService(instantiationService);
				}

				// Set code block renderer for markdown rendering
				markdownRendererService.setDefaultCodeBlockRenderer(instantiationService.createInstance(EditorMarkdownCodeBlockRenderer));

				// Default Hover Delegate must be registered before creating any workbench/layout components
				setHoverDelegateFactory((placement, enableInstantHover) => instantiationService.createInstance(WorkbenchHoverDelegate, placement, { instantHover: enableInstantHover }, {}));
				setBaseLayerHoverDelegate(hoverService);

				// Layout
				this.initLayout(accessor);

				// Registries - this creates and registers all parts
				Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).start(accessor);
				Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).start(accessor);

				// Context Keys
				this._register(instantiationService.createInstance(WorkbenchContextKeysHandler));

				// Editor Maximized Context Key
				const editorMaximizedContext = EditorMaximizedContext.bindTo(accessor.get(IContextKeyService));
				this._register(this.onDidChangeEditorMaximized(() => {
					editorMaximizedContext.set(this.isEditorMaximized());
				}));

				const contextKeyService = accessor.get(IContextKeyService);

				// Marks this window as Review so shared workbench contributions can
				// opt out of chrome Review does not offer (split editors, the editor
				// actions overflow menu).
				IsReviewWindowContext.bindTo(contextKeyService).set(true);

				// Register Listeners
				this.registerListeners(lifecycleService, storageService, configurationService, hostService, dialogService);

				// Render ReviewWorkbench
				this.renderWorkbench(instantiationService, notificationService, storageService, configurationService);

				// ReviewWorkbench Layout
				this.createWorkbenchLayout();

				// ReviewWorkbench Management
				this.createWorkbenchManagement(instantiationService);

				// Layout
				this.layout();

				// Restore
				this.restore(lifecycleService);
			});

			return instantiationService;
		} catch (error) {
			onUnexpectedError(error);

			throw error; // rethrow because this is a critical issue we cannot handle properly here
		}
	}

	private initServices(serviceCollection: ServiceCollection): IInstantiationService {
		// Layout Service
		serviceCollection.set(IAgentWorkbenchLayoutService, this);

		// All Contributed Services
		const contributedServices = getSingletonServiceDescriptors();
		for (const [id, descriptor] of contributedServices) {
			serviceCollection.set(id, descriptor);
		}

		// The Review titlebar is a workbench part, not a contributed native
		// service. Install it after the registry has been materialized so a
		// platform title-service registration cannot replace the custom part.
		serviceCollection.set(ITitleService, new SyncDescriptor(ReviewTitleService, []));

		const instantiationService = new InstantiationService(serviceCollection, true);

		// Wrap up
		instantiationService.invokeFunction(accessor => {
			const lifecycleService = accessor.get(ILifecycleService);
			lifecycleService.phase = LifecyclePhase.Ready;
		});

		return instantiationService;
	}

	private registerListeners(lifecycleService: ILifecycleService, storageService: IStorageService, configurationService: IConfigurationService, hostService: IHostService, dialogService: IDialogService): void {
		// Configuration changes
		this._register(configurationService.onDidChangeConfiguration(e => this.updateFontAliasing(e, configurationService)));

		// Font Info
		if (isNative) {
			this._register(storageService.onWillSaveState(e => {
				if (e.reason === WillSaveStateReason.SHUTDOWN) {
					this.storeFontInfo(storageService);
				}
			}));
		} else {
			this._register(lifecycleService.onWillShutdown(() => this.storeFontInfo(storageService)));
		}

		// Part Sizes — persist current grid sizes so they are restored on reload
		this._register(storageService.onWillSaveState(() => this._savePartSizes()));

		// Lifecycle
		this._register(lifecycleService.onWillShutdown(event => this._onWillShutdown.fire(event)));
		this._register(lifecycleService.onDidShutdown(() => {
			this._onDidShutdown.fire();
			this.dispose();
		}));

		// Flush storage on window focus loss
		this._register(hostService.onDidChangeFocus(focus => {
			if (!focus) {
				storageService.flush();
			}
		}));

		// Dialogs showing/hiding
		this._register(dialogService.onWillShowDialog(() => this.mainContainer.classList.add('modal-dialog-visible')));
		this._register(dialogService.onDidShowDialog(() => this.mainContainer.classList.remove('modal-dialog-visible')));
	}

	//#region Font Aliasing and Caching

	private fontAliasing: 'default' | 'antialiased' | 'none' | 'auto' | undefined;
	private updateFontAliasing(e: IConfigurationChangeEvent | undefined, configurationService: IConfigurationService) {
		if (!isMacintosh) {
			return; // macOS only
		}

		if (e && !e.affectsConfiguration('workbench.fontAliasing')) {
			return;
		}

		const aliasing = configurationService.getValue<'default' | 'antialiased' | 'none' | 'auto'>('workbench.fontAliasing');
		if (this.fontAliasing === aliasing) {
			return;
		}

		this.fontAliasing = aliasing;

		// Remove all
		const fontAliasingValues: (typeof aliasing)[] = ['antialiased', 'none', 'auto'];
		this.mainContainer.classList.remove(...fontAliasingValues.map(value => `monaco-font-aliasing-${value}`));

		// Add specific
		if (fontAliasingValues.some(option => option === aliasing)) {
			this.mainContainer.classList.add(`monaco-font-aliasing-${aliasing}`);
		}
	}

	private restoreFontInfo(storageService: IStorageService, configurationService: IConfigurationService): void {
		const storedFontInfoRaw = storageService.get('editorFontInfo', StorageScope.APPLICATION);
		if (storedFontInfoRaw) {
			try {
				const storedFontInfo = JSON.parse(storedFontInfoRaw);
				if (Array.isArray(storedFontInfo)) {
					FontMeasurements.restoreFontInfo(mainWindow, storedFontInfo);
				}
			} catch (err) {
				/* ignore */
			}
		}

		FontMeasurements.readFontInfo(mainWindow, createBareFontInfoFromRawSettings(configurationService.getValue('editor'), PixelRatio.getInstance(mainWindow).value));
	}

	private storeFontInfo(storageService: IStorageService): void {
		const serializedFontInfo = FontMeasurements.serializeFontInfo(mainWindow);
		if (serializedFontInfo) {
			storageService.store('editorFontInfo', JSON.stringify(serializedFontInfo), StorageScope.APPLICATION, StorageTarget.MACHINE);
		}
	}

	/**
	 * Applies Review's runtime-derived initial visibility and removes the
	 * obsolete persisted visibility record. Part sizes remain independently
	 * persisted so an explicitly opened editor can reuse its last valid width.
	 */
	private _applyInitialPartVisibility(): void {
		this.storageService.remove(ReviewWorkbench._PART_VISIBILITY_KEY, StorageScope.WORKSPACE);
		Object.assign(this.partVisibility, initialReviewPartVisibility(this.partVisibility));
	}

	private _loadPartSizes(storageService: IStorageService): IPartSizesState {
		const raw = storageService.get(ReviewWorkbench._PART_SIZES_KEY, StorageScope.WORKSPACE);
		if (raw) {
			try {
				return JSON.parse(raw);
			} catch {
				// Corrupted data — remove the bad key so we don't keep warning on every startup
				storageService.remove(ReviewWorkbench._PART_SIZES_KEY, StorageScope.WORKSPACE);
			}
		}
		return {};
	}

	private _savePartSizes(): void {
		if (!this.workbenchGrid) {
			return;
		}

		// The editor-part grid node hosts the docked auxiliary bar in single-pane, so
		// it is "visible" whenever the editor OR the detail is shown. Use the node's
		// real visibility (not just `partVisibility.editor`) so a Detail-only session
		// records its *current* collapsed node width — reading the stale cached visible
		// size (wide) here would restore a wide node on reload and flicker the editor
		// open via the width-based reveal-sync. Classic layout is unaffected
		// (`_editorNodeVisible` returns `partVisibility.editor` there).
		const editorNodeVisible = this._editorNodeVisible(this.partVisibility.editor, this.partVisibility.auxiliaryBar);
		const editorGridWidth = this._persistedGridViewSize(this.editorPartView, 'width', editorNodeVisible);
		let editorWidth = this._persistedEditorWidth(editorGridWidth);

		// A sub-minimum measurement is never a real user width: the editor may be
		// hidden (single-pane returns the detail-only node minus the detail width,
		// i.e. ~0), or the high-priority sessions part may have transiently squeezed
		// the node below its minimum. Persisting it would rebuild the editor at its
		// 300px minimum on reload and lose the last user-selected width. Preserve the
		// last valid global width instead (or omit it so the default is used). The
		// descriptor keeps the editor contribution at zero while the editor part is
		// hidden, so keeping a valid width here is safe.
		if (editorWidth === undefined || editorWidth < EDITOR_PART_MINIMUM_WIDTH) {
			editorWidth = (this._savedPartSizes.editor !== undefined && this._savedPartSizes.editor >= EDITOR_PART_MINIMUM_WIDTH)
				? this._savedPartSizes.editor
				: undefined;
		} else {
			// Track the latest good width so a later shutdown-time squeeze falls back to it.
			this._savedPartSizes = { ...this._savedPartSizes, editor: editorWidth };
		}

		const sizes: IPartSizesState = {
			sessions: this._persistedGridViewSize(this.sessionsPartView, 'width', this.partVisibility.sessions),
			editor: editorWidth,
			// The explorer is hidden on most tabs, so this is usually the grid's
			// cached visible size — the width the user last dragged the sash to.
			explorer: this._persistedGridViewSize(this.explorerPartView, 'width', this.partVisibility.explorer),
		};

		this.storageService.store(ReviewWorkbench._PART_SIZES_KEY, JSON.stringify(sizes), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	//#endregion

	private renderWorkbench(instantiationService: IInstantiationService, notificationService: NotificationService, storageService: IStorageService, configurationService: IConfigurationService): void {
		// ARIA & Signals
		setARIAContainer(this.mainContainer);
		setProgressAccessibilitySignalScheduler((msDelayTime: number, msLoopTime?: number) => instantiationService.createInstance(AccessibilityProgressSignalScheduler, msDelayTime, msLoopTime));

		// Apply Review's fixed desktop visibility before the grid is built.
		this._applyInitialPartVisibility();

		// Load saved grid part sizes — these will be consumed when building the
		// grid descriptor so editor/sidebar/auxbar/panel restore to their previous
		// dimensions across reloads.
		this._savedPartSizes = this._loadPartSizes(storageService);
		if (this._savedPartSizes.auxiliaryBar !== undefined) {
			this._restoreAuxiliaryBarWidth(this._savedPartSizes.auxiliaryBar);
		}

		// State specific classes
		const platformClass = isWindows ? 'windows' : isLinux ? 'linux' : 'mac';
		const workbenchClasses = coalesce([
			'monaco-workbench',
			'review-workbench',
			// LayoutClasses.SHELL_GRADIENT_BACKGROUND,
			platformClass,
			isWeb ? 'web' : undefined,
			isChrome ? 'chromium' : isFirefox ? 'firefox' : isSafari ? 'safari' : undefined,
			...this.getLayoutClasses(),
			...(this.options?.extraClasses ? this.options.extraClasses : [])
		]);

		this.mainContainer.classList.add(...workbenchClasses);

		// Apply font aliasing
		this.updateFontAliasing(undefined, configurationService);

		// Warm up font cache information before building up too many dom elements
		this.restoreFontInfo(storageService, configurationService);

		// Review owns exactly one chrome part. Sidebar, panel, auxiliary bar,
		// activity bar, status bar, and banner parts are never instantiated.
		for (const { id, role, classes } of [
			{ id: Parts.TITLEBAR_PART, role: 'none', classes: ['titlebar'] },
		]) {
			const partContainer = this.createPartContainer(id, role, classes);

			mark(`code/willCreatePart/${id}`);
			this.getPart(id).create(partContainer);
			mark(`code/didCreatePart/${id}`);

			partContainer.classList.add('review-chrome-overlay');
			this.mainContainer.appendChild(partContainer);
		}

		// Create Editor Part (hidden by default)
		this.createEditorPart();

		// Create Sessions Part
		this.createSessionsPart();

		// Create Review Explorer Part (hidden until a file or diff tab is active)
		this.createExplorerPart();

		// Notification Handlers
		this.createNotificationsHandlers(instantiationService, notificationService, configurationService);

		// Add ReviewWorkbench to DOM
		this.parent.appendChild(this.mainContainer);
	}

	private createNotificationsHandlers(
		instantiationService: IInstantiationService,
		notificationService: NotificationService,
		configurationService: IConfigurationService
	): void {
		// Instantiate Notification components
		const notificationsCenter = this._register(instantiationService.createInstance(NotificationsCenter, this.mainContainer, notificationService.model));
		const notificationsToasts = this._register(instantiationService.createInstance(NotificationsToasts, this.mainContainer, notificationService.model));
		this._register(instantiationService.createInstance(NotificationsAlerts, notificationService.model));
		const notificationsStatus = this._register(instantiationService.createInstance(NotificationsStatus, notificationService.model));

		// Visibility
		this._register(notificationsCenter.onDidChangeVisibility(() => {
			notificationsStatus.update(notificationsCenter.isVisible, notificationsToasts.isVisible);
			notificationsToasts.update(notificationsCenter.isVisible);
		}));

		this._register(notificationsToasts.onDidChangeVisibility(() => {
			notificationsStatus.update(notificationsCenter.isVisible, notificationsToasts.isVisible);
		}));

		// Register Commands
		registerNotificationCommands(notificationsCenter, notificationsToasts, notificationService.model);

		// Register notification accessible view
		AccessibleViewRegistry.register(new NotificationAccessibleView());

		// The shared notification controllers apply a top-right inline offset based on the
		// default workbench custom titlebar height. The sessions workbench has its own
		// fixed chrome, so re-apply the sessions-specific top-right offset after they run.
		this.registerSessionsNotificationOffsets(configurationService, notificationsCenter, notificationsToasts);

		// Register with Layout
		this.registerNotifications({
			onDidChangeNotificationsVisibility: Event.map(
				Event.any(notificationsToasts.onDidChangeVisibility, notificationsCenter.onDidChangeVisibility),
				() => notificationsToasts.isVisible || notificationsCenter.isVisible
			)
		});
	}

	private registerSessionsNotificationOffsets(
		configurationService: IConfigurationService,
		notificationsCenter: NotificationsCenter,
		notificationsToasts: NotificationsToasts
	): void {
		const applySessionsNotificationOffsets = () => {
			const position = getNotificationsPosition(configurationService);
			const notificationsCenterContainer = this.getWorkbenchChildByClassName('notifications-center');
			const notificationsToastsContainer = this.getWorkbenchChildByClassName('notifications-toasts');

			if (position === NotificationsPosition.TOP_RIGHT) {
				notificationsCenterContainer?.style.setProperty('top', '40px');
				notificationsToastsContainer?.style.setProperty('top', '40px');
			}
		};

		this._register(this.onDidLayoutMainContainer(() => applySessionsNotificationOffsets()));
		this._register(notificationsCenter.onDidChangeVisibility(() => applySessionsNotificationOffsets()));
		this._register(notificationsToasts.onDidChangeVisibility(() => applySessionsNotificationOffsets()));
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(NotificationsSettings.NOTIFICATIONS_POSITION)) {
				applySessionsNotificationOffsets();
			}
		}));
	}

	private getWorkbenchChildByClassName(className: string): HTMLElement | undefined {
		for (const child of this.mainContainer.children) {
			if (isHTMLElement(child) && child.classList.contains(className)) {
				return child;
			}
		}

		return undefined;
	}

	private createPartContainer(id: string, role: string, classes: string[]): HTMLElement {
		const part = document.createElement('div');
		part.classList.add('part', ...classes);
		part.id = id;
		part.setAttribute('role', role);
		return part;
	}

	private createEditorPart(): void {
		const editorPartContainer = document.createElement('div');
		editorPartContainer.classList.add('part', 'editor');
		editorPartContainer.id = Parts.EDITOR_PART;
		editorPartContainer.setAttribute('role', 'main');
		this._editorPartContainer = editorPartContainer;

		mark('code/willCreatePart/workbench.parts.editor');
		this.getPart(Parts.EDITOR_PART).create(editorPartContainer, { restorePreviousState: false });
		mark('code/didCreatePart/workbench.parts.editor');

		this.mainContainer.appendChild(editorPartContainer);
	}

	private createSessionsPart(): void {
		const sessionsPartContainer = document.createElement('div');
		sessionsPartContainer.classList.add('part', 'sessionspart', 'basepanel', 'right');
		sessionsPartContainer.id = Parts.SESSIONS_PART;
		sessionsPartContainer.setAttribute('role', 'main');

		mark(`code/willCreatePart/${Parts.SESSIONS_PART}`);
		this.getPart(Parts.SESSIONS_PART).create(sessionsPartContainer);
		mark(`code/didCreatePart/${Parts.SESSIONS_PART}`);

		this.mainContainer.appendChild(sessionsPartContainer);
	}

	private createExplorerPart(): void {
		const explorerPartContainer = document.createElement('div');
		explorerPartContainer.classList.add('part', 'review-explorer');
		explorerPartContainer.id = Parts.REVIEW_EXPLORER_PART;
		explorerPartContainer.setAttribute('role', 'navigation');

		mark(`code/willCreatePart/${Parts.REVIEW_EXPLORER_PART}`);
		this.getPart(Parts.REVIEW_EXPLORER_PART).create(explorerPartContainer);
		mark(`code/didCreatePart/${Parts.REVIEW_EXPLORER_PART}`);

		this.mainContainer.appendChild(explorerPartContainer);
	}

	private restore(lifecycleService: ILifecycleService): void {
		// Update perf marks
		mark('code/didStartWorkbench');
		performance.measure('perf: workbench create & restore', 'code/didLoadWorkbenchMain', 'code/didStartWorkbench');

		// Restore parts (open default view containers)
		this.restoreParts();

		// Set lifecycle phase to `Restored`
		lifecycleService.phase = LifecyclePhase.Restored;

		// Mark as restored
		this.setRestored();

		// Set lifecycle phase to `Eventually` after a short delay and when idle (min 2.5sec, max 5sec)
		const eventuallyPhaseScheduler = this._register(new RunOnceScheduler(() => {
			this._register(runWhenWindowIdle(mainWindow, () => lifecycleService.phase = LifecyclePhase.Eventually, 2500));
		}, 2500));
		eventuallyPhaseScheduler.schedule();
	}

	private restoreParts(): void {
		// Review has no pane-composite parts to restore.
	}

	//#endregion

	//#region Initialization

	initLayout(accessor: ServicesAccessor): void {
		// Services - accessing these triggers their instantiation
		// which creates and registers the parts
		this.editorGroupService = accessor.get(IEditorGroupsService);
		this.editorService = accessor.get(IEditorService);
		// Forces eager creation of the sessions part so it registers itself with the
		// layout service before renderWorkbench() looks it up via getPart().
		accessor.get(IReviewCanvasPartsService);
		// Same for the file explorer part, which also owns its own show/hide policy.
		accessor.get(IReviewExplorerPartsService);
		// The sidebar, panel, and auxiliary bar stay hidden in Review, but the
		// part-visibility setters below still reach for this service; leaving it
		// unassigned would throw the moment any of them ran.
		this.paneCompositeService = accessor.get(IPaneCompositePartService);
		this.storageService = accessor.get(IStorageService);
		accessor.get(ITitleService);

		const editorMainPart = this.editorGroupService.mainPart;
		this._register(editorMainPart.onDidLayout(() => this.reviewChromeInsetScheduler.schedule()));
		this._register(editorMainPart.onDidAddGroup(() => this.reviewChromeInsetScheduler.schedule()));
		this._register(editorMainPart.onDidRemoveGroup(() => this.reviewChromeInsetScheduler.schedule()));
		this._register(editorMainPart.onDidMoveGroup(() => this.reviewChromeInsetScheduler.schedule()));

		// Register layout listeners
		this.registerLayoutListeners();

		// Editor opens should only affect the main editor part when
		// they actually target one of the main editor groups. Modal
		// opens stay neutral. Programmatic opens that suppress auto
		// visibility (e.g. working set application) are ignored.
		// The base handler reveals a hidden editor for any such open;
		// `SinglePaneWorkbench` overrides `revealEditorOnOpen` to keep a
		// docked-detail editor (Changes/Files) from revealing the editor area
		// while the detail panel is already showing its content.
		this._register(this.editorService.onWillOpenEditor(e => this.revealEditorOnOpen(e)));

		// Hide editor part when last editor closes
		this._register(this.editorService.onDidCloseEditor(() => this.handleDidCloseEditor()));

		// Initialize layout state (must be done before createWorkbenchLayout)
		this._mainContainerDimension = getClientArea(this.parent, new Dimension(800, 600));
		// Establish runtime-derived visibility before the context keys handler is
		// created. The editor becomes visible only in response to a real open.
		this._applyInitialPartVisibility();
	}

	private areAllGroupsInMainPartEmpty(): boolean {
		for (const group of this.editorGroupService.mainPart.groups) {
			if (!group.isEmpty) {
				return false;
			}
		}
		return true;
	}

	protected revealEditorOnOpen(e: IEditorWillOpenEvent): void {
		if (this._editorPartAutoVisibilitySuppressionCount > 0) {
			return;
		}

		const group = this.editorGroupService.mainPart.groups.find(g => g.id === e.groupId);
		if (!group) {
			return;
		}

		if (!this.partVisibility.editor) {
			this.setEditorHidden(false, /* explicit */ true);
			this.restoreAttachedEditorMaximizedState();
		}
	}

	private handleDidCloseEditor(): void {
		if (this._editorPartAutoVisibilitySuppressionCount > 0 || !this.areAllGroupsInMainPartEmpty()) {
			return;
		}

		this._handleAllEditorsClosed();
	}

	suppressEditorPartAutoVisibility(): IDisposable {
		this._editorPartAutoVisibilitySuppressionCount++;
		let disposed = false;
		return toDisposable(() => {
			if (disposed) {
				return;
			}
			disposed = true;
			this._editorPartAutoVisibilitySuppressionCount--;
		});
	}

	protected rememberAttachedEditorMaximizedState(): void {
		this._restoreAttachedEditorMaximizedOnShow = this._editorMaximized && this.partVisibility.auxiliaryBar;
	}

	private restoreAttachedEditorMaximizedState(): void {
		const shouldRestore = this._restoreAttachedEditorMaximizedOnShow && this.partVisibility.auxiliaryBar;
		this._restoreAttachedEditorMaximizedOnShow = false;

		if (shouldRestore) {
			this.setEditorMaximized(true);
		}
	}

	//#region Side-pane layout hooks (classic grid defaults; overridden by SinglePaneWorkbench)

	protected _fireDidChangePartVisibility(partId: Parts, visible: boolean): void {
		this._onDidChangePartVisibility.fire({ partId, visible });
	}

	protected _notifyContainerDidLayout(): void {
		this.handleContainerDidLayout(this.mainContainer, this._mainContainerDimension);
	}

	protected _setMainEditorAreaHidden(hidden: boolean): void {
		this.mainContainer.classList.toggle(LayoutClasses.MAIN_EDITOR_AREA_HIDDEN, hidden);
	}

	/**
	 * Handles a change in the editor-part grid view's visibility. In the classic
	 * layout the editor part is a standalone grid view, so its view visibility *is*
	 * the editor visibility — map it to `setEditorHidden` and raise the part event.
	 * Single-pane overrides this: its editor-part grid view also hosts the docked
	 * auxiliary bar, so the view can become visible purely to show the detail while
	 * the editor content stays hidden; it fires its own editor-part events instead.
	 */
	protected _onEditorPartGridVisibilityChange(visible: boolean): void {
		this.setEditorHidden(!visible);
		this._onDidChangePartVisibility.fire({ partId: Parts.EDITOR_PART, visible });
	}

	protected get _isEditorPartAutoVisibilitySuppressed(): boolean {
		return this._editorPartAutoVisibilitySuppressionCount > 0;
	}

	/** Toggles the container marker class for the side-pane layout. */
	protected _applyLayoutContainerClass(): void {
		this.mainContainer.classList.toggle('dock-detail-panel', false);
	}

	/** Width the auxiliary bar occupies when visible (for max-editor-dimension math). */
	protected _auxiliaryBarLayoutWidth(): number {
		return this.workbenchGrid ? this.workbenchGrid.getViewSize(this.auxiliaryBarPartView).width : 0;
	}

	protected _auxiliaryBarViewSize(): IViewSize {
		if (!this.workbenchGrid || !this.auxiliaryBarPartView) {
			return { width: 0, height: 0 };
		}
		return this.workbenchGrid.getViewSize(this.auxiliaryBarPartView);
	}

	protected _setAuxiliaryBarViewSize(size: IViewSize): void {
		if (this.auxiliaryBarPartView) {
			this.workbenchGrid.resizeView(this.auxiliaryBarPartView, size);
		}
	}

	protected _resizeAuxiliaryBarBy(deltaWidth: number, deltaHeight: number): void {
		if (!this.auxiliaryBarPartView) {
			return;
		}
		const currentSize = this.workbenchGrid.getViewSize(this.auxiliaryBarPartView);
		this.workbenchGrid.resizeView(this.auxiliaryBarPartView, {
			width: currentSize.width + deltaWidth,
			height: currentSize.height + deltaHeight
		});
	}

	protected _restoreAuxiliaryBarWidth(_width: number): void { }

	/**
	 * Reads a part's size from the workbench grid for persistence. For visible
	 * parts, the current view size; for hidden parts, the grid's cached visible
	 * size (the size it had the last time it was shown) so toggling visibility
	 * later restores the same dimensions. Overridden by the single-pane layout for
	 * its docked auxiliary bar, which is not a grid view.
	 */
	protected _persistedGridViewSize(view: ISerializableView, dimension: 'width' | 'height', visible: boolean): number | undefined {
		if (visible) {
			return this.workbenchGrid.getViewSize(view)[dimension];
		}
		return this.workbenchGrid.getViewCachedVisibleSize(view);
	}

	protected _persistedEditorWidth(editorGridWidth: number | undefined): number | undefined {
		return editorGridWidth;
	}

	protected _defaultSideBarSize(policySideBarSize: number): number {
		return policySideBarSize;
	}

	protected _editorNodeSize(effectiveEditorWidth: number, _effectiveAuxBarWidth: number): number {
		return effectiveEditorWidth;
	}

	protected _editorNodeVisible(editorVisible: boolean, _auxBarVisible: boolean): boolean {
		return editorVisible;
	}

	protected _topRightSectionChildren(sessionsNode: ISerializedNode, editorNode: ISerializedNode, auxiliaryBarNode: ISerializedNode): ISerializedNode[] {
		return [sessionsNode, editorNode, auxiliaryBarNode];
	}

	/** Attach any per-layout controllers once the editor part container exists. */
	protected _attachSidePane(): void { }
	/** Lay out any docked overlay. */
	protected _layoutSidePane(): void { }
	/** React to a whole-grid change (e.g. a sash drag) after the grid rebuilds. */
	protected _onGridDidChange(): void { }
	/** React to the editor grid node being resized to `nodeWidth`. */
	protected _onEditorNodeResized(_nodeWidth: number): void { }

	/** Run editor-node work with the reveal-sync suspended (no-op for the grid layout). */
	protected _runWithEditorResizeSyncSuspended(fn: () => void): void {
		fn();
	}

	protected _applyEditorVisibility(hidden: boolean): void {
		const shouldApplyEvenSplit = !hidden && !this._hasAppliedInitialEditorSplit;

		// Capture the main-area width (the sessions part occupies it fully while the
		// editor is hidden) before revealing, so the even split can halve it.
		const mainAreaWidth = this.workbenchGrid.getViewSize(this.sessionsPartView).width;

		this.workbenchGrid.setViewVisible(this.editorPartView, !hidden);

		if (shouldApplyEvenSplit) {
			this._hasAppliedInitialEditorSplit = true;
			this._applyEditorSplitSize(mainAreaWidth);
		}
	}

	protected _onWillHideAuxiliaryBar(_hidden: boolean): void { }

	protected _applyAuxiliaryBarVisibility(hidden: boolean): void {
		// Skipped before the grid exists: during startup the layout controller (a
		// BlockRestore contribution) runs before createWorkbenchLayout(), so the
		// visibility is recorded in partVisibility and applied when the grid is built.
		if (this.workbenchGrid) {
			this.workbenchGrid.setViewVisible(this.auxiliaryBarPartView, !hidden);
		}
	}

	protected _shouldOpenAuxiliaryPaneComposite(_containerId: string): boolean {
		return true;
	}

	protected _handleAllEditorsClosed(): void {
		if (this.partVisibility.editor) {
			this.rememberAttachedEditorMaximizedState();
			this.setEditorHidden(true);
		}
	}

	protected _prepareSideBarResize(_hidden: boolean): ISideBarResizeContext {
		return {};
	}

	protected _applySideBarResize(_hidden: boolean, _context: ISideBarResizeContext): void { }

	//#endregion

	private registerLayoutListeners(): void {
		// Fullscreen changes
		this._register(onDidChangeFullscreen(windowId => {
			if (windowId === getWindowId(mainWindow)) {
				this.mainWindowFullscreen = isFullscreen(mainWindow);
				this.updateFullscreenClass();
				this.layout();
			}
		}));

		// Window resize — needed for device emulation and mobile viewport changes
		const onWindowResize = () => this.layout();
		this._register(addDisposableListener(mainWindow, 'resize', onWindowResize));
	}

	private updateFullscreenClass(): void {
		if (this.mainWindowFullscreen) {
			this.mainContainer.classList.add(LayoutClasses.FULLSCREEN);
		} else {
			this.mainContainer.classList.remove(LayoutClasses.FULLSCREEN);
		}
	}

	private updateReviewChromeInset(): void {
		this.reviewChromeDragListeners.clear();
		this.mainContainer.classList.remove('review-tab-dragging');
		this.reviewChromeInsetElement?.classList.remove('review-chrome-inset');
		this.reviewChromeInsetElement = undefined;

		const editorPartContainer = this._editorPartContainer;
		if (!editorPartContainer) {
			return;
		}

		// Every tab row is a window drag region (see review.css); a tab drag
		// must lift that region on whichever row it starts in.
		const finishTabDrag = () => this.mainContainer.classList.remove('review-tab-dragging');
		const tabStripsInPart = editorPartContainer.getElementsByClassName('tabs-and-actions-container');
		for (let index = 0; index < tabStripsInPart.length; index++) {
			const tabStrip = tabStripsInPart[index];
			if (!isHTMLElement(tabStrip)) {
				continue;
			}
			this.reviewChromeDragListeners.add(addDisposableListener(tabStrip, 'dragstart', () => this.mainContainer.classList.add('review-tab-dragging')));
			this.reviewChromeDragListeners.add(addDisposableListener(tabStrip, 'dragend', finishTabDrag));
			this.reviewChromeDragListeners.add(addDisposableListener(tabStrip, 'drop', finishTabDrag));
		}

		let topLeftGroup: HTMLElement | undefined;
		let topLeftRect: DOMRect | undefined;
		const groups = editorPartContainer.getElementsByClassName('editor-group-container');
		for (let index = 0; index < groups.length; index++) {
			const group = groups[index];
			if (!isHTMLElement(group)) {
				continue;
			}

			const rect = group.getBoundingClientRect();
			if (rect.width === 0 || rect.height === 0) {
				continue;
			}

			if (!topLeftRect || rect.top < topLeftRect.top - 1 || (Math.abs(rect.top - topLeftRect.top) <= 1 && rect.left < topLeftRect.left)) {
				topLeftGroup = group;
				topLeftRect = rect;
			}
		}

		if (!topLeftGroup) {
			return;
		}

		const tabStrips = topLeftGroup.getElementsByClassName('tabs-and-actions-container');
		for (let index = 0; index < tabStrips.length; index++) {
			const tabStrip = tabStrips[index];
			if (isHTMLElement(tabStrip)) {
				this.reviewChromeInsetElement = tabStrip;
				tabStrip.classList.add('review-chrome-inset');
				break;
			}
		}
	}

	//#endregion

	//#region ReviewWorkbench Layout Creation

	createWorkbenchLayout(): void {
		this._applyLayoutContainerClass();

		const editorPart = this.getPart(Parts.EDITOR_PART);
		const sessionsPart = this.getPart(Parts.SESSIONS_PART);
		const explorerPart = this.getPart(Parts.REVIEW_EXPLORER_PART);

		this.sessionsPartView = sessionsPart;
		this.editorPartView = editorPart;
		this.explorerPartView = explorerPart;

		const viewMap: { [key: string]: ISerializableView } = {
			[Parts.SESSIONS_PART]: this.sessionsPartView,
			[Parts.EDITOR_PART]: this.editorPartView,
			[Parts.REVIEW_EXPLORER_PART]: this.explorerPartView
		};

		const fromJSON = ({ type }: { type: string }) => viewMap[type];
		const workbenchGrid = SerializableGrid.deserialize(
			this.createGridDescriptor(),
			{ fromJSON },
			{ proportionalLayout: false }
		);

		this.mainContainer.prepend(workbenchGrid.element);
		this.mainContainer.setAttribute('role', 'application');
		this.workbenchGrid = workbenchGrid;
		this.workbenchGrid.edgeSnapping = this.mainWindowFullscreen;
		this._register(this.workbenchGrid.onDidChange(() => {
			this._onGridDidChange();
		}));

		// If the editor is restored visible, it already has an established
		// width, so a later reveal must not force an even split over it.
		this._hasAppliedInitialEditorSplit = this.partVisibility.editor;

		for (const part of [sessionsPart, editorPart, explorerPart]) {
			this._register(part.onDidVisibilityChange(visible => {
				// A grid branch forwards its own show/hide to every child leaf,
				// including leaves whose slot stays hidden. That notification
				// describes the branch, not the part, so acting on it would reveal
				// a part the grid still holds hidden. The grid is authoritative for
				// every part it owns, and Review puts all of them in the grid.
				if (this.workbenchGrid.isViewVisible(part) === !visible) {
					return;
				}

				if (part === editorPart) {
					this._onEditorPartGridVisibilityChange(visible);
					this.handleContainerDidLayout(this.mainContainer, this._mainContainerDimension);
					return;
				}

				if (part === sessionsPart) {
					this.setSessionsHidden(!visible);
				}

				if (part === explorerPart) {
					this.setExplorerHidden(!visible);
				}

				this._onDidChangePartVisibility.fire({ partId: part.getId(), visible });
				this.handleContainerDidLayout(this.mainContainer, this._mainContainerDimension);
			}));
		}
	}

	createWorkbenchManagement(_instantiationService: IInstantiationService): void { }

	/**
	 * Creates the grid descriptor for the Agent Sessions layout.
	 *
	 * Structure (horizontal orientation):
	 * - Sidebar (left, spans full height from top to bottom)
	 * - Right section (vertical):
	 *   - Titlebar (top of right section)
	 *   - Top right (horizontal): Chat Bar | Editor | Auxiliary Bar
	 *   - Panel (below chat, editor, and auxiliary bar)
	 */
	private createGridDescriptor(): ISerializedGrid {
		const { width, height } = this._mainContainerDimension;

		return this.createDesktopGridDescriptor(width, height);
	}

	/**
	 * Standard multi-part layout. Sidebar, panel, and auxiliary bar are hidden
	 * in the grid via partVisibility defaults.
	 */
	private createDesktopGridDescriptor(width: number, height: number): ISerializedGrid {
		const savedEditorWidth = this._savedPartSizes.editor;
		const editorSize = savedEditorWidth !== undefined && savedEditorWidth >= EDITOR_PART_MINIMUM_WIDTH ? savedEditorWidth : EDITOR_PART_DEFAULT_WIDTH;
		const effectiveEditorWidth = this.partVisibility.editor ? editorSize : 0;
		const sessionsWidth = this._savedPartSizes.sessions
			?? Math.max(0, width - effectiveEditorWidth);
		const contentHeight = height;

		const sessionsNode: ISerializedLeafNode = {
			type: 'leaf',
			data: { type: Parts.SESSIONS_PART },
			size: sessionsWidth,
			visible: this.partVisibility.sessions
		};

		const editorNode: ISerializedLeafNode = {
			type: 'leaf',
			data: { type: Parts.EDITOR_PART },
			size: effectiveEditorWidth,
			visible: this.partVisibility.editor
		};

		// The explorer sits left of the editor. `partVisibility.explorer` is always
		// false here — it is derived from the active editor, and no editor is
		// restored yet — so the leaf carries only the width a later reveal uses.
		const explorerNode: ISerializedLeafNode = {
			type: 'leaf',
			data: { type: Parts.REVIEW_EXPLORER_PART },
			size: this._savedPartSizes.explorer ?? EXPLORER_PART_DEFAULT_WIDTH,
			visible: this.partVisibility.explorer
		};

		const contentSection: ISerializedNode = {
			type: 'branch',
			data: [sessionsNode, explorerNode, editorNode],
			size: contentHeight
		};

		const result: ISerializedGrid = {
			root: {
				type: 'branch',
				size: width,
				data: [contentSection]
			},
			orientation: Orientation.VERTICAL,
			width,
			height
		};

		return result;
	}

	//#endregion

	//#region Layout Methods

	layout(): void {
		this._mainContainerDimension = getClientArea(
			this.mainWindowFullscreen ? mainWindow.document.body : this.parent
		);

		this.logService.trace(`ReviewWorkbench#layout, height: ${this._mainContainerDimension.height}, width: ${this._mainContainerDimension.width}`);

		size(this.mainContainer, this._mainContainerDimension.width, this._mainContainerDimension.height);

		// A deliberate 10px breathing gap along the bottom edge, kept to match the window
		// shape of stock VS Code. Review draws no part cards, so this is bare workbench
		// ground rather than a margin around a card; review.css paints it with the editor
		// background so it reads as one surface.
		//
		// The right edge takes no gutter: stock VS Code runs its parts flush to the window
		// edge, and Review has no right-edge card to inset -- the card margins that would
		// have needed one live under `.agent-sessions-workbench`, a class `workbenchClasses`
		// never includes.
		const gutterBottom = 10;
		const gridWidth = this._mainContainerDimension.width;
		const gridHeight = this._mainContainerDimension.height - gutterBottom;

		// Layout the grid widget
		this.workbenchGrid.layout(gridWidth, gridHeight);
		this.getPart(Parts.TITLEBAR_PART).layout(gridWidth, REVIEW_CHROME_HEIGHT, 0, 0);
		this.updateReviewChromeInset();

		// Dock + layout the auxiliary bar inside the editor part so the
		// editor tab bar spans the full width above both.
		this._attachSidePane();
		this._layoutSidePane();

		// Emit as event
		this.handleContainerDidLayout(this.mainContainer, this._mainContainerDimension);
	}

	handleDockedEditorPartLayout(nodeWidth: number): void {
		this._onEditorNodeResized(nodeWidth);
	}

	isEditorRevealedExplicitly(): boolean {
		return this._editorRevealedExplicitly;
	}

	revealEditorPartExplicitly(): void {
		// Mark the reveal explicit so R1 / the working-set apply do not re-hide it.
		// Re-assert the flag even when already visible (the early-return in
		// setEditorHidden would otherwise skip it).
		this._editorRevealedExplicitly = true;
		this.setEditorHidden(false, /* explicit */ true);
	}

	getDockedAuxiliaryBarWidth(): number {
		return 0;
	}

	setDockedAuxiliaryBarWidth(_width: number): void { }

	private handleContainerDidLayout(container: HTMLElement, dimension: IDimension): void {
		this._onDidLayoutContainer.fire({ container, dimension });
		if (container === this.mainContainer) {
			this._onDidLayoutMainContainer.fire(dimension);
		}
		if (container === this.activeContainer) {
			this._onDidLayoutActiveContainer.fire(dimension);
		}
	}

	isFloatingPanelsEnabled(): boolean {
		return false; // the agents window has its own floating card design
	}

	getLayoutClasses(): string[] {
		return coalesce([
			!this.partVisibility.sidebar ? LayoutClasses.SIDEBAR_HIDDEN : undefined,
			!this.partVisibility.editor ? LayoutClasses.MAIN_EDITOR_AREA_HIDDEN : undefined,
			!this.partVisibility.panel ? LayoutClasses.PANEL_HIDDEN : undefined,
			!this.partVisibility.auxiliaryBar ? LayoutClasses.AUXILIARYBAR_HIDDEN : undefined,
			!this.partVisibility.sessions ? LayoutClasses.SESSIONS_HIDDEN : undefined,
			LayoutClasses.STATUSBAR_HIDDEN, // agents window never has a status bar
			this.mainWindowFullscreen ? LayoutClasses.FULLSCREEN : undefined,
		]);
	}

	//#endregion

	//#region Part Management

	registerPart(part: Part): IDisposable {
		const id = part.getId();
		this.parts.set(id, part);
		return toDisposable(() => this.parts.delete(id));
	}

	getPart(key: Parts): Part {
		const part = this.parts.get(key);
		if (!part) {
			throw new Error(`Unknown part ${key}`);
		}
		return part;
	}

	hasFocus(part: Parts): boolean {
		const container = this.getContainer(mainWindow, part);
		if (!container) {
			return false;
		}

		const activeElement = getActiveElement();
		if (!activeElement) {
			return false;
		}

		return isAncestorUsingFlowTo(activeElement, container);
	}

	focusPart(part: MULTI_WINDOW_PARTS, targetWindow: Window): void;
	focusPart(part: SINGLE_WINDOW_PARTS): void;
	focusPart(part: Parts, targetWindow: Window = mainWindow): void {
		switch (part) {
			case Parts.EDITOR_PART:
				this.editorGroupService.activeGroup.focus();
				break;
			case Parts.PANEL_PART:
				this.paneCompositeService.getActivePaneComposite(ViewContainerLocation.Panel)?.focus();
				break;
			case Parts.SIDEBAR_PART:
				this.paneCompositeService.getActivePaneComposite(ViewContainerLocation.Sidebar)?.focus();
				break;
			case Parts.AUXILIARYBAR_PART:
				this.paneCompositeService.getActivePaneComposite(ViewContainerLocation.AuxiliaryBar)?.focus();
				break;
			case Parts.SESSIONS_PART:
				// TODO: focus chat bar content once it is wired up
				this.getPart(Parts.SESSIONS_PART).getContainer()?.focus();
				break;
			default: {
				const container = this.getContainer(targetWindow, part);
				container?.focus();
			}
		}
	}

	focus(): void {
		this.focusPart(Parts.SESSIONS_PART);
	}

	//#endregion

	//#region Container Methods

	getContainer(targetWindow: Window): HTMLElement;
	getContainer(targetWindow: Window, part: Parts): HTMLElement | undefined;
	getContainer(targetWindow: Window, part?: Parts): HTMLElement | undefined {
		if (typeof part === 'undefined') {
			return this.getContainerFromDocument(targetWindow.document);
		}

		if (targetWindow === mainWindow) {
			return this.parts.get(part)?.getContainer();
		}

		// For auxiliary windows, only editor part is supported
		if (part === Parts.EDITOR_PART) {
			const container = this.getContainerFromDocument(targetWindow.document);
			const partCandidate = this.editorGroupService.getPart(container);
			if (partCandidate instanceof Part) {
				return partCandidate.getContainer();
			}
		}

		return undefined;
	}

	whenContainerStylesLoaded(_window: CodeWindow): Promise<void> | undefined {
		return undefined;
	}

	//#endregion

	//#region Part Visibility

	isActivityBarHidden(): boolean {
		return true; // No activity bar in this layout
	}

	isVisible(part: SINGLE_WINDOW_PARTS): boolean;
	isVisible(part: MULTI_WINDOW_PARTS, targetWindow: Window): boolean;
	isVisible(part: Parts, targetWindow?: Window): boolean {
		switch (part) {
			case Parts.TITLEBAR_PART:
				return true;
			case Parts.SIDEBAR_PART:
			case Parts.AUXILIARYBAR_PART:
			case Parts.PANEL_PART:
				return false;
			case Parts.EDITOR_PART:
				return this.partVisibility.editor;
			case Parts.SESSIONS_PART:
				return this.partVisibility.sessions;
			case Parts.REVIEW_EXPLORER_PART:
				return this.partVisibility.explorer;
			case Parts.ACTIVITYBAR_PART:
			case Parts.STATUSBAR_PART:
			case Parts.BANNER_PART:
			default:
				return false;
		}
	}

	setPartHidden(hidden: boolean, part: Parts): void {
		switch (part) {
			case Parts.SIDEBAR_PART:
				this.setSideBarHidden(hidden);
				break;
			case Parts.AUXILIARYBAR_PART:
				this.setAuxiliaryBarHidden(hidden);
				break;
			case Parts.EDITOR_PART:
				this.setEditorHidden(hidden);
				break;
			case Parts.PANEL_PART:
				this.setPanelHidden(hidden);
				break;
			case Parts.SESSIONS_PART:
				this.setSessionsHidden(hidden);
				break;
			case Parts.REVIEW_EXPLORER_PART:
				this.setExplorerHidden(hidden);
				break;
		}
	}

	private setSideBarHidden(hidden: boolean): void {
		if (this.partVisibility.sidebar === !hidden) {
			return;
		}

		const resizeContext = this._prepareSideBarResize(hidden);

		this.partVisibility.sidebar = !hidden;
		this.mainContainer.classList.toggle(LayoutClasses.SIDEBAR_HIDDEN, hidden);

		// Propagate to grid
		this.workbenchGrid.setViewVisible(
			this.sideBarPartView,
			!hidden,
		);

		this._applySideBarResize(hidden, resizeContext);

		// If sidebar becomes hidden, also hide the current active pane composite
		if (hidden && this.paneCompositeService.getActivePaneComposite(ViewContainerLocation.Sidebar)) {
			this.paneCompositeService.hideActivePaneComposite(ViewContainerLocation.Sidebar);
		}

		// If sidebar becomes visible, show last active Viewlet or default viewlet
		if (!hidden && !this.paneCompositeService.getActivePaneComposite(ViewContainerLocation.Sidebar)) {
			const viewletToOpen = this.paneCompositeService.getLastActivePaneCompositeId(ViewContainerLocation.Sidebar) ??
				this.viewDescriptorService.getDefaultViewContainer(ViewContainerLocation.Sidebar)?.id;
			if (viewletToOpen) {
				this.paneCompositeService.openPaneComposite(viewletToOpen, ViewContainerLocation.Sidebar);
			}
		}
	}

	setAuxiliaryBarHidden(hidden: boolean): void {
		if (this.partVisibility.auxiliaryBar === !hidden) {
			return;
		}

		if (hidden) {
			this._restoreAttachedEditorMaximizedOnShow = false;
		}

		this._onWillHideAuxiliaryBar(hidden);

		this.partVisibility.auxiliaryBar = !hidden;
		this.mainContainer.classList.toggle(LayoutClasses.AUXILIARYBAR_HIDDEN, hidden);

		this._applyAuxiliaryBarVisibility(hidden);

		// If auxiliary bar becomes hidden, also hide the current active pane composite
		if (hidden && this.paneCompositeService.getActivePaneComposite(ViewContainerLocation.AuxiliaryBar)) {
			this.paneCompositeService.hideActivePaneComposite(ViewContainerLocation.AuxiliaryBar);
		}

		// If auxiliary bar becomes visible, show last active pane composite or default
		if (!hidden && !this.paneCompositeService.getActivePaneComposite(ViewContainerLocation.AuxiliaryBar)) {
			const paneCompositeToOpen = this.paneCompositeService.getLastActivePaneCompositeId(ViewContainerLocation.AuxiliaryBar) ??
				this.viewDescriptorService.getDefaultViewContainer(ViewContainerLocation.AuxiliaryBar)?.id;
			if (paneCompositeToOpen && this._shouldOpenAuxiliaryPaneComposite(paneCompositeToOpen)) {
				this.paneCompositeService.openPaneComposite(paneCompositeToOpen, ViewContainerLocation.AuxiliaryBar);
			}
		}

	}

	/**
	 * Whether the given auxiliary-bar view container currently has content to show
	 * (mirrors `IViewsService.isViewContainerActive`: a `hideIfEmpty` container is
	 * only active once it has at least one active view descriptor). Used to avoid
	 * presenting an empty docked detail panel.
	 */
	protected _isAuxViewContainerActive(containerId: string): boolean {
		const viewContainer = this.viewDescriptorService.getViewContainerById(containerId);
		if (!viewContainer) {
			return false;
		}
		if (!viewContainer.hideIfEmpty) {
			return true;
		}
		return this.viewDescriptorService.getViewContainerModel(viewContainer).activeViewDescriptors.length > 0;
	}

	setEditorHidden(hidden: boolean, explicit: boolean = false): void {
		if (this.partVisibility.editor === !hidden) {
			return;
		}

		// Track whether this visible state was an explicit user reveal so R1 does
		// not undo it. Any hide clears it; an automatic reveal leaves it false.
		this._editorRevealedExplicitly = !hidden && explicit;

		this._runWithEditorResizeSyncSuspended(() => {
			// If hiding the editor while maximized
			if (hidden && this._editorMaximized) {
				this.setEditorMaximized(false);
			}

			this.partVisibility.editor = !hidden;
			this.mainContainer.classList.toggle(LayoutClasses.MAIN_EDITOR_AREA_HIDDEN, hidden);

			if (this.editorPartView) {
				this._applyEditorVisibility(hidden);
			}

		});
	}

	/**
	 * Sizes the editor part when it is first revealed from a hidden state, so it
	 * opens as a comfortable split with the sessions part rather than at its
	 * minimum/restored width. The default grid layout splits the main area evenly;
	 * layouts with different sizing (e.g. the single-pane side pane) override this.
	 */
	protected _applyEditorSplitSize(mainAreaWidth: number): void {
		const targetEditorWidth = Math.max(EDITOR_PART_MINIMUM_WIDTH, Math.floor(mainAreaWidth / 2));
		const currentEditorSize = this.workbenchGrid.getViewSize(this.editorPartView);
		this.workbenchGrid.resizeView(this.editorPartView, {
			width: targetEditorWidth,
			height: currentEditorSize.height
		});
	}

	private setPanelHidden(hidden: boolean): void {
		if (this.partVisibility.panel === !hidden) {
			return;
		}

		// If hiding and the panel is maximized, exit maximized state first
		if (hidden && this.workbenchGrid.hasMaximizedView()) {
			this.workbenchGrid.exitMaximizedView();
		}

		const panelHadFocus = !hidden || this.hasFocus(Parts.PANEL_PART);

		this.partVisibility.panel = !hidden;
		this.mainContainer.classList.toggle(LayoutClasses.PANEL_HIDDEN, hidden);

		// Propagate to grid
		this.workbenchGrid.setViewVisible(
			this.panelPartView,
			!hidden,
		);

		// If panel becomes hidden, also hide the current active pane composite
		if (hidden && this.paneCompositeService.getActivePaneComposite(ViewContainerLocation.Panel)) {
			this.paneCompositeService.hideActivePaneComposite(ViewContainerLocation.Panel);

			// Focus the chat bar when hiding the panel if it had focus
			if (panelHadFocus) {
				this.focusPart(Parts.SESSIONS_PART);
			}
		}

		// If panel becomes visible, show last active panel or default and focus it
		if (!hidden) {
			if (!this.paneCompositeService.getActivePaneComposite(ViewContainerLocation.Panel)) {
				const panelToOpen = this.paneCompositeService.getLastActivePaneCompositeId(ViewContainerLocation.Panel) ??
					this.viewDescriptorService.getDefaultViewContainer(ViewContainerLocation.Panel)?.id;
				if (panelToOpen) {
					this.paneCompositeService.openPaneComposite(panelToOpen, ViewContainerLocation.Panel);
				}
			}

			this.focusPart(Parts.PANEL_PART);
		}
	}

	private setSessionsHidden(hidden: boolean): void {
		// Review hosts Home, canvases, files, and diffs in the editor group. The
		// sessions part stays registered as a hidden layout placeholder with no
		// content, so showing it only adds dead space no Review command can
		// collapse. See `initialReviewPartVisibility`.
		if (!hidden) {
			return;
		}

		if (this.partVisibility.sessions === !hidden) {
			return;
		}

		this.partVisibility.sessions = !hidden;
		this.mainContainer.classList.toggle(LayoutClasses.SESSIONS_HIDDEN, hidden);

		// Propagate to grid
		this.workbenchGrid.setViewVisible(this.sessionsPartView, !hidden);
	}

	/**
	 * Shows or hides the file explorer leaf.
	 *
	 * `ReviewExplorerParts` is the only caller: it derives the state from the
	 * active editor pane. A maximized editor owns the whole window, so a tab
	 * switch under it must not bring the explorer back.
	 */
	private setExplorerHidden(hidden: boolean): void {
		if (!hidden && this._editorMaximized) {
			return;
		}

		if (this.partVisibility.explorer === !hidden) {
			return;
		}

		this.partVisibility.explorer = !hidden;
		this.mainContainer.classList.toggle(LayoutClasses.EXPLORER_VISIBLE, !hidden);

		// The eager explorer service runs in initLayout(), before the grid exists.
		// The descriptor reads partVisibility, so the state above still lands.
		if (this.workbenchGrid) {
			this.workbenchGrid.setViewVisible(this.explorerPartView, !hidden);
		}
	}

	//#endregion

	//#region Position Methods (Fixed - Not Configurable)

	getSideBarPosition(): Position {
		return Position.LEFT; // Always left in this layout
	}

	getPanelPosition(): Position {
		return Position.BOTTOM; // Always bottom in this layout
	}

	setPanelPosition(_position: Position): void {
		// No-op: Panel position is fixed in this layout
	}

	getPanelAlignment(): PanelAlignment {
		return 'justify'; // Full width panel
	}

	setPanelAlignment(_alignment: PanelAlignment): void {
		// No-op: Panel alignment is fixed in this layout
	}

	//#endregion

	//#region Size Methods

	getSize(part: Parts): IViewSize {
		if (part === Parts.TITLEBAR_PART) {
			return { width: this._mainContainerDimension.width, height: REVIEW_CHROME_HEIGHT };
		}
		if (part === Parts.AUXILIARYBAR_PART) {
			return this._auxiliaryBarViewSize();
		}
		const view = this.getPartView(part);
		if (!view) {
			return { width: 0, height: 0 };
		}
		return this.workbenchGrid.getViewSize(view);
	}

	setSize(part: Parts, size: IViewSize): void {
		if (part === Parts.AUXILIARYBAR_PART) {
			this._setAuxiliaryBarViewSize(size);
			return;
		}
		const view = this.getPartView(part);
		if (view) {
			this.workbenchGrid.resizeView(view, size);
		}
	}

	resizePart(part: Parts, sizeChangeWidth: number, sizeChangeHeight: number): void {
		if (part === Parts.AUXILIARYBAR_PART) {
			this._resizeAuxiliaryBarBy(sizeChangeWidth, sizeChangeHeight);
			return;
		}
		const view = this.getPartView(part);
		if (!view) {
			return;
		}

		const currentSize = this.workbenchGrid.getViewSize(view);
		this.workbenchGrid.resizeView(view, {
			width: currentSize.width + sizeChangeWidth,
			height: currentSize.height + sizeChangeHeight
		});
	}

	private getPartView(part: Parts): ISerializableView | undefined {
		switch (part) {
			case Parts.SIDEBAR_PART:
				return this.sideBarPartView;
			case Parts.AUXILIARYBAR_PART:
				return this.auxiliaryBarPartView;
			case Parts.EDITOR_PART:
				return this.editorPartView;
			case Parts.PANEL_PART:
				return this.panelPartView;
			case Parts.SESSIONS_PART:
				return this.sessionsPartView;
			case Parts.REVIEW_EXPLORER_PART:
				return this.explorerPartView;
			default:
				return undefined;
		}
	}

	getMaximumEditorDimensions(_container: HTMLElement): IDimension {
		// Return the available space for editor (excluding other parts)
		const sidebarWidth = this.partVisibility.sidebar ? this.workbenchGrid.getViewSize(this.sideBarPartView).width : 0;
		const auxiliaryBarWidth = this.partVisibility.auxiliaryBar
			? this._auxiliaryBarLayoutWidth()
			: 0;
		const panelHeight = this.partVisibility.panel ? this.workbenchGrid.getViewSize(this.panelPartView).height : 0;
		return new Dimension(
			this._mainContainerDimension.width - sidebarWidth - auxiliaryBarWidth,
			this._mainContainerDimension.height - panelHeight
		);
	}

	//#endregion

	//#region Unsupported Features (No-ops)

	toggleMaximizedPanel(): void {
		// Review never adds a panel node to its fixed grid.
	}

	isPanelMaximized(): boolean {
		return false;
	}

	toggleMaximizedAuxiliaryBar(): void {
		// No-op: Maximize not supported in this layout
	}

	setAuxiliaryBarMaximized(_maximized: boolean): boolean {
		return false; // Maximize not supported
	}

	isAuxiliaryBarMaximized(): boolean {
		return false; // Maximize not supported
	}

	isEditorMaximized(): boolean {
		return this._editorMaximized;
	}

	setEditorMaximized(maximized: boolean): void {
		if (maximized === this._editorMaximized) {
			return;
		}

		if (maximized) {
			// Save current visibility state
			this._editorLastNonMaximizedVisibility = {
				sidebar: this.partVisibility.sidebar,
				auxiliaryBar: this.partVisibility.auxiliaryBar,
				editor: this.partVisibility.editor,
				panel: this.partVisibility.panel,
				sessions: this.partVisibility.sessions,
				explorer: this.partVisibility.explorer,
			};

			// Save the editor part size so it can be restored on un-maximize.
			// While maximized the layout controller forces the auxiliary bar
			// (Changes) visible, which shrinks the editor; without restoring the
			// size the editor would not return to its previous width.
			this._editorLastNonMaximizedSize = this.editorPartView
				? this.workbenchGrid.getViewSize(this.editorPartView)
				: undefined;

			// Ensure editor is visible
			if (!this.partVisibility.editor) {
				this.setEditorHidden(false);
			}

			// Hide all other content parts
			if (this.partVisibility.sidebar) {
				this.setSideBarHidden(true);
			}
			if (this.partVisibility.sessions) {
				this.setSessionsHidden(true);
			}
			if (this.partVisibility.explorer) {
				this.setExplorerHidden(true);
			}

			this._editorMaximized = true;
		} else {
			const state = this._editorLastNonMaximizedVisibility;
			const size = this._editorLastNonMaximizedSize;
			this._editorLastNonMaximizedSize = undefined;

			// Restore previous visibility state, including the auxiliary bar
			// (which the layout controller forced visible while maximized).
			this.setSideBarHidden(!state?.sidebar);
			this.setSessionsHidden(!state?.sessions);
			this.setAuxiliaryBarHidden(!state?.auxiliaryBar);

			this._editorMaximized = false;

			// After the flag clears, so `setExplorerHidden` no longer refuses to show.
			this.setExplorerHidden(!state?.explorer);

			// Restore the editor part width captured before maximizing.
			if (this.editorPartView && size) {
				this.workbenchGrid.resizeView(this.editorPartView, size);
			}
			this._layoutSidePane();
		}

		this._onDidChangeEditorMaximized.fire();
	}

	toggleZenMode(): void {
		// No-op: Zen mode not supported in this layout
	}

	toggleMenuBar(): void {
		// No-op: Menu bar toggle not supported in this layout
	}

	isMainEditorLayoutCentered(): boolean {
		return false; // Centered layout not supported
	}

	centerMainEditorLayout(_active: boolean): void {
		// No-op: Centered layout not supported in this layout
	}

	hasMainWindowBorder(): boolean {
		return false;
	}

	getMainWindowBorderRadius(): string | undefined {
		return undefined;
	}

	//#endregion

	//#region Window Maximized State

	isWindowMaximized(targetWindow: Window): boolean {
		return this.maximized.has(getWindowId(targetWindow));
	}

	updateWindowMaximizedState(targetWindow: Window, maximized: boolean): void {
		const windowId = getWindowId(targetWindow);
		if (maximized) {
			this.maximized.add(windowId);
			if (targetWindow === mainWindow) {
				this.mainContainer.classList.add(LayoutClasses.MAXIMIZED);
			}
		} else {
			this.maximized.delete(windowId);
			if (targetWindow === mainWindow) {
				this.mainContainer.classList.remove(LayoutClasses.MAXIMIZED);
			}
		}

		this._onDidChangeWindowMaximized.fire({ windowId, maximized });
	}

	//#endregion

	//#region Neighbor Parts

	getVisibleNeighborPart(part: Parts, direction: Direction): Parts | undefined {
		if (!this.workbenchGrid) {
			return undefined;
		}

		const view = this.getPartView(part);
		if (!view) {
			return undefined;
		}

		const neighbor = this.workbenchGrid.getNeighborViews(view, direction, false);
		if (neighbor.length === 0) {
			return undefined;
		}

		const neighborView = neighbor[0];

		if (neighborView === this.sideBarPartView) {
			return Parts.SIDEBAR_PART;
		}
		if (neighborView === this.auxiliaryBarPartView) {
			return Parts.AUXILIARYBAR_PART;
		}
		if (neighborView === this.editorPartView) {
			return Parts.EDITOR_PART;
		}
		if (neighborView === this.panelPartView) {
			return Parts.PANEL_PART;
		}
		if (neighborView === this.sessionsPartView) {
			return Parts.SESSIONS_PART;
		}
		if (neighborView === this.explorerPartView) {
			return Parts.REVIEW_EXPLORER_PART;
		}

		return undefined;
	}

	//#endregion

	//#region Restore

	isRestored(): boolean {
		return this.restored;
	}

	setRestored(): void {
		this.restored = true;
		this.restoredPromise.complete();
	}

	//#endregion

	//#region Notifications Registration

	registerNotifications(delegate: { onDidChangeNotificationsVisibility: Event<boolean> }): void {
		this._register(delegate.onDidChangeNotificationsVisibility(visible => this._onDidChangeNotificationsVisibility.fire(visible)));
	}

	//#endregion
}
