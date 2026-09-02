import { describe, expect, it } from "vitest";

import {
  ReviewBugReportMetaV2Schema,
  parseReviewBugReportRequest,
} from "./bug-report.js";

describe("bug report protocol", () => {
  it("round-trips trace consent and defaults it off for older clients", () => {
    const request = {
      description: "",
      include_review: true,
      include_map: true,
      include_diff: true,
      include_trace: false,
      app_session_id: "session-1234567890",
      app_version: "1.2.3",
    };

    expect(parseReviewBugReportRequest(request)).toEqual(request);

    const { include_trace: _includeTrace, ...withoutTraceConsent } = request;
    expect(parseReviewBugReportRequest(withoutTraceConsent)).toEqual(request);
  });

  const payloadPart = {
    field: "payload" as const,
    filename: "payload.json.gz" as const,
    bytes: 100,
    sha256: "a".repeat(64),
  };

  const tracePart = (index: number, sessionId = `session-${index}`) => ({
    field: "trace" as const,
    filename: `trace-${index}.jsonl.gz`,
    session_id: sessionId,
    bytes: 200 + index,
    sha256: "b".repeat(64),
  });

  const baseMeta = {
    schema_version: 2,
    description_length: 12,
    has_review: false,
    has_map: false,
    has_diff: false,
    has_screenshot: false,
    has_trace: true,
    trace_harness: "codex" as const,
    payload_bytes: 100,
    app_version: "1.2.3",
    cli_version: "0.0.1",
    platform: "darwin",
    truncated_diff: false,
    truncated_map: false,
    truncated_screenshot: false,
    truncated_trace: false,
    parts: [payloadPart, tracePart(0), tracePart(1)],
  } as const;

  it("accepts ordered schema 2 trace parts", () => {
    expect(ReviewBugReportMetaV2Schema.parse(baseMeta)).toEqual(baseMeta);
  });

  it("rejects skipped or reordered trace filenames", () => {
    expect(() =>
      ReviewBugReportMetaV2Schema.parse({
        ...baseMeta,
        parts: [payloadPart, tracePart(1), tracePart(0)],
      }),
    ).toThrow(/trace-<n>/);
    expect(() =>
      ReviewBugReportMetaV2Schema.parse({
        ...baseMeta,
        parts: [payloadPart, tracePart(0), tracePart(2)],
      }),
    ).toThrow(/trace-<n>/);
  });

  it("rejects duplicate trace session ids", () => {
    expect(() =>
      ReviewBugReportMetaV2Schema.parse({
        ...baseMeta,
        parts: [
          payloadPart,
          tracePart(0, "duplicate"),
          tracePart(1, "duplicate"),
        ],
      }),
    ).toThrow(/trace-<n>/);
  });

  it("rejects trace presence that disagrees with has_trace", () => {
    expect(() =>
      ReviewBugReportMetaV2Schema.parse({
        ...baseMeta,
        has_trace: false,
        trace_harness: undefined,
      }),
    ).toThrow(/presence of trace parts/);
    expect(() =>
      ReviewBugReportMetaV2Schema.parse({
        ...baseMeta,
        has_trace: true,
        parts: [payloadPart],
      }),
    ).toThrow(/presence of trace parts/);
  });

  it("accepts a schema 2 report without a trace", () => {
    const meta = {
      schema_version: 2,
      description_length: 12,
      has_review: false,
      has_map: false,
      has_diff: false,
      has_screenshot: false,
      has_trace: false,
      payload_bytes: 100,
      app_version: "1.2.3",
      cli_version: "0.0.1",
      platform: "darwin",
      truncated_diff: false,
      truncated_map: false,
      truncated_screenshot: false,
      truncated_trace: false,
      parts: [payloadPart],
    };

    expect(ReviewBugReportMetaV2Schema.parse(meta)).toEqual(meta);
    expect(() =>
      ReviewBugReportMetaV2Schema.parse({ ...meta, trace_harness: "codex" }),
    ).toThrow(/present only when the report has a trace/);
  });
});
