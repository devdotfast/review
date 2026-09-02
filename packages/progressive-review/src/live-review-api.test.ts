import path from "node:path";

import {
  REVIEW_DESKTOP_DISCOVERY_VERSION,
  type ReviewDesktopDiscovery,
} from "@dev.fast/review-protocol";
import { describe, expect, it, vi } from "vitest";

import {
  createReviewApi,
  LiveReviewDesktopRequestError,
} from "./live-review-api";
import type { BasicInfo } from "./live-review-types";

const discovery: ReviewDesktopDiscovery = {
  version: REVIEW_DESKTOP_DISCOVERY_VERSION,
  instanceId: "live-review-desktop",
  url: "http://127.0.0.1:4567",
  appPid: 100,
  serverPid: 101,
  token: "live-review-secret",
  startedAt: 1,
};

describe("live Review API transport", () => {
  it("is a thin authenticated client with stable default Review state", async () => {
    const requests: Request[] = [];
    const info = fixtureInfo();
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const url = new URL(request.url);
      if (url.pathname === "/health") return healthResponse();
      expect(request.headers.get("x-review-token")).toBe(discovery.token);
      if (url.pathname === "/live-reviews" && request.method === "POST") {
        expect(await request.json()).toEqual({
          cwd: path.resolve("/repo"),
          source: { kind: "current-checkout" },
          title: "Transport tracer",
        });
        return json({ sessionId: "session-1", info }, 201);
      }
      if (url.pathname.endsWith("/render")) {
        return json({
          ok: true,
          reviewId: info.reviewId,
          targetNodeId: "root",
          nodeId: "child",
          version: 1,
        });
      }
      if (url.pathname.endsWith("/nodes/root/children")) {
        return json({
          children: [
            {
              id: "child",
              parentId: "root",
              title: "Child",
              source: "Body",
              childIds: [],
            },
          ],
        });
      }
      if (url.pathname.endsWith("/selection")) {
        return json({ reviewId: info.reviewId, nodeIds: [] });
      }
      if (url.pathname.endsWith("/status")) {
        return json({ ...info, status: "awaiting-review" });
      }
      if (url.pathname === `/live-reviews/${info.reviewId}`) {
        return json(info);
      }
      throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
    });
    const launchDesktop = vi.fn(async () => ({
      event: "app" as const,
      action: "launch" as const,
      state: "running" as const,
      instanceId: discovery.instanceId,
    }));
    const api = createReviewApi(
      { cwd: "/repo" },
      {
        fetch,
        readDiscovery: async () => discovery,
        launchDesktop,
      },
    );

    await expect(api.getBasicInfo()).rejects.toThrow(
      "reviewId is required until a Review has been opened",
    );
    await expect(
      api.createReview({
        source: { kind: "current-checkout" },
        title: "Transport tracer",
      }),
    ).resolves.toEqual(info);
    await expect(
      api.renderMdx({
        targetNodeId: "root",
        mode: "append",
        title: "Child",
        mdx: "Body",
      }),
    ).resolves.toMatchObject({ ok: true, version: 1 });
    await expect(api.getChildren({ nodeId: "root" })).resolves.toEqual([
      expect.objectContaining({ id: "child", parentId: "root" }),
    ]);
    await expect(api.getSelection()).resolves.toEqual({
      reviewId: info.reviewId,
      nodeIds: [],
    });
    await expect(
      api.setReviewStatus({ status: "awaiting-review" }),
    ).resolves.toMatchObject({ status: "awaiting-review" });
    await expect(api.getBasicInfo()).resolves.toEqual(info);
    expect(launchDesktop).not.toHaveBeenCalled();
    expect(
      requests.filter((request) => new URL(request.url).pathname !== "/health"),
    ).toHaveLength(6);
  });

  it("launches once when Desktop is absent, then uses the discovered token", async () => {
    const readDiscovery = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(discovery);
    const launchDesktop = vi.fn(async () => ({
      event: "app" as const,
      action: "launch" as const,
      state: "launched" as const,
      instanceId: discovery.instanceId,
    }));
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === "/health") return healthResponse();
      expect(request.headers.get("x-review-token")).toBe(discovery.token);
      return json({ reviews: [] });
    });
    const api = createReviewApi(
      { cwd: "/repo" },
      { readDiscovery, launchDesktop, fetch },
    );

    await expect(api.listReviews()).resolves.toEqual([]);
    expect(launchDesktop).toHaveBeenCalledOnce();
  });

  it("returns validation diagnostics from 422 and exposes transport failures", async () => {
    let endpointStatus = 422;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const request = new Request(input, init);
      const pathname = new URL(request.url).pathname;
      if (pathname === "/health") return healthResponse();
      if (pathname.endsWith("/open")) {
        return json({ sessionId: "session-1", info: fixtureInfo() }, 200);
      }
      if (endpointStatus === 422) {
        return json(
          {
            ok: false,
            reviewId: fixtureInfo().reviewId,
            targetNodeId: "root",
            diagnostics: [{ path: "root", message: "Unknown component" }],
          },
          422,
        );
      }
      return json(
        { ok: false, code: "review_version_conflict", error: "Retry render." },
        endpointStatus,
      );
    });
    const api = createReviewApi(
      { cwd: "/repo" },
      { readDiscovery: async () => discovery, fetch },
    );
    await api.openReview({ reviewId: fixtureInfo().reviewId });

    await expect(
      api.renderMdx({ targetNodeId: "root", mode: "replace", mdx: "<Bad />" }),
    ).resolves.toEqual({
      ok: false,
      reviewId: fixtureInfo().reviewId,
      targetNodeId: "root",
      diagnostics: [{ path: "root", message: "Unknown component" }],
    });

    endpointStatus = 409;
    const conflict = await api
      .renderMdx({ targetNodeId: "root", mode: "replace", mdx: "Body" })
      .catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(LiveReviewDesktopRequestError);
    expect(conflict).toMatchObject({
      status: 409,
      code: "review_version_conflict",
      message: "Retry render.",
    });
  });

  it("rejects unauthorized and malformed successful responses", async () => {
    let malformed = false;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/health") return healthResponse();
      return malformed
        ? json({ reviews: [{ id: "incomplete" }] })
        : json({ ok: false, code: "unauthorized", error: "Unauthorized" }, 401);
    });
    const api = createReviewApi(
      { cwd: "/repo" },
      { readDiscovery: async () => discovery, fetch },
    );

    await expect(api.listReviews()).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
      message: "Unauthorized",
    });
    malformed = true;
    await expect(api.listReviews()).rejects.toThrow();
  });
});

function fixtureInfo(): BasicInfo {
  return {
    reviewId: "11111111-1111-4111-8111-111111111111",
    title: "Transport tracer",
    status: "awaiting-agent",
    rootNodeId: "root",
    nodeCount: 1,
    binding: {
      kind: "current-checkout",
      worktreePath: path.resolve("/repo"),
      baseCommit: "a".repeat(40),
      sourceCommit: "a".repeat(40),
    },
  };
}

function healthResponse(): Response {
  return json({
    ok: true,
    instanceId: discovery.instanceId,
    desktopAttached: true,
  });
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}
