import path from "node:path";

import type { ReviewDesktopDiscovery } from "@dev.fast/review-protocol";

import {
  readHealthyReviewDesktopDiscovery,
  type ReviewDesktopHealthDependencies,
} from "./desktop-discovery";
import {
  parseLiveReviewBasicInfo,
  parseLiveReviewBootstrapResponse,
  parseLiveReviewChildren,
  parseLiveReviewListResponse,
  parseLiveReviewNode,
  parseLiveReviewRenderResult,
  parseLiveReviewSelection,
} from "./live-review-transport";
import type { RenderResult, ReviewAPI } from "./live-review-types";
import { runReviewAppLaunch } from "./review-app-launcher";
export type {
  BasicInfo,
  LiveReviewStatus,
  Node,
  RenderResult,
  ReviewAPI,
  ReviewBinding,
  ReviewSummary,
  Selection,
} from "./live-review-types";

interface LiveReviewApiDependencies extends ReviewDesktopHealthDependencies {
  launchDesktop?: typeof runReviewAppLaunch;
}

export class LiveReviewDesktopRequestError extends Error {
  override readonly name = "LiveReviewDesktopRequestError";

  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly payload?: unknown,
  ) {
    super(message);
  }
}

export function createReviewApi(
  input: { cwd: string },
  dependencies: LiveReviewApiDependencies = {},
): ReviewAPI {
  const cwd = path.resolve(input.cwd);
  const fetch = dependencies.fetch ?? globalThis.fetch;
  let defaultReviewId: string | undefined;
  let connecting: Promise<ReviewDesktopDiscovery> | undefined;

  const connect = (): Promise<ReviewDesktopDiscovery> => {
    if (connecting) return connecting;
    connecting = (async () => {
      let discovery = await readHealthyReviewDesktopDiscovery(dependencies);
      if (!discovery) {
        await (dependencies.launchDesktop ?? runReviewAppLaunch)();
        discovery = await readHealthyReviewDesktopDiscovery(dependencies);
      }
      if (!discovery) throw new Error("Review Desktop is not ready.");
      return discovery;
    })().finally(() => {
      connecting = undefined;
    });
    return connecting;
  };

  const request = async (
    route: string,
    options: { method?: "GET" | "POST"; body?: unknown } = {},
  ): Promise<unknown> => {
    const discovery = await connect();
    const response = await fetch(`${discovery.url}${route}`, {
      method: options.method ?? "GET",
      headers: {
        "x-review-token": discovery.token,
        ...(options.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error =
        payload &&
        typeof payload === "object" &&
        !Array.isArray(payload) &&
        typeof (payload as { error?: unknown }).error === "string"
          ? (payload as { error: string }).error
          : `Review Desktop returned ${response.status}.`;
      const code =
        payload &&
        typeof payload === "object" &&
        !Array.isArray(payload) &&
        typeof (payload as { code?: unknown }).code === "string"
          ? (payload as { code: string }).code
          : undefined;
      throw new LiveReviewDesktopRequestError(
        error,
        response.status,
        code,
        payload,
      );
    }
    return payload;
  };

  const reviewId = (explicit?: string): string => {
    const resolved = explicit ?? defaultReviewId;
    if (!resolved) {
      throw new Error("reviewId is required until a Review has been opened.");
    }
    return resolved;
  };

  return {
    async listReviews(listInput = {}) {
      const query = new URLSearchParams({ cwd });
      if (listInput.scope) query.set("scope", listInput.scope);
      return parseLiveReviewListResponse(
        await request(`/live-reviews?${query}`),
      );
    },

    async createReview(createInput) {
      const info = parseLiveReviewBootstrapResponse(
        await request("/live-reviews", {
          method: "POST",
          body: {
            requestId: createInput.requestId,
            cwd,
            source: createInput.source,
            title: createInput.title,
          },
        }),
      );
      defaultReviewId = info.reviewId;
      return info;
    },

    async openReview({ reviewId: requestedId }) {
      const info = parseLiveReviewBootstrapResponse(
        await request(`/live-reviews/${encodeURIComponent(requestedId)}/open`, {
          method: "POST",
        }),
      );
      defaultReviewId = info.reviewId;
      return info;
    },

    async getBasicInfo(infoInput = {}) {
      const id = reviewId(infoInput.reviewId);
      return parseLiveReviewBasicInfo(
        await request(`/live-reviews/${encodeURIComponent(id)}`),
      );
    },

    async getSelection(selectionInput = {}) {
      const id = reviewId(selectionInput.reviewId);
      return parseLiveReviewSelection(
        await request(`/live-reviews/${encodeURIComponent(id)}/selection`),
      );
    },

    async getNodeInfo({ reviewId: explicitId, nodeId }) {
      const id = reviewId(explicitId);
      return parseLiveReviewNode(
        await request(
          `/live-reviews/${encodeURIComponent(id)}/nodes/${encodeURIComponent(nodeId)}`,
        ),
      );
    },

    async getChildren({ reviewId: explicitId, nodeId }) {
      const id = reviewId(explicitId);
      return parseLiveReviewChildren(
        await request(
          `/live-reviews/${encodeURIComponent(id)}/nodes/${encodeURIComponent(nodeId)}/children`,
        ),
      );
    },

    async renderMdx(renderInput): Promise<RenderResult> {
      const id = reviewId(renderInput.reviewId);
      try {
        return parseLiveReviewRenderResult(
          await request(`/live-reviews/${encodeURIComponent(id)}/render`, {
            method: "POST",
            body: {
              requestId: renderInput.requestId,
              targetNodeId: renderInput.targetNodeId,
              mode: renderInput.mode,
              ...(renderInput.title === undefined
                ? {}
                : { title: renderInput.title }),
              mdx: renderInput.mdx,
            },
          }),
        );
      } catch (error) {
        if (
          error instanceof LiveReviewDesktopRequestError &&
          error.status === 422
        ) {
          return parseLiveReviewRenderResult(error.payload);
        }
        throw error;
      }
    },

    async setReviewStatus(statusInput) {
      const id = reviewId(statusInput.reviewId);
      return parseLiveReviewBasicInfo(
        await request(`/live-reviews/${encodeURIComponent(id)}/status`, {
          method: "POST",
          body: { status: statusInput.status },
        }),
      );
    },
  };
}
