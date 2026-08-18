/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { app, BrowserWindow, Menu, MenuItem } from "electron";
import { RunOnceScheduler } from "../../base/common/async.js";
import { CancellationToken } from "../../base/common/cancellation.js";
import { Disposable } from "../../base/common/lifecycle.js";
import { isMacintosh } from "../../base/common/platform.js";
import { localize } from "../../nls.js";
import {
  ILifecycleMainService,
  LifecycleMainPhase,
} from "../../platform/lifecycle/electron-main/lifecycleMainService.js";
import { ILogService } from "../../platform/log/common/log.js";
import type { IMenubarData } from "../../platform/menubar/common/menubar.js";
import type { IMenubarMainService } from "../../platform/menubar/electron-main/menubarMainService.js";
import { INativeHostMainService } from "../../platform/native/electron-main/nativeHostMainService.js";
import { IProductService } from "../../platform/product/common/productService.js";
import type { INativeRunActionInWindowRequest } from "../../platform/window/common/window.js";
import { IWindowsMainService } from "../../platform/windows/electron-main/windows.js";
import {
  IUpdateService,
  StateType,
} from "../../platform/update/common/update.js";

function labelsOf(menu: Menu): string {
  return menu.items
    .map((item) => {
      if (item.type === "separator") return "---";
      // A submenu hides its items from the log, and the log is the only record
      // of the native menu the user got.
      const nested = item.submenu?.items.length
        ? ` (${labelsOf(item.submenu)})`
        : "";
      return `${item.label}${nested}`;
    })
    .join(" | ");
}

/**
 * Review's native macOS menu bar.
 *
 * Stock Code OSS builds its menu from `IMenubarData` that the renderer's
 * `MenubarControl` pushes over the `menubar` channel. Review replaces the
 * workbench and never creates that control, so `Menubar` only ever installed an
 * empty menu. This service owns the menu in the main process instead: it needs
 * no renderer state, which also keeps "Check for Updates..." working while the
 * renderer's `IUpdateService` stays a stub.
 *
 * The menu is deliberately small — the three menus a Mac application must have.
 * Everything else in Review is reachable from the command palette.
 */
