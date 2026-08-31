import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import {
  REVIEW_SCHEMA_VERSION,
  type ReviewBugReportRequest,
} from "@dev.fast/review-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearTraceEnvCache } from "../review-agent-traces";
import {
  buildSizedBugReportRequest,
  submitReviewBugReport,
} from "./bug-report";
import type { AuthoringTraceAttachment } from "./bug-report-trace";

describe("submitReviewBugReport", () => {
  let tempDir: string;
  let reviewRootPath: string;
  let codexRoot: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "bug-report-submit-"));
    reviewRootPath = path.join(tempDir, "review");
    codexRoot = path.join(tempDir, "codex");
    const claudeRoot = path.join(tempDir, "claude");
    const piRoot = path.join(tempDir, "pi");
    for (const directory of [reviewRootPath, codexRoot, claudeRoot, piRoot]) {
      mkdirSync(directory, { recursive: true });
    }
    process.env.TRACE_LOCAL_TRACE_ROOT = claudeRoot;
    process.env.TRACE_CODEX_SESSIONS_ROOT = codexRoot;
    process.env.TRACE_PI_SESSIONS_ROOT = piRoot;
    clearTraceEnvCache();
  });

  afterEach(() => {
    delete process.env.TRACE_LOCAL_TRACE_ROOT;
    delete process.env.TRACE_CODEX_SESSIONS_ROOT;
    delete process.env.TRACE_PI_SESSIONS_ROOT;
    clearTraceEnvCache();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("attaches the resolved authoring trace and exposes filterable metadata", async () => {
    const sessionId = "77777777-aaaa-bbbb-cccc-000000000007";
    writeReview("codex:" + sessionId);
    const dateDir = path.join(codexRoot, "2026", "08", "31");
    mkdirSync(dateDir, { recursive: true });
    writeFileSync(
      path.join(dateDir, "rollout-2026-08-31T12-00-00-" + sessionId + ".jsonl"),
      JSON.stringify({ prompt: "Fix the bug" }) + "\n",
    );
    const capture = captureFetch();

    await submitReviewBugReport({
      report: report({ include_trace: true }),
      reviewDocumentPath: path.join(reviewRootPath, "review.mdx"),
      reviewRootPath,
      clientErrorNames: ["TypeError"],
      fetchImpl: capture.fetchImpl,
    });

    const { meta, payload } = parseMultipart(capture.body());
    expect(meta).toMatchObject({
      has_trace: true,
      trace_harness: "codex",
      truncated_trace: false,
    });
    expect(payload).toMatchObject({
      schema_version: 3,
      trace: {
        harness: "codex",
        session_id: sessionId,
        truncated: false,
      },
    });
  });

  it("records an unavailable trace without failing the report", async () => {
    writeReview("codex:missing-session");
    const capture = captureFetch();

    await submitReviewBugReport({
      report: report({ include_trace: true }),
      reviewDocumentPath: path.join(reviewRootPath, "review.mdx"),
      reviewRootPath,
      clientErrorNames: [],
      fetchImpl: capture.fetchImpl,
    });

    const { meta, payload } = parseMultipart(capture.body());
    expect(meta).not.toHaveProperty("has_trace");
    expect(meta).not.toHaveProperty("trace_harness");
    expect(meta).not.toHaveProperty("truncated_trace");
    expect(payload).not.toHaveProperty("trace");
    expect(payload).toMatchObject({
      diagnostics: {
        attachment_errors: [{ attachment: "trace", error: "unavailable" }],
      },
    });
  });

  it("drops an oversized trace before a changed-file diff", () => {
    const payload = bugReportPayload(largeTraceAttachment());

    const request = buildSizedBugReportRequest(payload, {
      appVersion: "1.2.3",
      cliVersion: "0.0.1",
    });

    const { meta, payload: fittedPayload } = parseMultipart(request.body);
    expect(meta).toMatchObject({
      has_trace: false,
      has_diff: true,
      trace_harness: "claude-code",
      truncated_trace: true,
      truncated_diff: false,
    });
    expect(fittedPayload).not.toHaveProperty("trace");
    expect(fittedPayload).toHaveProperty("diff.files.0.path", "src/example.ts");
  });

  function writeReview(sourceSession: string): void {
    writeFileSync(
      path.join(reviewRootPath, "review.json"),
      JSON.stringify({
        schemaVersion: REVIEW_SCHEMA_VERSION,
        uuid: "00000000-0000-4000-8000-000000000000",
        repoKey: "example/review",
        worktreePath: tempDir,
        baseRef: "main",
        baseCommit: "a".repeat(40),
        sourceCommit: null,
        sourceIdentity: null,
        pullRequestNumber: null,
        pullRequestUrl: null,
        title: "Bug report test",
        sourceSession,
        status: "draft",
        presentedDocumentRevision: null,
        presentedSoftwareMapRevision: null,
        createdAt: "2026-08-31T12:00:00.000Z",
        lastPublishedAt: null,
      }),
    );
  }
});

