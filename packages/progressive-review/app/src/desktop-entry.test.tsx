// @vitest-environment jsdom

import type {
  ReviewCanvasContent,
  ReviewCanvasDiagnostic,
} from "@dev.fast/review-protocol";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { softwareModelData } from "../../src/software-map-model";
import { mountReviewCanvas } from "./desktop-entry";
import { testReviewBridge } from "./review-session-test-utils";
import { defineSoftwareModel } from "./software-map/model";

beforeEach(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn<() => void>(),
  });
});

afterEach(() => {
  document.body.replaceChildren();
  Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("desktop review document load states", () => {
  it("opens the current review from expected historical unavailability without diagnostics", async () => {
    const post = vi.fn<() => Promise<{ ok: true }>>(async () => ({ ok: true }));
    const reportDiagnostic =
      vi.fn<(diagnostic: ReviewCanvasDiagnostic) => void>();
    const bridge = testReviewBridge(
      { sessionId: "old-history" },
      {
        request: requestStub,
        post,
        reportDiagnostic,
        diffView: { create: createDiffView },
      },
    );
    const reviewUuid = "11111111-1111-4111-8111-111111111111";
    const container = document.createElement("div");
    document.body.append(container);
    let handle: ReturnType<typeof mountReviewCanvas> | undefined;
    await act(async () => {
      handle = mountReviewCanvas(
        container,
        sessionContent(bridge, {
          document: Promise.resolve({
            state: "unavailable",
            message:
              "This older revision is unavailable in this version of Review",
            currentReviewUuid: reviewUuid,
          }),
          softwareMap: Promise.resolve(null),
        }),
      );
    });
    expect(container.textContent).toContain(
      "This older revision is unavailable in this version of Review",
    );
    expect(container.textContent).not.toContain("review publish");
    const button = [...container.querySelectorAll("button")].find(
      (node) => node.textContent === "Open current review",
    );
    await act(async () => button!.click());
    expect(post).toHaveBeenCalledWith({
      name: "openReview",
      args: { reviewUuid, active: true },
    });
    expect(reportDiagnostic).not.toHaveBeenCalled();
    await act(async () => handle?.dispose());
  });
  it("hoists the authored heading, collapses its body, and discovers database use cases", async () => {
    const bridge = testReviewBridge(
      { sessionId: "rendered-data-behavior" },
      { request: requestStub, diffView: { create: createDiffView } },
    );
    const content = sessionContent(bridge, {
      document: Promise.resolve({
        state: "ready",
        contentHash: "rendered-data-behavior",
        data: {
          format: "review-document/1",
          title: "Data review",
          routePath: "/",
          sourcePath: "review.mdx",
          anchors: {},
          anchorContents: {},
          softwareModels: [],
          body: [
            {
              type: "component",
              name: "ReviewSection",
              props: { title: "Orders" },
              children: [
                {
                  type: "element",
                  tag: "h2",
                  props: { id: "authored-heading" },
                  children: [{ type: "text", value: "Orders" }],
                },
                {
                  type: "element",
                  tag: "p",
                  props: {},
                  children: [{ type: "text", value: "Order details" }],
                },
                {
                  type: "component",
                  name: "DatabaseLens",
                  props: { stores: {}, title: "Order database" },
                  children: [
                    {
                      type: "component",
                      name: "DbUseCase",
                      props: { id: "create", label: "Create an order" },
                      children: [{ type: "text", value: "Create order" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      }),
      softwareMap: Promise.resolve(null),
    });
    const container = document.createElement("div");
    document.body.append(container);
    let handle: ReturnType<typeof mountReviewCanvas> | undefined;
    try {
      await act(async () => {
        handle = mountReviewCanvas(container, content);
      });
      await vi.waitFor(() => {
        expect(container.textContent).toContain("Create an order");
        expect(
          container.querySelector(".database-lens")?.textContent,
        ).toContain("Create an order");
      });
      const heading = container.querySelector(".review-section-heading > h2");
      expect(heading?.id).toBe("authored-heading");
      expect(container.querySelectorAll("#authored-heading")).toHaveLength(1);
      const body = container.querySelector<HTMLElement>(
        ".review-section-body",
      )!;
      expect(body.querySelector("h2")).toBeNull();
      expect(body.hidden).toBe(false);
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            'button[aria-label="Collapse Orders"]',
          )!
          .click();
      });
      expect(body.hidden).toBe(true);
      expect(heading?.textContent).toBe("Orders");
    } finally {
      await act(async () => handle?.dispose());
    }
  });

  it("keeps the app shell and valid map after document failure, settling ready before diagnostics", async () => {
    const order: string[] = [];
    const model = softwareModelData(
      defineSoftwareModel({ systems: { orders: { label: "Orders map" } } }),
    );
    const bridge = testReviewBridge(
      { sessionId: "unavailable-document" },
      {
        request: requestStub,
        ready: () => order.push("ready"),
        reportDiagnostic: () => order.push("diagnostic"),
        diffView: { create: createDiffView },
      },
    );
    const content = sessionContent(bridge, {
      document: Promise.resolve({
        state: "unavailable",
        message: "Document fetch failed",
      }),
      softwareMap: Promise.resolve({
        state: "ready",
        contentHash: "map-hash",
        head: model,
        base: model,
      }),
    });
    const container = document.createElement("div");
    document.body.append(container);

    let handle: ReturnType<typeof mountReviewCanvas> | undefined;
    await act(async () => {
      handle = mountReviewCanvas(container, content);
    });
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Review unavailable");
    });

    expect(container.textContent).toContain("Review");
    expect(container.textContent).toContain("Commits");
    expect(container.textContent).toContain("Diff");
    expect(container.textContent).toContain("Map");
    expect(container.textContent).toContain("Threads");
    expect(order.slice(0, 2)).toEqual(["ready", "diagnostic"]);

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Map (Experimental)"]',
        )!
        .click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Orders map");
    await act(async () => handle?.dispose());
  });

  it.each([
    { mapStale: false, recovery: false },
    { mapStale: true, recovery: false },
    { mapStale: false, recovery: true },
    { mapStale: true, recovery: true },
  ])(
    "signals ready for needs-republish without reporting an error (%j)",
    async ({ mapStale, recovery }) => {
      const ready = vi.fn<() => void>();
      const reportDiagnostic =
        vi.fn<(diagnostic: ReviewCanvasDiagnostic) => void>();
      const bridge = testReviewBridge(
        { sessionId: `needs-republish-${mapStale}` },
        {
          request: requestStub,
          ready,
          reportDiagnostic,
          diffView: { create: createDiffView },
        },
      );
      const content = sessionContent(bridge, {
        document: Promise.resolve({
          state: "needs-republish",
          reviewUuid: "11111111-1111-4111-8111-111111111111",
          mapStale,
          recovery,
        }),
        softwareMap: Promise.resolve(
          mapStale
            ? {
                state: "needs-republish",
                reviewUuid: "11111111-1111-4111-8111-111111111111",
                recovery,
              }
            : null,
        ),
      });
      const container = document.createElement("div");
      document.body.append(container);

      let handle: ReturnType<typeof mountReviewCanvas> | undefined;
      await act(async () => {
        handle = mountReviewCanvas(container, content);
      });
      await vi.waitFor(() => {
        expect(container.textContent).toContain(
          recovery ? "Review recovery" : "Republish this review",
        );
      });

      expect(ready).toHaveBeenCalledTimes(1);
      expect(reportDiagnostic).not.toHaveBeenCalled();
      expect(container.textContent).toContain("Threads");
      expect(container.textContent).toContain("Commits");
      expect(container.textContent).toContain("Diff");
      expect(container.querySelectorAll(".review-republish code")).toHaveLength(
        recovery ? 0 : mapStale ? 2 : 1,
      );
      expect(container.querySelector(".review-republish h2")?.textContent).toBe(
        recovery ? "Review recovery" : "Republish this review",
      );
      expect(
        container.querySelector('button[aria-label="Copy command"]') !== null,
      ).toBe(!recovery);
      expect(
        container.querySelector('button[aria-label="Copy prompt"]') !== null,
      ).toBe(!recovery);
      if (mapStale && recovery) {
        await act(async () =>
          container
            .querySelector<HTMLButtonElement>(
              'button[aria-label="Map (Experimental)"]',
            )!
            .click(),
        );
      }
      expect(
        container
          .querySelector(".review-map-view")
          ?.textContent?.includes("Review recovery") ?? false,
      ).toBe(mapStale && recovery);
      expect(
        container.querySelector(".review-map-view")?.textContent ?? "",
      ).not.toContain("review publish");
      await act(async () => handle?.dispose());
    },
  );
});

function sessionContent(
  bridge: Extract<ReviewCanvasContent, { kind: "session" }>["bridge"],
  loads: Pick<
    Extract<ReviewCanvasContent, { kind: "session" }>,
    "document" | "softwareMap"
  >,
): Extract<ReviewCanvasContent, { kind: "session" }> {
  return {
    kind: "session",
    bridge,
    ...loads,
    softwareMapEnabled: true,
    reviewErrors: [],
    range: {
      baseRef: "main",
      headRef: "feature",
      baseCommit: "a".repeat(40),
      headCommit: "b".repeat(40),
    },
    commits: [
      {
        commit: "b".repeat(40),
        parentCommit: "a".repeat(40),
        subject: "Change",
        author: "Reviewer",
        authoredAt: "2026-09-04T00:00:00.000Z",
        fileCount: 1,
        additions: 1,
        deletions: 0,
      },
    ],
  };
}

async function requestStub(input: string): Promise<Response> {
  if (input.includes("/agent-traces")) {
    return new Response(JSON.stringify({ ok: true, sessions: [] }));
  }
  if (input.includes("/session")) {
    return new Response(JSON.stringify({ session: {} }));
  }
  return new Response(JSON.stringify({}));
}

function createDiffView() {
  return {
    focus() {},
    dispose() {},
    onDidError() {
      return { dispose() {} };
    },
  };
}
