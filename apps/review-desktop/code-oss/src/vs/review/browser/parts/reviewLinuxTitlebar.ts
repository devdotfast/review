/*---------------------------------------------------------------------------------------------
 * Copyright (c) dev.fast. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../nls.js';
import { Separator, toAction } from '../../../base/common/actions.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../base/common/themables.js';
import { Codicon } from '../../../base/common/codicons.js';
import { $, addDisposableListener, append, getWindowId } from '../../../base/browser/dom.js';
import { renderIcon } from '../../../base/browser/ui/iconLabel/iconLabels.js';
import { CodeWindow } from '../../../base/browser/window.js';
import { ICommandService } from '../../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../platform/dialogs/common/dialogs.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { IKeybindingService } from '../../../platform/keybinding/common/keybinding.js';
import { INativeHostService } from '../../../platform/native/common/native.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { WindowControlsStyle, getWindowControlsStyle } from '../../../platform/window/common/window.js';

/** Linux has no macOS application menu. Keep its commands next to navigation. */
export class ReviewLinuxTitlebar extends Disposable {
	constructor(
		left: HTMLElement,
		controls: HTMLElement | undefined,
		targetWindow: CodeWindow,
		@ICommandService commandService: ICommandService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IDialogService dialogService: IDialogService,
		@IConfigurationService configurationService: IConfigurationService,
		@INativeHostService nativeHostService: INativeHostService,
		@INotificationService notificationService: INotificationService,
	) {
		super();
		const menu = append(left, $('button.review-application-menu', {
			type: 'button', title: localize('review.menu.title', "Review menu (F10)"),
			'aria-label': localize('review.menu.label', "Review menu"), 'aria-haspopup': 'menu', 'aria-expanded': 'false',
		}));
		append(menu, renderIcon(Codicon.menu));
		let dialogOpen = false;
		this._register(dialogService.onWillShowDialog(() => { dialogOpen = true; }));
		this._register(dialogService.onDidShowDialog(() => { dialogOpen = false; }));
		const command = (id: string, label: string) => toAction({ id, label, run: () => commandService.executeCommand(id) });
		const showMenu = () => {
			if (dialogOpen || menu.getAttribute('aria-expanded') === 'true') { return; }
			menu.setAttribute('aria-expanded', 'true');
			contextMenuService.showContextMenu({
				getAnchor: () => menu,
				autoSelectFirstItem: true,
				getActions: () => [
					command('workbench.action.showCommands', localize('review.menu.commands', "Command Palette...")),
					command('review.openSettings', localize('review.menu.settings', "Settings...")),
					command('review.manageExtensions', localize('review.menu.extensions', "Manage Extensions...")),
					command('review.openWelcome', localize('review.menu.welcome', "Getting Started...")),
					new Separator(),
					command('review.checkForUpdates', localize('review.menu.updates', "Check for Updates...")),
					toAction({ id: 'review.about', label: localize('review.menu.about', "About Review"), run: () => dialogService.about() }),
					new Separator(),
					command('workbench.action.quit', localize('review.menu.quit', "Quit Review")),
				],
				getKeyBinding: action => keybindingService.lookupKeybinding(action.id),
				onHide: () => { menu.setAttribute('aria-expanded', 'false'); menu.focus(); },
			});
		};
		this._register(addDisposableListener(menu, 'click', showMenu));
		this._register(addDisposableListener(menu, 'keydown', event => {
			if (event.key === 'ArrowDown') { event.preventDefault(); showMenu(); }
		}));
		this._register(addDisposableListener(targetWindow, 'keydown', event => {
			if (event.key === 'F10' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
				event.preventDefault(); event.stopPropagation(); showMenu();
			}
		}, true));
		if (!controls || getWindowControlsStyle(configurationService) !== WindowControlsStyle.CUSTOM) { return; }
		const options = { targetWindowId: getWindowId(targetWindow) };
		const button = (label: string, icon: ThemeIcon, run: () => Promise<void>, close = false) => {
			const element = append(controls, $('button.window-icon', { type: 'button', 'aria-label': label, title: label }));
			if (close) { element.classList.add('window-close'); }
			append(element, renderIcon(icon));
			this._register(addDisposableListener(element, 'click', () => { void run().catch(error => notificationService.error(error)); }));
			return element;
		};
		button(localize('review.window.minimize', "Minimize"), Codicon.chromeMinimize, () => nativeHostService.minimizeWindow(options));
		let maximized = false;
		const maximize = button(localize('review.window.maximize', "Maximize"), Codicon.chromeMaximize,
			() => maximized ? nativeHostService.unmaximizeWindow(options) : nativeHostService.maximizeWindow(options));
		const updateMaximized = (value: boolean) => {
			maximized = value;
			maximize.replaceChildren(renderIcon(value ? Codicon.chromeRestore : Codicon.chromeMaximize));
			const label = value ? localize('review.window.restore', "Restore") : localize('review.window.maximize', "Maximize");
			maximize.title = label; maximize.setAttribute('aria-label', label);
		};
		this._register(nativeHostService.onDidMaximizeWindow(id => { if (id === options.targetWindowId) { updateMaximized(true); } }));
		this._register(nativeHostService.onDidUnmaximizeWindow(id => { if (id === options.targetWindowId) { updateMaximized(false); } }));
		void nativeHostService.isMaximized(options).then(updateMaximized, error => notificationService.error(error));
		button(localize('review.window.close', "Close"), Codicon.chromeClose, () => nativeHostService.closeWindow(options), true);
	}
}
