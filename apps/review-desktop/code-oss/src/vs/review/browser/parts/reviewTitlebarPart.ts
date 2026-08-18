/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import '../../../workbench/browser/parts/titlebar/media/titlebarpart.css';
import '../media/review.css';
import { localize } from '../../../nls.js';
import { MultiWindowParts, Part } from '../../../workbench/browser/part.js';
import { ITitleService } from '../../../workbench/services/title/browser/titleService.js';
import { getWCOTitlebarAreaRect, getZoomFactor, isFullscreen, isWCOEnabled, onDidChangeFullscreen } from '../../../base/browser/browser.js';
import { TitlebarStyle, WindowControlsStyle, getTitleBarStyle, getWindowControlsStyle, hasCustomTitlebar, hasNativeTitlebar } from '../../../platform/window/common/window.js';
import { REVIEW_CHROME_HEIGHT } from '../../common/reviewChrome.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { TITLE_BAR_ACTIVE_BACKGROUND, TITLE_BAR_ACTIVE_FOREGROUND, TITLE_BAR_INACTIVE_BACKGROUND, TITLE_BAR_INACTIVE_FOREGROUND } from '../../../workbench/common/theme.js';
import { isMacintosh, isNative, isWeb, platformLocale } from '../../../base/common/platform.js';
import { $, addDisposableListener, append, getWindow, getWindowId, prepend } from '../../../base/browser/dom.js';
import { renderIcon } from '../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../base/common/codicons.js';
import { KeyCode } from '../../../base/common/keyCodes.js';
import { StandardKeyboardEvent } from '../../../base/browser/keyboardEvent.js';
import { ICommandService } from '../../../platform/commands/common/commands.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { IWorkbenchLayoutService, Parts } from '../../../workbench/services/layout/browser/layoutService.js';
import { IHostService } from '../../../workbench/services/host/browser/host.js';
import { IEditorGroupsContainer } from '../../../workbench/services/editor/common/editorGroupsService.js';
import { CodeWindow, mainWindow } from '../../../base/browser/window.js';
import { safeIntl } from '../../../base/common/date.js';
import { IAuxiliaryTitlebarPart, ITitleProperties, ITitleVariable, ITitlebarPart } from '../../../workbench/browser/parts/titlebar/titlebarPart.js';
import { WindowTitle } from '../../../workbench/browser/parts/titlebar/windowTitle.js';
import { CommandCenterControl } from '../../../workbench/browser/parts/titlebar/commandCenterControl.js';
import { INativeHostService } from '../../../platform/native/common/native.js';
import { getDefaultHoverDelegate } from '../../../base/browser/ui/hover/hoverDelegateFactory.js';

/**
 * The deliberately small Review titlebar. It owns the drag region and the macOS
 * traffic-light inset while reusing VS Code's native navigation control. The
 * navigation control sits at the left, directly after the traffic lights, where
 * macOS applications put their back and forward arrows. The bar carries no
 * product label: the branding lives in the macOS application menu.
 */
export class ReviewTitlebarPart extends Part implements ITitlebarPart {

	readonly minimumWidth = 0;
	readonly maximumWidth = Number.POSITIVE_INFINITY;

	get minimumHeight(): number {
		const wcoHeight = isWeb && isWCOEnabled()
			? getWCOTitlebarAreaRect(getWindow(this.element))?.height ?? 0
			: 0;
		return Math.max(REVIEW_CHROME_HEIGHT, wcoHeight) / (this.preventZoom ? getZoomFactor(getWindow(this.element)) : 1);
	}

	get maximumHeight(): number { return this.minimumHeight; }

	private readonly _onMenubarVisibilityChange = this._register(new Emitter<boolean>());
	readonly onMenubarVisibilityChange = this._onMenubarVisibilityChange.event;

	private readonly _onWillDispose = this._register(new Emitter<void>());
	readonly onWillDispose = this._onWillDispose.event;

	protected rootContainer!: HTMLElement;
	protected windowControlsContainer: HTMLElement | undefined;
	private leftContent!: HTMLElement;
	private rightContent!: HTMLElement;

	get leftContainer(): HTMLElement { return this.leftContent; }
	get rightContainer(): HTMLElement { return this.rightContent; }
	get rightWindowControlsContainer(): HTMLElement | undefined { return this.windowControlsContainer; }

	private readonly titleBarStyle: TitlebarStyle;
	private isInactive = false;

	constructor(
		id: string,
		targetWindow: CodeWindow,
		@IConfigurationService protected readonly configurationService: IConfigurationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService protected override readonly layoutService: IWorkbenchLayoutService,
		@IHostService hostService: IHostService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(id, { hasTitle: false }, themeService, storageService, layoutService);
		this.titleBarStyle = getTitleBarStyle(configurationService);

		const targetWindowId = getWindowId(targetWindow);
		this._register(hostService.onDidChangeFocus(focused => this.setInactive(!focused)));
		this._register(hostService.onDidChangeActiveWindow(windowId => this.setInactive(windowId !== targetWindowId)));
	}

