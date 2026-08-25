/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

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
}

export class ReviewDiffService implements IReviewDiffService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IReviewSessionModelService
    private readonly sessionModelService: IReviewSessionModelService,
  ) {}

  async files(
    scope?: ReviewCommitScope,
  ): Promise<readonly ReviewDiffFileWire[]> {
    const result = await this.request({
      includePatch: false,
      commit: scope?.commit,
    });
    return result.files.map((file) => ({
      path: file.path,
      previousPath: file.previousPath,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
    }));
  }

  async patch(path: string): Promise<string | undefined> {
    const result = await this.request({ includePatch: true, paths: [path] });
    return result.files.find((file) => file.path === path)?.patch;
  }

  private async request(body: {
    includePatch: boolean;
    commit?: string;
    paths?: string[];
  }) {
    const model = this.sessionModelService.activeModel;
    if (!model) throw new Error("Review session is unavailable.");
    const session = model.session;
    const routePath = session.session.routePath ?? "/";
    const response = await model.request(
      String(reviewDiffFilesUrl(session.sessionUrl, routePath)),
      {
        method: "POST",
        headers: {
          "x-review-token": session.token,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(body.includePatch ? 5_000 : 2_000),
      },
    );
    const result = parseReviewDiffFilesResponse(await response.json());
    if (!response.ok || !result.ok) {
      throw new Error(
        result.ok ? `Review diff returned ${response.status}.` : result.error,
      );
    }
    this.requireCurrentSession(session);
    return result;
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