function report(
  overrides: Partial<ReviewBugReportRequest> = {},
): ReviewBugReportRequest {
  return {
    description: "",
    include_review: false,
    include_map: false,
    include_diff: false,
    include_trace: false,
    app_session_id: "session-1234567890",
    app_version: "1.2.3",
    ...overrides,
  };
}

function captureFetch(): {
  fetchImpl: typeof fetch;
  body: () => Buffer;
} {
  let body: Buffer | undefined;
  const fetchImpl: typeof fetch = async (_input, init) => {
    body = Buffer.from(init?.body as Buffer);
    return new Response(
      JSON.stringify({
        ok: true,
        report_id: "00000000-0000-4000-8000-000000000000",
        short_id: "123456789012",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  return {
    fetchImpl,
    body: () => {
      if (!body) throw new Error("Bug-report body was not captured");
      return body;
    },
  };
}

function parseMultipart(body: Buffer): {
  meta: Record<string, unknown>;
  payload: Record<string, unknown>;
} {
  const metaHeader = Buffer.from('Content-Disposition: form-data; name="meta"');
  const payloadHeader = Buffer.from(
    'Content-Disposition: form-data; name="payload"',
  );
  const metaPart = body.indexOf(metaHeader);
  const metaStart = body.indexOf(Buffer.from("\r\n\r\n"), metaPart) + 4;
  const metaEnd = body.indexOf(Buffer.from("\r\n--"), metaStart);
  const payloadPart = body.indexOf(payloadHeader);
  const payloadStart = body.indexOf(Buffer.from("\r\n\r\n"), payloadPart) + 4;
  const payloadEnd = body.lastIndexOf(Buffer.from("\r\n--"));
  return {
    meta: JSON.parse(body.subarray(metaStart, metaEnd).toString("utf8")),
    payload: JSON.parse(
      gunzipSync(body.subarray(payloadStart, payloadEnd)).toString("utf8"),
    ),
  };
}

function bugReportPayload(
  trace: AuthoringTraceAttachment,
): Parameters<typeof buildSizedBugReportRequest>[0] {
  return {
    schema_version: 3,
    description: "",
    trace,
    diff: {
      baseRef: "base",
      headRef: "head",
      files: [
        {
          path: "src/example.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: "@@ -1 +1 @@\n-old\n+new",
        },
      ],
    },
    diagnostics: {
      app_version: "1.2.3",
      cli_version: "0.0.1",
      platform: process.platform,
      app_session_id: "session-1234567890",
      client_error_names: [],
    },
  };
}

function largeTraceAttachment(): AuthoringTraceAttachment {
  const files: Record<string, string> = {
    "trace.jsonl": incompressibleJsonl(6 * 1024 * 1024),
  };
  for (let index = 0; index < 10; index++) {
    files["subagents/agent-" + index + ".jsonl"] = incompressibleJsonl(
      1024 * 1024,
    );
  }
  return {
    harness: "claude-code",
    session_id: "session-oversized",
    files,
    truncated: false,
  };
}

function incompressibleJsonl(targetBytes: number): string {
  const lines: string[] = [];
  let bytes = 0;
  while (bytes < targetBytes) {
    const line =
      JSON.stringify({ data: randomBytes(768).toString("base64") }) + "\n";
    lines.push(line);
    bytes += Buffer.byteLength(line);
  }
  return lines.join("");
}
