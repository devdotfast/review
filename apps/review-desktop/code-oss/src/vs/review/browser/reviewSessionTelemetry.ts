/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { generateUuid } from "../../base/common/uuid.js";

export interface ReviewSessionTelemetryContext {
	readonly reviewUuid: string;
	readonly presentationSessionId: string;
}

/** The part of a catalog entry that says whether a review is still open. */
export interface ReviewSessionCatalogEntry {
	readonly reviewId: string;
	readonly dismissedAt: string | null;
}

export type ReviewSessionOutcome = "closed" | "dismissed" | "deleted" | "app_quit" | "abnormal";

type Capture = (
	name: string,
	properties: Record<string, string | number | boolean>,
	context: ReviewSessionTelemetryContext,
) => void;

/**
 * The reader's view of one review: opened, presented, ended. The raw ids in the
 * context stay on this machine; the local server replaces them with keyed HMACs.
 */
export class ReviewSessionTelemetry {
	private active: { context: ReviewSessionTelemetryContext; startedAt: number; presented: boolean } | undefined;

	constructor(
		private readonly capture: Capture,
		private readonly now: () => number = Date.now,
		private readonly newId: () => string = generateUuid,
	) {}

	start(reviewUuid: string): void {
		this.end("closed");
		const context = { reviewUuid, presentationSessionId: this.newId() };
		this.active = { context, startedAt: this.now(), presented: false };
		this.capture("session_started", {}, context);
	}

	presented(): void {
		if (this.active) this.markPresented({ load_ms: this.now() - this.active.startedAt });
	}

	/** Presented from an already-ready canvas: no load time, so it cannot skew the load distribution. */
	resumed(): void {
		this.markPresented({});
	}

	private markPresented(properties: Record<string, number>): void {
		if (!this.active || this.active.presented) return;
		this.active.presented = true;
		this.capture("review_presented", properties, this.active.context);
	}

	/**
	 * Ends the session as dismissed or deleted when the catalog shows its review
	 * went, whoever did it: the topbar, Home or another window. The catalog fires
	 * this before it asks the tabs to close, so the close cannot win.
	 */
	catalogChanged(previous: readonly ReviewSessionCatalogEntry[], current: readonly ReviewSessionCatalogEntry[]): void {
		const reviewUuid = this.active?.context.reviewUuid;
		const before = previous.find(review => review.reviewId === reviewUuid);
		if (!before) return;
		const after = current.find(review => review.reviewId === reviewUuid);
		if (!after) {
			this.end("deleted");
		} else if (!before.dismissedAt && after.dismissedAt) {
			this.end("dismissed");
		}
	}

	end(outcome: ReviewSessionOutcome): void {
		if (!this.active) return;
		const { context, startedAt } = this.active;
		this.active = undefined;
		this.capture("session_ended", { outcome, duration_ms: this.now() - startedAt }, context);
	}
}
