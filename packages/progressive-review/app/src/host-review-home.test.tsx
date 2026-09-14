// @vitest-environment jsdom
import {
  type HostCommandResults,
  HostCommandSchema,
  type HostDocumentState,
  type HostQueryResults,
  HostQuerySchema,
  type HostReviewState,
  type HostReviewVersionHeader,
  ReviewClient,
} from "@dev.fast/review-protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { HostReviewHome, hostReviewDescriptor } from "./host-review-home";

const id = "ba495aec-b73c-47f4-ab4d-8a5f05320d01";
const at = "2026-09-10T00:00:00Z";
const binding: HostDocumentState["binding"] = {
  id,
  repositoryId: id,
  selector: { kind: "branch", name: "feature/api", baseRef: "main" },
  baseCommit: "a".repeat(40),
  headCommit: "b".repeat(40),
  createdAt: at,
};
const record: HostReviewState = {
  id,
  repositoryId: id,
  stateVersion: 0,
  state: "open",
  latestReviewVersion: 0,
  createdBy: id,
  createdAt: at,
  deletedAt: null,
};
const snapshot: HostReviewVersionHeader = {
  reviewId: id,
  reviewVersion: 0,
  title: "API ownership",
  description: "",
  labels: [],
  binding,
  mapVersions: { base: null, head: null },
  createdBy: id,
  createdAt: at,
  restoredFromReviewVersion: null,
};

it("preserves the original Home status and attention data without exposing a local path", () => {
  expect(
    hostReviewDescriptor(
      { review: record, snapshot },
      { id, displayName: "review", vcs: "git" },
      {
        reviewId: id,
        principalId: id,
        attentionVersion: 1,
        lastViewedReviewVersion: 0,
        lastViewedAt: at,
        pinned: false,
      },
    ),
  ).toMatchObject({
    title: "API ownership",
    sourceBranch: "feature/api",
    status: "awaiting-review",
    viewedAt: at,
    dismissedAt: null,
  });
  expect(
    hostReviewDescriptor(
      { review: { ...record, deletedAt: at }, snapshot },
      undefined,
    ),
  ).toMatchObject({ dismissedAt: at, reapsAt: null, available: false });
});

it("uses the existing searchable cards and restores a dismissed review through the API", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  let review = { ...record };
  const document: HostDocumentState = {
    schemaVersion: 1,
    reviewId: id,
    reviewVersion: 0,
    roots: [],
    nodes: {},
    definitions: {},
    evidence: {},
    binding,
    createdAt: at,
    contentHash: "c".repeat(64),
  };
  const client = await ReviewClient.connect({
    serverUrl: "http://127.0.0.1:5500",
    token: "test",
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/connection"))
        return Response.json({
          ok: true,
          data: {
            apiVersion: 1,
            hostId: id,
            workspaceId: id,
            principal: { id, kind: "human", displayName: "You" },
          },
        });
      if (url.pathname.endsWith("/events"))
        return new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener(
                "abort",
                () => controller.close(),
                { once: true },
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      const command = url.pathname.endsWith("/commands");
      const envelope = {
        ...JSON.parse(String(init?.body)),
        apiVersion: 1,
        hostId: id,
        workspaceId: id,
        clientId: id,
      };
      const request = command
        ? HostCommandSchema.parse(envelope)
        : HostQuerySchema.parse(envelope);
      let result:
        | HostQueryResults[
            | "reviews.list"
            | "repositories.list"
            | "document.get"
            | "attention.get"]
        | HostCommandResults["review.trash" | "review.untrash"];
      switch (request.type) {
        case "reviews.list":
          result = { items: [{ review, snapshot }], nextCursor: null };
          break;
        case "repositories.list":
          result = {
            items: [{ id, vcs: "git", displayName: "review" }],
            nextCursor: null,
          };
          break;
        case "document.get":
          result = document;
          break;
        case "attention.get":
          result = {
            reviewId: id,
            principalId: id,
            attentionVersion: 0,
            lastViewedReviewVersion: null,
            lastViewedAt: null,
            pinned: false,
          };
          break;
        case "review.trash":
        case "review.untrash":
          if (request.input.expectedStateVersion !== review.stateVersion)
            throw new Error("Stale metadata version");
          review = {
            ...review,
            stateVersion: review.stateVersion + 1,
            deletedAt: request.type === "review.trash" ? at : null,
          };
          result = review;
          break;
        default:
          throw new Error(`Unexpected request: ${request.type}`);
      }
      if ("commandId" in request)
        return Response.json({
          ok: true,
          data: { commandId: request.commandId, result, eventCursor: "0" },
        });
      return Response.json({
        ok: true,
        data: {
          result,
          eventCursor: "0",
        },
      });
    },
  });
  const container = window.document.createElement("div");
  window.document.body.append(container);
  const root = createRoot(container);
  const open = vi.fn<(reviewId: string, title?: string) => void>();
  const openTabs = new Set([id]);
  const closeReview = async (reviewId: string) => {
    if (!review.deletedAt) throw new Error("Review is not dismissed yet");
    openTabs.delete(reviewId);
  };
  const button = (label: string) =>
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (item) =>
        item.textContent?.trim() === label ||
        item.getAttribute("aria-label") === label,
    );
  try {
    await act(async () =>
      root.render(
        <HostReviewHome
          client={client}
          content={{
            kind: "host",
            connection: { serverUrl: "http://127.0.0.1:5500", token: "test" },
            openReview: open,
            closeReview,
            showHome() {},
          }}
        />,
      ),
    );
    expect(
      container.querySelector(".review-home[data-view=cards]"),
    ).not.toBeNull();
    expect(container.querySelector('input[type="search"]')).not.toBeNull();
    expect(container.textContent).toContain("API ownership");
    const dismiss = container.querySelector<HTMLButtonElement>(
      '[title="Dismiss review"]',
    );
    expect(dismiss).not.toBeNull();
    await act(async () => dismiss?.click());
    expect(review.deletedAt).toBe(at);
    expect(openTabs.has(id)).toBe(false);
    const dismissed = [
      ...container.querySelectorAll<HTMLButtonElement>("button"),
    ].find((item) => item.textContent?.includes("Dismissed"));
    await act(async () => dismissed?.click());
    await act(async () => button("Undo")?.click());
    expect(review.deletedAt).toBeNull();
    expect(container.textContent).toContain("API ownership");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
