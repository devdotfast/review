import { describe, expect, it } from "vitest";

import {
  type ThreadView,
  targetQuote,
  threadListStatus,
} from "./review-threads";

describe("targetQuote", () => {
  it("labels document targets", () => {
    expect(targetQuote({ kind: "document" })).toBe("Entire document");
  });
});

describe("threadListStatus", () => {
  const comment: ThreadView = {
    key: "thread-1",
    threadId: "thread-1",
    target: { kind: "document" },
    quote: "Entire document",
    resolved: false,
    clientStatus: "persisted",
    messages: [
      {
        id: "message-1",
        by: "You",
        at: "2026-08-03T00:00:00.000Z",
        body: "Persisted comment",
        userAuthored: true,
      },
    ],
    latestAt: "2026-08-03T00:00:00.000Z",
  };

  it("distinguishes persisted comments from local drafts", () => {
    expect(threadListStatus(comment)).toBe("open");
    expect(threadListStatus({ ...comment, clientStatus: "draft" })).toBe(
      "pending",
    );
  });
});