	private setInactive(inactive: boolean): void {
		this.isInactive = inactive;
		this.updateStyles();
	}

	updateProperties(_properties: ITitleProperties): void { }
	registerVariables(_variables: ITitleVariable[]): void { }
	updateOptions(_options: { compact: boolean }): void { }

	protected get paintsBackground(): boolean { return true; }

	protected override createContentArea(parent: HTMLElement): HTMLElement {
		this.element = parent;
		this.rootContainer = append(parent, $('.titlebar-container.review-titlebar-container'));
		prepend(this.rootContainer, $('div.titlebar-drag-region'));

		this.leftContent = append(this.rootContainer, $('.titlebar-left'));
		this.rightContent = append(this.rootContainer, $('.titlebar-right'));

		// The window controls come first so the traffic-light inset stays to the
		// left of the navigation control that the block below appends.
		if (!hasNativeTitlebar(this.configurationService, this.titleBarStyle)) {
			let controlsLocation: 'left' | 'right' = isMacintosh ? 'left' : 'right';
			if (isMacintosh && isNative) {
				const localeInfo = safeIntl.Locale(platformLocale).value;
				if ((localeInfo as { textInfo?: { direction?: string } }).textInfo?.direction === 'rtl') {
					controlsLocation = 'right';
				}
			}

			if (isMacintosh && isNative && controlsLocation === 'left') {
				const spacer = append(this.leftContent, $('div.window-controls-container.review-traffic-light-inset'));
				const updateSpacer = () => {
					const fullscreen = isFullscreen(mainWindow);
					spacer.style.display = fullscreen ? 'none' : '';
					spacer.style.width = fullscreen ? '0' : '70px';
				};
				updateSpacer();
				this._register(onDidChangeFullscreen(windowId => {
					if (windowId === getWindowId(mainWindow)) {
						updateSpacer();
					}
				}));
			} else if (getWindowControlsStyle(this.configurationService) !== WindowControlsStyle.HIDDEN) {
				const controlsParent = controlsLocation === 'left' ? this.leftContent : this.rightContent;
				this.windowControlsContainer = append(controlsParent, $('div.window-controls-container'));
				if (isWeb) {
					append(controlsLocation === 'left' ? this.rightContent : this.leftContent, $('div.window-controls-container'));
				}
				if (isWCOEnabled()) {
					this.windowControlsContainer.classList.add('wco-enabled');
				}
			}
		}

		const navigationContainer = append(this.leftContent, $('div.review-titlebar-navigation'));
		const windowTitle = this._register(this.instantiationService.createInstance(WindowTitle, getWindow(parent)));
		const navigationControl = this._register(this.instantiationService.createInstance(
			CommandCenterControl,
			windowTitle,
			getDefaultHoverDelegate('mouse'),
		));
		append(navigationContainer, navigationControl.element);
		this.createFileTreeToggle();

		this.updateStyles();
		return this.element;
	}

	/**
	 * The file-tree toggle, right of the navigation arrows.
	 *
	 * The button holds a fixed 22px slot at all times, even with no tree to
	 * toggle. That keeps the left cluster a constant width, and the cluster width
	 * is what `--review-chrome-left-width` reports to the editor tab strip — so
	 * fading the button in never moves a tab. Both icons render here and CSS picks
	 * one, which keeps this part free of any explorer state subscription.
	 */
	private createFileTreeToggle(): void {
		const toggle = append(this.leftContent, $('div.review-titlebar-file-tree-toggle', {
			role: 'button',
			tabindex: '0',
			title: localize('review.toggleFileTree.tooltip', "Toggle File Tree"),
			'aria-label': localize('review.toggleFileTree.tooltip', "Toggle File Tree"),
		}));

		append(toggle, renderIcon(Codicon.layoutSidebarLeft)).classList.add('review-file-tree-icon-open');
		append(toggle, renderIcon(Codicon.layoutSidebarLeftOff)).classList.add('review-file-tree-icon-closed');

		const run = () => void this.commandService.executeCommand('review.toggleFileTree');
		this._register(addDisposableListener(toggle, 'click', run));
		this._register(addDisposableListener(toggle, 'keydown', event => {
			const keyboardEvent = new StandardKeyboardEvent(event);
			if (keyboardEvent.equals(KeyCode.Enter) || keyboardEvent.equals(KeyCode.Space)) {
				keyboardEvent.preventDefault();
				keyboardEvent.stopPropagation();
				run();
			}
		}));
	}

	override updateStyles(): void {
		super.updateStyles();
		if (!this.element) {
			return;
		}

		this.element.classList.toggle('inactive', this.isInactive);
		this.element.style.backgroundColor = this.paintsBackground
			? this.getColor(this.isInactive ? TITLE_BAR_INACTIVE_BACKGROUND : TITLE_BAR_ACTIVE_BACKGROUND) || ''
			: '';
		this.element.style.color = this.getColor(this.isInactive ? TITLE_BAR_INACTIVE_FOREGROUND : TITLE_BAR_ACTIVE_FOREGROUND) || '';
	}

