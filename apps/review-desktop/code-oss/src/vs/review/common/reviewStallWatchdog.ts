/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface StallWatchdogOptions {
	onStall: (durationMs: number) => void;
	thresholdMs?: number;
	intervalMs?: number;
	maxReports?: number;
	/** A longer lag is a sleep or a suspended process, not a stall. */
	maxLagMs?: number;
	now?: () => number;
	schedule?: (tick: () => void, intervalMs: number) => () => void;
	/** Background windows throttle timers, so their lag says nothing. */
	isVisible?: () => boolean;
	onVisibilityChange?: (listener: () => void) => () => void;
}

/**
 * Measures main-thread stalls as timer drift: a tick that fires long after it
 * was due means the thread was busy or blocked. Cheap enough to run always.
 */
export function startStallWatchdog(options: StallWatchdogOptions): () => void {
	const thresholdMs = options.thresholdMs ?? 2_000;
	const intervalMs = options.intervalMs ?? 500;
	const maxReports = options.maxReports ?? 5;
	const maxLagMs = options.maxLagMs ?? 60_000;
	const now = options.now ?? (() => Date.now());
	const isVisible = options.isVisible ?? (() => true);
	const schedule =
		options.schedule ??
		((tick, ms) => {
			const handle = setInterval(tick, ms);
			return () => clearInterval(handle);
		});
	let last = now();
	let reports = 0;
	const stopWatchingVisibility = options.onVisibilityChange?.(() => { last = now(); });
	const stopTicking = schedule(() => {
		const current = now();
		const lag = current - last - intervalMs;
		last = current;
		if (!isVisible() || lag < thresholdMs || lag > maxLagMs || reports >= maxReports) {
			return;
		}
		reports++;
		options.onStall(Math.round(lag));
	}, intervalMs);
	return () => {
		stopTicking();
		stopWatchingVisibility?.();
	};
}
