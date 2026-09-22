/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IConfigurationService } from "../../platform/configuration/common/configuration.js";
import { REVIEW_STRUCTURAL_DIFF_SETTING } from "../common/reviewConfigurationDefaults.js";
import { Emitter, type Event } from "../../base/common/event.js";
import { Disposable, toDisposable } from "../../base/common/lifecycle.js";
import { generateUuid } from "../../base/common/uuid.js";
import { createDecorator } from "../../platform/instantiation/common/instantiation.js";
import { ILogService } from "../../platform/log/common/log.js";
import { ReviewApiClient, type ReviewApiSummary } from "../common/reviewProtocol.js";
import { IReviewDesktopConnectionService } from "./reviewDesktopConnectionService.js";

export const IReviewApiCatalogService = createDecorator<IReviewApiCatalogService>("reviewApiCatalogService");
export interface IReviewApiCatalogService {
	readonly _serviceBrand: undefined;
	readonly reviews: readonly ReviewApiSummary[];
	/** True once the first list arrived; an empty list is then real, not a failed load. */
	readonly loaded: boolean;
	readonly onDidChange: Event<void>;
	readonly onDidCloseReview: Event<string>;
	initialize(): Promise<void>;
	attention(reviewId: string, action: "view" | "dismiss" | "restore"): Promise<void>;
	deleteReview(reviewId: string): Promise<void>;
}

/** A live API list for Home and tab restoration; no legacy review sessions. */
export class ReviewApiCatalogService extends Disposable implements IReviewApiCatalogService {
	declare readonly _serviceBrand: undefined;
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
	private readonly closed = this._register(new Emitter<string>());
	readonly onDidCloseReview = this.closed.event;
	reviews: ReviewApiSummary[] = [];
	loaded = false;
	private client?: ReviewApiClient;
	private started?: Promise<void>;
	private connectionAbort?: AbortController;

	constructor(
		@IReviewDesktopConnectionService private readonly session: IReviewDesktopConnectionService,
		@ILogService private readonly log: ILogService,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) {
		super();
		this._register(configuration.onDidChangeConfiguration(event => {
			if (!event.affectsConfiguration(REVIEW_STRUCTURAL_DIFF_SETTING) || !this.started) return;
			this.connectionAbort?.abort();
			this.started = undefined;
			this.reviews = this.reviews.map(review => ({ ...review, diffStats: null }));
			this.changed.fire();
			void this.initialize().catch(error => this.log.warn("[Whiteboard] Catalog mode change failed:", error));
		}));
	}

	initialize(): Promise<void> {
		// A failed first list must not stick: Home and the next command retry it.
		if (!this.started) {
			const pending = this.connect().catch((error) => {
				if (this.started === pending) this.started = undefined;
				throw error;
			});
			this.started = pending;
		}
		return this.started;
	}

	private async connect(): Promise<void> {
		const abort = new AbortController();
		this.connectionAbort = abort;
		const mode = this.configuration.getValue<boolean>(REVIEW_STRUCTURAL_DIFF_SETTING) === false ? "textual" : "structural";
		const client = new ReviewApiClient(await this.session.getConnection());
		this._register(toDisposable(() => abort.abort()));
		const accept = (reviews: ReviewApiSummary[]) => {
			if (abort.signal.aborted) return;
			const previous = this.reviews;
			this.reviews = reviews;
			this.loaded = true;
			this.changed.fire();
			for (const review of previous) {
				const next = this.reviews.find((next) => next.reviewId === review.reviewId);
				if (!next || (!review.dismissedAt && next.dismissedAt)) this.closed.fire(review.reviewId);
			}
		};
		// Surface a failed first list instead of reporting an empty catalog:
		// tab restoration would otherwise drop every persisted API tab.
		accept(await client.read<ReviewApiSummary[]>(`?mode=${mode}`, abort.signal));
		this.client = client;
		void client.follow<ReviewApiSummary[]>(null, abort.signal, accept, (error) =>
			this.log.warn("[Whiteboard] API review list disconnected:", error),
			mode,
		);
	}

	async attention(reviewId: string, action: "view" | "dismiss" | "restore"): Promise<void> {
		await this.initialize();
		await this.client!.post("/commands", {
			commandId: generateUuid(),
			operation: { type: "attention", reviewId, action },
		});
	}

	async deleteReview(reviewId: string): Promise<void> {
		await this.initialize();
		await this.client!.post("/commands", {
			commandId: generateUuid(),
			operation: { type: "delete", reviewId },
		});
	}
}