export class ReviewMenubarMainService
  extends Disposable
  implements IMenubarMainService
{
  declare readonly _serviceBrand: undefined;

  private readonly scheduler = this._register(
    new RunOnceScheduler(() => this.install(), 0),
  );

  constructor(
    @ILifecycleMainService lifecycleMainService: ILifecycleMainService,
    @IUpdateService private readonly updateService: IUpdateService,
    @INativeHostMainService
    private readonly nativeHostMainService: INativeHostMainService,
    @IProductService private readonly productService: IProductService,
    @IWindowsMainService
    private readonly windowsMainService: IWindowsMainService,
    @ILogService private readonly logService: ILogService,
  ) {
    super();

    lifecycleMainService.when(LifecycleMainPhase.AfterWindowOpen).then(() => {
      if (this._store.isDisposed) return;

      this.configureAboutPanel();
      this.install();

      // The update item's label is the update state in disguise, so every
      // state change reinstalls the menu.
      this._register(this.updateService.onStateChange(() => this.schedule()));
    });
  }

  /**
   * Fills in the stock macOS About panel. It is a native window, so it needs no
   * renderer and it opens even when every window is closed.
   */
  private configureAboutPanel(): void {
    if (!isMacintosh) return;

    const { reviewVersion, version, commit } = this.productService;

    // `version` is the Code OSS base version, which means nothing to a reader.
    // Show Review's own release number and keep the base version in the credits.
    app.setAboutPanelOptions({
      applicationName: this.productService.nameLong,
      applicationVersion: reviewVersion ?? version,
      // macOS prints this in parentheses after the version. The commit is what
      // the update feed matches on, so it is the build identity that matters.
      version: commit ? commit.substring(0, 10) : "",
      copyright: localize("review.about.copyright", "Copyright © 2026 dev.fast"),
      credits: localize("review.about.codeOss", "Code OSS {0}", version),
    });
  }

  /**
   * No-op. The renderer keeps `menubarService` registered, so the channel must
   * stay answerable, but Review never sends menu data.
   */
  async updateMenubar(
    _windowId: number,
    _menus: IMenubarData,
  ): Promise<void> {}

  private schedule(): void {
    // Electron cannot mutate a live menu, so every change reinstalls the whole
    // menu. Buffer overlapping changes into one rebuild.
    if (!this.scheduler.isScheduled()) {
      this.scheduler.schedule();
    }
  }

  private install(): void {
    if (!isMacintosh) {
      // Review hides the menu bar on Windows and Linux
      // (`window.menuBarVisibility`), so there is nothing to install there.
      Menu.setApplicationMenu(null);
      return;
    }

    const applicationMenu = this.createApplicationMenu();
    const menubar = new Menu();
    menubar.append(
      new MenuItem({
        label: this.productService.nameShort,
        submenu: applicationMenu,
      }),
    );
    const editMenuItem = new MenuItem({
      label: localize("review.menu.edit", "Edit"),
      role: "editMenu",
    });
    editMenuItem.submenu?.insert(
      2,
      new MenuItem({
        label: localize("review.menu.find", "Find"),
        accelerator: "Command+F",
        // Show the standard shortcut in the native menu, but let the focused
        // renderer resolve it. Terminal, tree, webview, notebook, source, and
        // Review each own a context-specific Find command.
        registerAccelerator: false,
        click: () => this.runActionInFocusedWindow("review.action.find"),
      }),
    );
    menubar.append(editMenuItem);
    menubar.append(
      new MenuItem({
        label: localize("review.menu.window", "Window"),
        role: "windowMenu",
      }),
    );

    Menu.setApplicationMenu(menubar);

    // The menu is native, so this log is the only record of what the user got.
    // It also names the update item, which is the update state in disguise.
    this.logService.info(
      `reviewMenubar#install - menus [${labelsOf(menubar)}], application menu [${labelsOf(applicationMenu)}]`,
    );
  }

  private createApplicationMenu(): Menu {
    const name = this.productService.nameLong;
    const menu = new Menu();

    menu.append(
      new MenuItem({
        label: localize("review.menu.about", "About {0}", name),
        role: "about",
      }),
    );

    for (const item of this.createUpdateMenuItems()) {
      menu.append(item);
    }

    // The macOS settings slot. Every item runs the same renderer action as its
    // command palette entry. Electron consumes the accelerator before the web
    // contents, so the workbench keybinding on review.openSettings and this
    // item cannot both fire.
    const preferences = new Menu();
    preferences.append(
      new MenuItem({
        label: localize("review.menu.settings", "Settings..."),
        accelerator: "Command+,",
        click: () => this.runActionInFocusedWindow("review.openSettings"),
      }),
    );
    // The Welcome pane stays reachable after Home fills with reviews: first
    // run opens no tab of its own, so this is the durable path back.
    preferences.append(
      new MenuItem({
        label: localize("review.menu.gettingStarted", "Getting Started..."),
        click: () => this.runActionInFocusedWindow("review.openWelcome"),
      }),
    );
    preferences.append(new MenuItem({ type: "separator" }));
    preferences.append(
      new MenuItem({
        label: localize(
          "review.menu.uninstall",
          "Uninstall Review Desktop...",
        ),
        click: () => this.runActionInFocusedWindow("review.uninstallApp"),
      }),
    );

    menu.append(new MenuItem({ type: "separator" }));
    menu.append(
      new MenuItem({
        label: localize("review.menu.preferences", "Preferences"),
        submenu: preferences,
      }),
    );

    menu.append(new MenuItem({ type: "separator" }));
    menu.append(
      new MenuItem({
        label: localize("review.menu.services", "Services"),
        role: "services",
        submenu: [],
      }),
    );
    menu.append(new MenuItem({ type: "separator" }));
    menu.append(
      new MenuItem({
        label: localize("review.menu.hide", "Hide {0}", name),
        role: "hide",
      }),
    );
    menu.append(
      new MenuItem({
        label: localize("review.menu.hideOthers", "Hide Others"),
        role: "hideOthers",
      }),
    );
    menu.append(
      new MenuItem({
        label: localize("review.menu.showAll", "Show All"),
        role: "unhide",
      }),
    );
    menu.append(new MenuItem({ type: "separator" }));
    menu.append(
      new MenuItem({
        label: localize("review.menu.quit", "Quit {0}", name),
        accelerator: "Command+Q",
        click: () => this.nativeHostMainService.quit(undefined),
      }),
    );

    return menu;
  }

  /**
   * Runs a renderer command in the focused (or last active) window, mirroring
   * stock `Menubar#runActionInRenderer`. Review has no auxiliary windows, so
   * the focused Electron window maps straight to a workbench window.
   */
  private runActionInFocusedWindow(commandId: string): void {
    const focused = BrowserWindow.getFocusedWindow();
    const window = focused
      ? this.windowsMainService.getWindowById(focused.id)
      : this.windowsMainService.getLastActiveWindow();
    if (!window) {
      this.logService.info(
        `reviewMenubar#runActionInFocusedWindow - no window for ${commandId}`,
      );
      return;
    }
    const payload: INativeRunActionInWindowRequest = {
      id: commandId,
      from: "menu",
    };
    window.sendWhenReady("vscode:runAction", CancellationToken.None, payload);
  }

  /**
   * The update item, mirroring stock Code OSS's app menu. Updates are disabled
   * out of sources, so this contributes nothing to a development run.
   */
  private createUpdateMenuItems(): MenuItem[] {
    switch (this.updateService.state.type) {
      case StateType.Idle:
        return [
          new MenuItem({
            label: localize("review.menu.checkForUpdates", "Check for Updates..."),
            // Detached so the menu closes before the check's dialog can open.
            click: () =>
              setTimeout(() => {
                this.updateService.checkForUpdates(true).catch((error) => {
                  this.logService.error(
                    "reviewMenubar#checkForUpdates failed",
                    error,
                  );
                });
              }, 0),
          }),
        ];

      case StateType.CheckingForUpdates:
        return [
          new MenuItem({
            label: localize(
              "review.menu.checkingForUpdates",
              "Checking for Updates...",
            ),
            enabled: false,
          }),
        ];

      case StateType.Downloading:
      case StateType.Overwriting:
        return [
          new MenuItem({
            label: localize(
              "review.menu.downloadingUpdate",
              "Downloading Update...",
            ),
            enabled: false,
          }),
        ];

      case StateType.Updating:
        return [
          new MenuItem({
            label: localize(
              "review.menu.installingUpdate",
              "Installing Update...",
            ),
            enabled: false,
          }),
        ];

      case StateType.Ready:
        return [
          new MenuItem({
            label: localize("review.menu.restartToUpdate", "Restart to Update"),
            click: () => {
              this.updateService.quitAndInstall().catch((error) => {
                this.logService.error(
                  "reviewMenubar#quitAndInstall failed",
                  error,
                );
              });
            },
          }),
        ];

      // Disabled, Uninitialized, and the macOS-unreachable download states
      // contribute nothing.
      default:
        return [];
    }
  }

}
