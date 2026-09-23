import type { JsonValue } from "@dev.fast/whiteboard-protocol";
import { describe, expect, it } from "vitest";

import {
  parseSoftwareMapCodeElements,
  parseWhiteboardBugReportInput,
  parseWhiteboardTabTelemetryInput,
} from "./whiteboard-api-parsers";

const bugReport = {
  description: "",
  include_review: true,
  include_map: true,
  include_diff: true,
  include_trace: false,
  app_session_id: "session-1234567890",
  app_version: "1.2.3",
};

describe("parseWhiteboardBugReportInput", () => {
  it("accepts an empty description", () => {
    expect(parseWhiteboardBugReportInput(bugReport).description).toBe("");
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
      parseWhiteboardBugReportInput({ ...bugReport, screenshot }),
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
      parseWhiteboardBugReportInput({
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

function expectBugReportStatus(value: JsonValue, statusCode: number) {
  let thrown: unknown;

  try {
    parseWhiteboardBugReportInput(value);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toMatchObject({ statusCode });
}

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

describe("parseWhiteboardTabTelemetryInput", () => {
  it("accepts the fixed tab dwell telemetry shape", () => {
    expect(
      parseWhiteboardTabTelemetryInput({
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
      parseWhiteboardTabTelemetryInput({
        tab: "timeline",
        duration_ms: 249,
        reason: "route_change",
        app_session_id: "../review",
      }),
    ).toThrow("tab must be review, commits, map, files, or trace");
  });
});
