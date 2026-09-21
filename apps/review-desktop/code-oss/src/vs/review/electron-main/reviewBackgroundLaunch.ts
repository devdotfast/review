/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { FocusMode } from "../../platform/native/common/native.js";

/** "1" on `review app` launches without --focus. */
export const REVIEW_DESKTOP_BACKGROUND_ENV = "DEV_FAST_REVIEW_DESKTOP_BACKGROUND";

interface BackgroundWindow {
	show(): void;
	showInactive(): void;
	once(event: "focus", listener: () => void): unknown;
}

/**
 * Shows the first window inactive and swallows focus until the user focuses a
 * window or a forced focus arrives. Releases once per process.
 */
export class ReviewBackgroundLaunch {
	private pending: boolean;
	private showInactiveOnCreate = false;

	constructor(env: NodeJS.ProcessEnv = process.env) {
		this.pending = env[REVIEW_DESKTOP_BACKGROUND_ENV] === "1";
	}

	get suppressesFocus(): boolean {
		return this.pending;
	}

	/** Defers the initial show to `attach`, which shows the window inactive. */
	prepare(options: { show?: boolean }): void {
		if (!this.pending || options.show === false) return;
		options.show = false;
		this.showInactiveOnCreate = true;
	}

	attach(win: BackgroundWindow): void {
		if (!this.pending) return;
		if (this.showInactiveOnCreate) win.showInactive();
		win.once("focus", () => this.release());
	}

	/** show() activates the app on macOS. */
	show(win: BackgroundWindow | null | undefined): void {
		if (this.pending) win?.showInactive();
		else win?.show();
	}

	allowsFocus(mode: FocusMode): boolean {
		if (!this.pending) return true;
		if (mode === FocusMode.Force) {
			this.release();
			return true;
		}
		return mode === FocusMode.Notify;
	}

	private release(): void {
		this.pending = false;
		this.showInactiveOnCreate = false;
	}
}

export const reviewBackgroundLaunch = new ReviewBackgroundLaunch();