	get hasZoomableElements(): boolean { return false; }
	get preventZoom(): boolean { return true; }

	override layout(width: number, height: number): void {
		if (hasCustomTitlebar(this.configurationService, this.titleBarStyle)) {
			const zoomFactor = getZoomFactor(getWindow(this.element));
			this.element.style.setProperty('--zoom-factor', zoomFactor.toString());
			this.rootContainer.classList.toggle('counter-zoom', this.preventZoom);
		}
		super.layoutContents(width, height);
	}

	focus(): void { }
	toJSON(): object { return { type: Parts.TITLEBAR_PART }; }

	override dispose(): void {
		this._onWillDispose.fire();
		super.dispose();
	}
}

export class MainReviewTitlebarPart extends ReviewTitlebarPart {
	protected override get paintsBackground(): boolean { return false; }

	override layout(width: number, height: number): void {
		super.layout(width, height);
		void this.nativeHostService.updateWindowControls({
			targetWindowId: getWindowId(mainWindow),
			height: Math.round(REVIEW_CHROME_HEIGHT * getZoomFactor(mainWindow))
		});
	}

	protected override createContentArea(parent: HTMLElement): HTMLElement {
		const element = super.createContentArea(parent);
		const updateChromeWidths = () => {
			this.layoutService.mainContainer.style.setProperty('--review-chrome-left-width', `${this.leftContainer.getBoundingClientRect().width}px`);
			this.layoutService.mainContainer.style.setProperty('--review-chrome-right-width', `${this.rightContainer.getBoundingClientRect().width}px`);
		};
		const observer = new ResizeObserver(updateChromeWidths);
		observer.observe(this.leftContainer);
		observer.observe(this.rightContainer);
		this._register(toDisposable(() => observer.disconnect()));
		updateChromeWidths();

		return element;
	}

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IHostService hostService: IHostService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ICommandService commandService: ICommandService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
	) {
		super(Parts.TITLEBAR_PART, mainWindow, configurationService, themeService, storageService, layoutService, hostService, instantiationService, commandService);
	}
}

export class AuxiliaryReviewTitlebarPart extends ReviewTitlebarPart implements IAuxiliaryTitlebarPart {
	private static counter = 1;
	get height(): number { return this.minimumHeight; }

	constructor(
		readonly container: HTMLElement,
		private readonly mainTitlebar: ReviewTitlebarPart,
		@IConfigurationService configurationService: IConfigurationService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IHostService hostService: IHostService,
		@IInstantiationService instantiationService: IInstantiationService,
		@ICommandService commandService: ICommandService,
	) {
		super(`workbench.parts.auxiliaryTitle.${AuxiliaryReviewTitlebarPart.counter++}`, getWindow(container), configurationService, themeService, storageService, layoutService, hostService, instantiationService, commandService);
	}

	override get preventZoom(): boolean {
		return getZoomFactor(getWindow(this.element)) < 1 || !this.mainTitlebar.hasZoomableElements;
	}
}

export class ReviewTitleService extends MultiWindowParts<ReviewTitlebarPart> implements ITitleService {
	declare _serviceBrand: undefined;
	readonly mainPart: ReviewTitlebarPart;
	readonly onMenubarVisibilityChange: Event<boolean>;

	constructor(
		@IInstantiationService protected readonly instantiationService: IInstantiationService,
		@IStorageService storageService: IStorageService,
		@IThemeService themeService: IThemeService,
	) {
		super('workbench.reviewTitleService', themeService, storageService);
		this.mainPart = this._register(this.instantiationService.createInstance(MainReviewTitlebarPart));
		this.onMenubarVisibilityChange = this.mainPart.onMenubarVisibilityChange;
		this._register(this.registerPart(this.mainPart));
	}

	createAuxiliaryTitlebarPart(container: HTMLElement, _editorGroupsContainer: IEditorGroupsContainer, instantiationService: IInstantiationService): IAuxiliaryTitlebarPart {
		const partContainer = $('.part.titlebar', { role: 'none' });
		partContainer.style.position = 'relative';
		container.insertBefore(partContainer, container.firstChild);

		const disposables = new DisposableStore();
		const part = instantiationService.createInstance(AuxiliaryReviewTitlebarPart, partContainer, this.mainPart);
		disposables.add(this.registerPart(part));
		disposables.add(Event.runAndSubscribe(part.onDidChange, () => partContainer.style.height = `${part.height}px`));
		part.create(partContainer);
		Event.once(part.onWillDispose)(() => disposables.dispose());
		return part;
	}

	updateProperties(properties: ITitleProperties): void {
		for (const part of this.parts) {
			part.updateProperties(properties);
		}
	}

	registerVariables(variables: ITitleVariable[]): void {
		for (const part of this.parts) {
			part.registerVariables(variables);
		}
	}

	private _windowTitle: WindowTitle | undefined;
	get windowTitle(): WindowTitle {
		if (!this._windowTitle) {
			this._windowTitle = this._register(this.instantiationService.createInstance(WindowTitle, mainWindow));
		}
		return this._windowTitle;
	}
}
