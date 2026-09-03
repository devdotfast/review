// @vitest-environment jsdom
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReviewSessionProvider } from "./host/review-session";
import { ReviewProvider, useReview, useReviewActions } from "./review-context";
import { testReviewSession } from "./review-session-test-utils";

let root: Root | null = null;
let actionsRenders = 0;
let stateRenders = 0;
let latestActions: ReturnType<typeof useReviewActions> | null = null;
let latestReview: ReturnType<typeof useReview> | null = null;

function ActionsOnly() {
  actionsRenders += 1;
  latestActions = useReviewActions();
  return null;
}

function StateReader() {
  stateRenders += 1;
  latestReview = useReview();
  return null;
}

function stubReviewFetch() {
  const fetchMock = vi.fn<typeof fetch>(
    async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes("/__progressive-review/comments")) {
        return new Response(JSON.stringify({ comments: {} }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({}), {
        headers: { "content-type": "application/json" },
      });
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  actionsRenders = 0;
  stateRenders = 0;
  latestActions = null;
  latestReview = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ReviewProvider render isolation", () => {
  it("does not re-render actions-only consumers on draft, focus, or thread changes", async () => {
    stubReviewFetch();
    const session = testReviewSession();
    const container = document.createElement("div");
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <ReviewSessionProvider session={session}>
          <ReviewProvider>
            <ActionsOnly />
            <StateReader />
          </ReviewProvider>
        </ReviewSessionProvider>,
      );
    });
    expect(actionsRenders).toBe(1);
    const initialStateRenders = stateRenders;

    await act(async () => {
      latestActions!.openCommentDraft({
        target: { kind: "document" },
        body: "",
      });
    });
    await act(async () => {
      latestActions!.closeCommentDraft();
    });
    await act(async () => {
      latestActions!.focusThread("thread-1");
    });
    await act(async () => {
      latestActions!.blurThread();
    });
    await act(async () => {
      await latestActions!.saveComment({
        threadId: "thread-1",
        messageId: "message-1",
        body: "hello",
        target: { kind: "document" },
      });
    });

    expect(stateRenders).toBeGreaterThan(initialStateRenders);
    expect(latestReview!.allCommentThreads()).toHaveLength(1);
    expect(actionsRenders).toBe(1);
  });
});
