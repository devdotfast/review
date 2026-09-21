/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { FocusMode } from "../../platform/native/common/native.js";

/** Set to "1" by `review app` launches without --focus. */
export const REVIEW_DESKTOP_BACKGROUND_ENV = "DEV_FAST_REVIEW_DESKTOP_BACKGROUND";

/**
 * A background launch shows the first window without activating the app and
 * ignores focus requests until the user focuses a window or a forced focus
 * (toast click, `review app launch --focus`) arrives. The gate releases once
 * for the process lifetime; later windows behave normally.
 */
export class ReviewBackgroundLaunch {
	private pending: boolean;

	constructor(env: NodeJS.ProcessEnv = process.env) {
		this.pending = env[REVIEW_DESKTOP_BACKGROUND_ENV] === "1";
	}

	get suppressesFocus(): boolean {
		return this.pending;
	}

	allowsFocus(mode: FocusMode): boolean {
		if (!this.pending) return true;
		if (mode === FocusMode.Force) {
			this.release();
			return true;
		}
		return mode === FocusMode.Notify;
	}

	release(): void {
		this.pending = false;
	}
}

export const reviewBackgroundLaunch = new ReviewBackgroundLaunch();
