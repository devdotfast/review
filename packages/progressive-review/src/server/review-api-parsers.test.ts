import { describe, expect, it } from "vitest";

import {
  parseReviewBugReportInput,
  parseReviewCommentMessagePath,
  parseReviewSubmissionInput,
  parseReviewTabTelemetryInput,
  parseSoftwareMapCodeElements,
  parseThreadTarget,
  parseUpdateReviewCommentInput,
} from "./review-api-parsers";

const selection = {
  start: 2,
  length: 5,
  hash: "f55c314b",
  quote: "Hello",
};

const bugReport = {
  description: "",
  include_review: true,
  include_map: true,
  include_diff: true,
  include_trace: false,
  app_session_id: "session-1234567890",
  app_version: "1.2.3",
};

describe("parseReviewBugReportInput", () => {
  it("accepts an empty description", () => {
    expect(parseReviewBugReportInput(bugReport).description).toBe("");
  });

  it("rejects a description over 64 KiB with 413", () => {
    expectBugReportStatus(
      { ...bugReport, description: "a".repeat(64 * 1024 + 1) },
      413,
    );
  });

  it("accepts a valid JPEG screenshot", () => {
    const screenshot = {
      mime: "image/jpeg" as const,
      base64: Buffer.from("jpeg bytes").toString("base64"),
    };
    expect(
      parseReviewBugReportInput({ ...bugReport, screenshot }),
    ).toMatchObject({ screenshot });
  });

  it("rejects a screenshot over 3 MiB with 413", () => {
    expectBugReportStatus(
      {
        ...bugReport,
        screenshot: {
          mime: "image/jpeg",
          base64: Buffer.alloc(3 * 1024 * 1024 + 1).toString("base64"),
        },
      },
      413,
    );
  });

  it("rejects a screenshot with the wrong mime", () => {
    expect(() =>
      parseReviewBugReportInput({
        ...bugReport,
        screenshot: { mime: "image/png", base64: "cG5n" },
      }),
    ).toThrow(/image\/jpeg|Invalid input/i);
  });

  it("rejects malformed screenshot base64", () => {
    expectBugReportStatus(
      {
        ...bugReport,
        screenshot: { mime: "image/jpeg", base64: "not base64" },
      },
      400,
    );
  });
});

