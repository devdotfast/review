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
  private client?: ReviewApiClient;
  private started?: Promise<void>;

  constructor(
    @IReviewSessionService private readonly session: IReviewSessionService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
  }

  initialize(): Promise<void> {
    return (this.started ??= this.connect());
  }

  private async connect(): Promise<void> {
    this.client = new ReviewApiClient(await this.session.getConnection());
    const abort = new AbortController();
    this._register(toDisposable(() => abort.abort()));
    const accept = (reviews: ReviewApiSummary[]) => {
      const previous = this.reviews;
      this.reviews = reviews.map((review) => ({
        uuid: review.reviewId,
        title: review.title,
        status:
          review.decision === "approve"
            ? "accepted"
            : review.decision === "request-changes"
              ? "awaiting-agent-updates"
              : "awaiting-review",
        available: true,
        repoKey: review.pins.repositoryId,
        repositoryLabel: review.repositoryName,
        sourceBranch: null,
        baseCommit: review.pins.base,
        sourceCommit: review.pins.head,
        presentedDocumentRevision: String(review.version),
        lastPublishedAt: null,
        documentUpdatedAt: review.createdAt,
        viewedAt: review.viewedAt,
        dismissedAt: review.dismissedAt,
        commentCount: review.commentCount,
      }));
      this.changed.fire();
      for (const review of previous) {
        const next = this.reviews.find(next => next.uuid === review.uuid);
        if (!next || (!review.dismissedAt && next.dismissedAt)) this.closed.fire(review.uuid);
      }
    };
    try {
      accept(await this.client.read<ReviewApiSummary[]>("", abort.signal));
    } catch (error) {
      this.log.warn("[Review] Could not load API reviews:", error);
    }
    void this.client.follow<ReviewApiSummary[]>(null, abort.signal, "document", accept, (error) =>
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
