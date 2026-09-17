/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, type Event } from "../../base/common/event.js";
import { Disposable, toDisposable } from "../../base/common/lifecycle.js";
import { generateUuid } from "../../base/common/uuid.js";
import { createDecorator } from "../../platform/instantiation/common/instantiation.js";
import { ILogService } from "../../platform/log/common/log.js";
import {
  ReviewApiClient,
  type ReviewApiSummary,
  type ReviewHomeItem,
} from "../common/reviewProtocol.js";
import { IReviewSessionService } from "./reviewSessionService.js";

export const IReviewApiCatalogService =
  createDecorator<IReviewApiCatalogService>("reviewApiCatalogService");
export interface IReviewApiCatalogService {
  readonly _serviceBrand: undefined;
  readonly reviews: readonly ReviewHomeItem[];
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
  reviews: ReviewHomeItem[] = [];
  loaded = false;
  private client?: ReviewApiClient;
  private started?: Promise<void>;

  constructor(
    @IReviewSessionService private readonly session: IReviewSessionService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
  }

  initialize(): Promise<void> {
    // A failed first list must not stick: Home and the next command retry it.
    return (this.started ??= this.connect().catch((error) => {
      this.started = undefined;
      throw error;
    }));
  }

  private async connect(): Promise<void> {
    const client = new ReviewApiClient(await this.session.getConnection());
    const abort = new AbortController();
    this._register(toDisposable(() => abort.abort()));
    const accept = (reviews: ReviewApiSummary[]) => {
      const previous = this.reviews;
      this.reviews = reviews.map((review) => ({
        uuid: review.reviewId,
        title: review.title,
        status: "awaiting-review",
        available: true,
        repoKey: review.pins.repositoryId,
        repositoryLabel: review.repositoryName,
        worktreePath: review.repositoryPath,
        diffStats: review.diffStats,
        sourceBranch: review.origin?.branch ?? null,
        baseRef: review.origin?.baseRef ?? review.pins.base,
        headRef: review.pins.head,
        pullRequestNumber: review.origin?.pullRequestNumber ?? null,
        pullRequestUrl: review.origin?.pullRequestUrl ?? null,
        presentedDocumentRevision: String(review.version),
        lastPublishedAt: null,
        documentUpdatedAt: review.createdAt,
        viewedAt: review.viewedAt,
        dismissedAt: review.dismissedAt,
      } satisfies ReviewHomeItem));
      this.loaded = true;
      this.changed.fire();
      for (const review of previous) {
        const next = this.reviews.find(next => next.uuid === review.uuid);
        if (!next || (!review.dismissedAt && next.dismissedAt)) this.closed.fire(review.uuid);
      }
    };
    // Surface a failed first list instead of reporting an empty catalog:
    // tab restoration would otherwise drop every persisted API tab.
    accept(await client.read<ReviewApiSummary[]>("", abort.signal));
    this.client = client;
    void client.follow<ReviewApiSummary[]>(null, abort.signal, accept, (error) =>
      this.log.warn("[Review] API review list disconnected:", error),
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
      commandId: generateUuid(), operation: { type: "delete", reviewId },
    });
  }
}
