/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { LRUCache } from "../../base/common/map.js";
import { createDecorator } from "../../platform/instantiation/common/instantiation.js";
import type {
  ReviewCommitScope,
  ReviewDiffFileWire,
} from "../common/reviewProtocol.js";
import { parseReviewDiffFilesResponse } from "../common/reviewProtocol.js";
import { reviewDiffFilesUrl } from "../common/reviewReveal.js";
import {
  IReviewSessionModelService,
  type ReviewDesktopSession,
} from "./reviewSessionModelService.js";

export const IReviewDiffService =
  createDecorator<IReviewDiffService>("reviewDiffService");

/** Owns loading and parsing diff data for the active Review session. */
export interface IReviewDiffService {
  readonly _serviceBrand: undefined;
  files(scope?: ReviewCommitScope): Promise<readonly ReviewDiffFileWire[]>;
  patch(path: string): Promise<string | undefined>;
  prefetch(scope?: ReviewCommitScope): Promise<void>;
}

export class ReviewDiffService implements IReviewDiffService {
  declare readonly _serviceBrand: undefined;
  private readonly corpora = new LRUCache<
    string,
    Promise<readonly ReviewDiffFileWire[]>
  >(8);

  constructor(
    @IReviewSessionModelService
    private readonly sessionModelService: IReviewSessionModelService,
  ) {}

  files(scope?: ReviewCommitScope): Promise<readonly ReviewDiffFileWire[]> {
    const model = this.sessionModelService.activeModel;
    if (!model) return Promise.reject(new Error("Review session is unavailable."));
    const key = this.cacheKey(model.session, scope);
    const cached = this.corpora.get(key);
    if (cached) return cached;

    let pending: Promise<readonly ReviewDiffFileWire[]>;
    pending = this.loadCorpus(model.session, scope).catch((error) => {
      if (this.corpora.get(key) === pending) this.corpora.delete(key);
      throw error;
    });
    this.corpora.set(key, pending);
    return pending;
  }

  async patch(path: string): Promise<string | undefined> {
    return (await this.files()).find((file) => file.path === path)?.patch;
  }

  async prefetch(scope?: ReviewCommitScope): Promise<void> {
    await this.files(scope);
  }

  private async loadCorpus(
    session: ReviewDesktopSession,
    scope?: ReviewCommitScope,
  ): Promise<readonly ReviewDiffFileWire[]> {
    const model = this.sessionModelService.activeModel;
    if (model?.session.session.sessionId !== session.session.sessionId) {
      throw new Error("Review diff request belongs to a stale session.");
    }
    const routePath = session.session.routePath ?? "/";
    const response = await model.request(
      String(reviewDiffFilesUrl(session.sessionUrl, routePath)),
      {
        method: "POST",
        headers: {
          "x-review-token": session.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          includePatch: true,
          commit: scope?.commit,
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    const result = parseReviewDiffFilesResponse(await response.json());
    if (!response.ok || !result.ok) {
      throw new Error(
        result.ok ? `Review diff returned ${response.status}.` : result.error,
      );
    }
    this.requireCurrentSession(session);
    return result.files;
  }

  private cacheKey(
    session: ReviewDesktopSession,
    scope?: ReviewCommitScope,
  ): string {
    const wire = session.session;
    return [
      wire.sessionId,
      wire.resolvedBaseRef,
      wire.baseRef,
      wire.headRef ?? "",
      wire.routePath ?? "/",
      wire.rootPath,
      wire.baseRootPath ?? "",
      wire.headRootPath ?? "",
      scope?.commit ?? "full",
    ].join("\n");
  }

  private requireCurrentSession(session: ReviewDesktopSession): void {
    if (
      this.sessionModelService.activeModel?.session.session.sessionId !==
      session.session.sessionId
    ) {
      throw new Error("Review diff request belongs to a stale session.");
    }
  }
}
