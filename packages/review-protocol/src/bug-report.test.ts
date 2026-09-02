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

  it("accepts ordered schema 2 trace parts and rejects reordered parts", () => {
    const meta = {
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
      parts: [
        {
          field: "payload",
          filename: "payload.json.gz",
          bytes: 100,
          sha256: "a".repeat(64),
        },
        {
          field: "source_trace",
          filename: "source.jsonl.gz",
          session_id: "11111111-1111-4111-8111-111111111111",
          bytes: 200,
          sha256: "b".repeat(64),
        },
        {
          field: "parent_trace",
          filename: "parent.jsonl.gz",
          session_id: "22222222-2222-4222-8222-222222222222",
          bytes: 300,
          sha256: "c".repeat(64),
        },
      ],
    };

    expect(ReviewBugReportMetaV2Schema.parse(meta)).toEqual(meta);
    expect(() =>
      ReviewBugReportMetaV2Schema.parse({
        ...meta,
        parts: [meta.parts[0], meta.parts[2], meta.parts[1]],
      }),
    ).toThrow(/must list payload/);
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
      parts: [
        {
          field: "payload",
          filename: "payload.json.gz",
          bytes: 100,
          sha256: "a".repeat(64),
        },
      ],
    };

    expect(ReviewBugReportMetaV2Schema.parse(meta)).toEqual(meta);
    expect(() =>
      ReviewBugReportMetaV2Schema.parse({ ...meta, trace_harness: "codex" }),
    ).toThrow(/present only when the report has a trace/);
  });
});
