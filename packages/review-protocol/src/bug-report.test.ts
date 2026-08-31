import { describe, expect, it } from "vitest";

import {
  parseReviewBugReportMeta,
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

  it("round-trips trace metadata and defaults new fields for older senders", () => {
    const meta = {
      schema_version: 1,
      description_length: 0,
      has_review: true,
      has_map: true,
      has_diff: true,
      has_screenshot: false,
      has_trace: true,
      trace_harness: "codex" as const,
      payload_bytes: 1024,
      app_version: "1.2.3",
      cli_version: "0.0.1",
      platform: "darwin",
      truncated_diff: false,
      truncated_map: false,
      truncated_screenshot: false,
      truncated_trace: true,
    };

    expect(parseReviewBugReportMeta(meta)).toEqual(meta);

    const {
      has_trace: _hasTrace,
      trace_harness: _traceHarness,
      truncated_trace: _truncatedTrace,
      ...olderMeta
    } = meta;
    expect(parseReviewBugReportMeta(olderMeta)).toEqual({
      ...olderMeta,
      has_trace: false,
      truncated_trace: false,
    });
  });
});