function expectBugReportStatus(value: unknown, statusCode: number) {
  let thrown: unknown;
  try {
    parseReviewBugReportInput(value);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toMatchObject({ statusCode });
}

describe("parseThreadTarget", () => {
  it("round-trips document targets and rejects unknown kinds", () => {
    expect(
      parseThreadTarget(
        { kind: "document", surface: "ignored", selection: "ignored" },
        "target",
      ),
    ).toEqual({ kind: "document" });
    expect(() => parseThreadTarget({ kind: "garbage" }, "target")).toThrow(
      "target.kind must be document, code, text, or graph",
    );
  });

  it("validates every text surface", () => {
    expect(
      parseThreadTarget(
        {
          kind: "text",
          surface: { type: "document", documentHash: "12345678" },
          selection,
        },
        "target",
      ),
    ).toMatchObject({ surface: { type: "document" } });
    expect(() =>
      parseThreadTarget(
        {
          kind: "text",
          surface: { type: "document" },
          selection,
        },
        "target",
      ),
    ).toThrow("target.surface.documentHash must be a non-empty string");
    expect(
      parseThreadTarget(
        {
          kind: "text",
          surface: {
            type: "block",
            tag: "p",
            index: 3,
            blockHash: "12345678",
          },
          selection,
        },
        "target",
      ),
    ).toMatchObject({ surface: { type: "block", index: 3 } });
    expect(
      parseThreadTarget(
        {
          kind: "text",
          surface: { type: "table-cell", table: 1, row: 2, column: 3 },
          selection,
        },
        "target",
      ),
    ).toMatchObject({ surface: { type: "table-cell", row: 2 } });
    expect(
      parseThreadTarget(
        {
          kind: "text",
          surface: {
            type: "anchor",
            anchorId: "runtime",
            part: { type: "text", field: "detail" },
          },
          selection,
        },
        "target",
      ),
    ).toMatchObject({
      surface: { part: { type: "text", field: "detail" } },
    });
    expect(() =>
      parseThreadTarget(
        {
          kind: "text",
          surface: {
            type: "anchor",
            anchorId: "runtime",
            part: { type: "text" },
          },
          selection,
        },
        "target",
      ),
    ).toThrow("target.surface.part.field must be title or detail");
  });

  it("validates graph targets and rejects incomplete union members", () => {
    expect(
      parseThreadTarget(
        {
          kind: "graph",
          diagram: "Request flow",
          element: {
            type: "edge",
            path: ["Browser→Worker"],
            hash: "12345678",
            quote: "Resolve request",
          },
        },
        "target",
      ),
    ).toEqual({
      kind: "graph",
      diagram: "Request flow",
      element: {
        type: "edge",
        path: ["Browser→Worker"],
        hash: "12345678",
        quote: "Resolve request",
      },
    });
    expect(() =>
      parseThreadTarget(
        {
          kind: "text",
          surface: { type: "block", tag: "p", index: -1 },
          selection,
        },
        "target",
      ),
    ).toThrow("target.surface.index must be a non-negative integer");
    expect(() =>
      parseThreadTarget(
        {
          kind: "graph",
          diagram: "Request flow",
          element: { type: "edge", path: [], hash: "x", quote: "y" },
        },
        "target",
      ),
    ).toThrow("target.element.path must be a non-empty array");
  });
});

describe("structured review inputs", () => {
  const target = {
    kind: "text",
    surface: {
      type: "block",
      tag: "p",
      index: 0,
      blockHash: "12345678",
    },
    selection,
  };

  it("requires comment thread and message ids", () => {
    expect(
      parseReviewSubmissionInput({
        submissionId: "submission-1",
        decision: "request-changes",
        comments: [
          {
            threadId: "thread-1",
            messageId: "message-1",
            target,
            body: "Please clarify.",
          },
        ],
      }),
    ).toMatchObject({
      comments: [{ threadId: "thread-1", messageId: "message-1", target }],
    });
    expect(() =>
      parseReviewSubmissionInput({
        submissionId: "submission-1",
        decision: "request-changes",
        comments: [{ target, body: "Missing ids" }],
      }),
    ).toThrow("comments[0].threadId");
  });

  it("parses optional exact-message comment updates", () => {
    expect(
      parseUpdateReviewCommentInput({
        status: "open",
        body: "Edited",
        messageId: "message-1",
      }),
    ).toEqual({ status: "open", body: "Edited", messageId: "message-1" });
    expect(() => parseUpdateReviewCommentInput({ messageId: "" })).toThrow(
      "messageId must be a non-empty string",
    );
  });

  it("parses encoded comment-message route ids", () => {
    expect(
      parseReviewCommentMessagePath(
        "/__progressive-review/comments/thread%2F1/messages/message%2F1",
      ),
    ).toEqual({ threadId: "thread/1", messageId: "message/1" });
    expect(
      parseReviewCommentMessagePath(
        "/__progressive-review/comments/thread-1/messages",
      ),
    ).toBeNull();
  });
});

describe("parseSoftwareMapCodeElements", () => {
  it("preserves code element change status for diff-count mapping", () => {
    expect(
      parseSoftwareMapCodeElements([
        {
          path: "system.container.component.symbol",
          sourceRanges: [{ file: "src/example.ts", fromLine: 1, toLine: 1 }],
          changeStatus: "added",
        },
      ]),
    ).toEqual([
      {
        path: "system.container.component.symbol",
        sourceRanges: [{ file: "src/example.ts", fromLine: 1, toLine: 1 }],
        label: undefined,
        description: undefined,
        changeStatus: "added",
      },
    ]);
  });

  it("drops invalid change statuses", () => {
    expect(
      parseSoftwareMapCodeElements([
        {
          path: "system.container.component.symbol",
          sourceRanges: [{ file: "src/example.ts", fromLine: 1, toLine: 1 }],
          changeStatus: "mystery",
        },
      ])[0]?.changeStatus,
    ).toBeUndefined();
  });
});

describe("parseReviewTabTelemetryInput", () => {
  it("accepts the fixed tab dwell telemetry shape", () => {
    expect(
      parseReviewTabTelemetryInput({
        tab: "review",
        duration_ms: 250,
        reason: "visibility_hidden",
        app_session_id: "session-1234567890",
        document: "/pr/123",
      }),
    ).toEqual({
      tab: "review",
      durationMs: 250,
      reason: "visibility_hidden",
      appSessionId: "session-1234567890",
    });
  });

  it("rejects values outside the telemetry allowlist", () => {
    expect(() =>
      parseReviewTabTelemetryInput({
        tab: "timeline",
        duration_ms: 249,
        reason: "route_change",
        app_session_id: "../review",
      }),
    ).toThrow("tab must be review, commits, map, files, or trace");
  });
});

describe("strict mutation boundaries", () => {
  it("rejects unknown keys in comment and submission inputs", () => {
    const target = { kind: "document" };
    expect(() =>
      parseReviewSubmissionInput({
        submissionId: "submission-1",
        decision: "request-changes",
        comments: [
          {
            threadId: "thread-1",
            messageId: "message-1",
            target,
            body: "Fix this.",
            unexpected: true,
          },
        ],
      }),
    ).toThrow(/unexpected|Unrecognized/i);
  });
});
