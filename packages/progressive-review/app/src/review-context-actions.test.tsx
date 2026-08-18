// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ReviewCommentThreadMap, ThreadTarget } from "../../src/types";
import { ReviewSessionProvider } from "./host/review-session";
import {
  ReviewProvider,
  openThreadsWithDraftCleanup,
  useReview,
} from "./review-context";
import { testReviewSession } from "./review-session-test-utils";

const roots: Array<ReturnType<typeof createRoot>> = [];
let review: ReturnType<typeof useReview> | null = null;
let secondaryReview: ReturnType<typeof useReview> | null = null;
const session = testReviewSession({
  serverUrl: "http://localhost:3000",
  sessionUrl: "http://localhost:3000",
  routePath: "/",
});

const target: ThreadTarget = { kind: "document" };

function CaptureReview() {
  review = useReview();
  return null;
}

function CaptureSecondaryReview() {
  secondaryReview = useReview();
  return null;
}

describe("ReviewProvider comment message deletion", () => {
  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    review = null;
    secondaryReview = null;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await act(async () => {
      for (const root of roots.splice(0)) root.unmount();
    });
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("removes exact local messages and drops the last-message thread", async () => {
    const fetchMock = stubReviewFetch({});
    await renderProvider();
    const context = requireReview();

    await act(async () => {
      await context.saveComment({
        threadId: "local-thread",
        messageId: "local-1",
        target,
        body: "one",
      });
      await context.saveComment({
        threadId: "local-thread",
        messageId: "local-2",
        target,
        body: "two",
      });
    });

    await act(async () => {
      await requireReview().deleteCommentMessage("local-thread", "local-1");
    });
    expect(
      requireReview()
        .allCommentThreads()[0]
        ?.messages.map((message) => message.id),
    ).toEqual(["local-2"]);

    await act(async () => {
      await requireReview().deleteCommentMessage("local-thread", "local-2");
    });
    expect(requireReview().allCommentThreads()).toEqual([]);
    expect(requireReview().pendingCommentCount).toBe(0);
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          init?.method === "DELETE" && String(input).includes("/messages/"),
      ),
    ).toBe(false);
  });

  it("dismisses a global comment draft when opening Threads", async () => {
    stubReviewFetch({});
    await renderProvider();

    await act(async () => {
      requireReview().openCommentDraft({ target, body: "" });
    });
    expect(requireReview().draftTarget?.target).toEqual(target);

    const openThreads = vi.fn<() => void>();
    await act(async () => {
      const context = requireReview();
      openThreadsWithDraftCleanup({
        draftTarget: context.draftTarget,
        closeCommentDraft: context.closeCommentDraft,
        openThreads,
      });
    });

    expect(openThreads).toHaveBeenCalledOnce();
    expect(requireReview().draftTarget).toBeNull();
  });

  it("opens a comment draft when crypto.randomUUID is unavailable", async () => {
    let seed = 0;
    vi.stubGlobal("crypto", {
      getRandomValues: <T extends ArrayBufferView | null>(array: T): T => {
        if (array instanceof Uint8Array) {
          array.fill(seed);
          seed += 1;
        }
        return array;
      },
    });
    stubReviewFetch({});
    await renderProvider();

    await act(async () => {
      requireReview().openCommentDraft({ target, body: "" });
    });

    expect(requireReview().draftTarget).toMatchObject({
      threadId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      messageId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    });
    expect(requireReview().draftTarget?.threadId).not.toBe(
      requireReview().draftTarget?.messageId,
    );
  });

  it("loads a terminal outcome through the canvas bridge", async () => {
    vi.stubGlobal("fetch", undefined);
    const statusSession = testReviewSession(
      {},
      {
        request: async () =>
          new Response(
            JSON.stringify({ session: { reviewStatus: "accepted" } }),
            { headers: { "content-type": "application/json" } },
          ),
      },
    );

    await renderProvider(statusSession);

    expect(requireReview().submissionOutcome).toBe("approved");
  });

  it("shares pending comments across providers in one Review session", async () => {
    stubReviewFetch({});
    await renderProvider();
    const secondaryRoot = await renderSecondaryProvider();

    await act(async () => {
      await requireReview().saveComment({
        threadId: "draft-thread",
        messageId: "draft-message",
        target,
        body: "Share this in the session",
      });
    });

    expect(secondaryReview?.allCommentThreads()).toMatchObject([
      { threadId: "draft-thread" },
    ]);

    await act(async () => secondaryRoot.unmount());
    roots.splice(roots.indexOf(secondaryRoot), 1);
    secondaryReview = null;
  });
});

function stubReviewFetch(
  comments: ReviewCommentThreadMap,
  mutationStatus = 200,
) {
  const fetchMock = vi.fn<typeof fetch>(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (init?.method === "DELETE" && url.includes("/messages/")) {
        return new Response(
          mutationStatus === 200 ? undefined : "delete failed",
          {
            status: mutationStatus,
          },
        );
      }
      if (init?.method === "PATCH" && url.includes("/comments/")) {
        return new Response(
          mutationStatus === 200 ? undefined : "update failed",
          { status: mutationStatus },
        );
      }
      if (url.includes("/__progressive-review/comments")) {
        return new Response(JSON.stringify({ comments }), {
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

async function renderProvider(reviewSession = session) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <ReviewSessionProvider session={reviewSession}>
        <ReviewProvider>
          <CaptureReview />
        </ReviewProvider>
      </ReviewSessionProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderSecondaryProvider() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(
      <ReviewSessionProvider session={session}>
        <ReviewProvider>
          <CaptureSecondaryReview />
        </ReviewProvider>
      </ReviewSessionProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  return root;
}

function requireReview(): ReturnType<typeof useReview> {
  if (!review) throw new Error("Review context was not captured");
  return review;
}
