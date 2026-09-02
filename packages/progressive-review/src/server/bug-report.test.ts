import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import {
  REVIEW_SCHEMA_VERSION,
  type ReviewBugReportRequest,
} from "@dev.fast/review-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearTraceEnvCache } from "../review-agent-traces";
import { submitReviewBugReport } from "./bug-report";

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

  it("sends ordered schema 2 parts for the complete child and parent traces", async () => {
    const parentId = "11111111-1111-4111-8111-111111111111";
    const childId = "22222222-2222-4222-8222-222222222222";
    const parentAtFork = codexTrace(parentId, 0, [{ parent: true }]);
    const parent =
      parentAtFork + JSON.stringify({ parentLater: true, ordinal: 2 }) + "\n";
    const child = codexTrace(childId, 2, [{ child: true }], {
      parentId,
      endOrdinalExclusive: 2,
      endByteOffset: Buffer.byteLength(parentAtFork),
    });
    writeCodexTrace(parentId, parent);
    writeCodexTrace(childId, child);
    writeReview("codex:" + childId);
    const capture = captureFetch();

    await submitReviewBugReport({
      report: report({ include_trace: true }),
      reviewDocumentPath: path.join(reviewRootPath, "review.mdx"),
      reviewRootPath,
      clientErrorNames: ["TypeError"],
      fetchImpl: capture.fetchImpl,
    });

    expect(capture.url()).toBe("https://bug.dev.fast/api/v2/reports");
    expect(capture.headers().get("X-Review-Bug-Report-Schema")).toBeNull();
    expect(capture.parts().map((part) => part.name)).toEqual([
      "meta",
      "payload",
      "source_trace",
      "parent_trace",
    ]);
    const meta = JSON.parse(capture.textPart("meta")) as {
      schema_version: number;
      payload_bytes: number;
      parts: Array<{ field: string; bytes: number; sha256: string }>;
    };
    expect(meta.schema_version).toBe(2);
    expect(meta.parts.map((part) => part.field)).toEqual([
      "payload",
      "source_trace",
      "parent_trace",
    ]);

    const payloadBytes = capture.filePart("payload");
    const payload = JSON.parse(gunzipSync(payloadBytes).toString("utf8"));
    expect(payload).toMatchObject({
      schema_version: 4,
      trace: {
        harness: "codex",
        session_id: childId,
        parent_session_id: parentId,
        truncated: false,
      },
    });
    expect(gunzipSync(capture.filePart("source_trace")).toString("utf8")).toBe(
      child,
    );
    expect(gunzipSync(capture.filePart("parent_trace")).toString("utf8")).toBe(
      parent,
    );
    expect(meta.payload_bytes).toBe(payloadBytes.byteLength);
    for (const part of meta.parts) {
      const bytes = capture.filePart(part.field);
      expect(part.bytes).toBe(bytes.byteLength);
      expect(part.sha256).toBe(sha256(bytes));
    }
  });

  it("fails instead of omitting a selected trace", async () => {
    writeReview("codex:missing-session");
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      submitReviewBugReport({
        report: report({ include_trace: true }),
        reviewDocumentPath: path.join(reviewRootPath, "review.mdx"),
        reviewRootPath,
        clientErrorNames: [],
        fetchImpl,
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps the schema 1 multipart path for reports without traces", async () => {
    writeReview("disabled:review");
    let url: string | undefined;
    let headers: Headers | undefined;
    let body: Buffer | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      url = input.toString();
      headers = new Headers(init?.headers);
      body = Buffer.from(init?.body as Buffer);
      return successResponse();
    };

    await submitReviewBugReport({
      report: report(),
      reviewDocumentPath: path.join(reviewRootPath, "review.mdx"),
      reviewRootPath,
      clientErrorNames: [],
      fetchImpl,
    });

    expect(url).toBe("https://bug.dev.fast/api/v1/reports");
    expect(headers?.get("X-Review-Bug-Report-Schema")).toBeNull();
    expect(headers?.get("content-type")).toContain(
      "boundary=dev-fast-review-bug-report-v1",
    );
    expect(parseV1Multipart(body ?? Buffer.alloc(0)).payload).toMatchObject({
      schema_version: 3,
      description: "",
    });
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

  function writeCodexTrace(id: string, contents: string): void {
    const dateDir = path.join(codexRoot, "2026", "08", "31");
    mkdirSync(dateDir, { recursive: true });
    writeFileSync(
      path.join(dateDir, "rollout-2026-08-31T12-00-00-" + id + ".jsonl"),
      contents,
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

interface CapturedPart {
  name: string;
  value: string | { filename: string; type: string; bytes: Buffer };
}

function captureFetch(): {
  fetchImpl: typeof fetch;
  url: () => string;
  headers: () => Headers;
  parts: () => CapturedPart[];
  textPart: (name: string) => string;
  filePart: (name: string) => Buffer;
} {
  let url: string | undefined;
  let headers: Headers | undefined;
  const capturedParts: CapturedPart[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    url = input.toString();
    headers = new Headers(init?.headers);
    const form = init?.body;
    if (!(form instanceof FormData)) throw new Error("Expected FormData.");
    for (const [name, value] of form.entries()) {
      capturedParts.push({
        name,
        value:
          typeof value === "string"
            ? value
            : {
                filename: value.name,
                type: value.type,
                bytes: Buffer.from(await value.arrayBuffer()),
              },
      });
    }
    return successResponse();
  };
  const part = (name: string) => {
    const result = capturedParts.find((candidate) => candidate.name === name);
    if (!result) throw new Error(`Missing captured ${name} part.`);
    return result.value;
  };
  return {
    fetchImpl,
    url: () => url ?? "",
    headers: () => headers ?? new Headers(),
    parts: () => capturedParts,
    textPart: (name) => {
      const value = part(name);
      if (typeof value !== "string") throw new Error(`${name} is not text.`);
      return value;
    },
    filePart: (name) => {
      const value = part(name);
      if (typeof value === "string") throw new Error(`${name} is not a file.`);
      return value.bytes;
    },
  };
}

function successResponse(): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      report_id: "00000000-0000-4000-8000-000000000000",
      short_id: "123456789012",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function codexTrace(
  id: string,
  startOrdinal: number,
  records: Array<Record<string, unknown>>,
  parent?: {
    parentId: string;
    endOrdinalExclusive: number;
    endByteOffset: number;
  },
): string {
  const payload = {
    id,
    ...(parent
      ? {
          history_mode: "paginated",
          forked_from_id: parent.parentId,
          forked_from_ordinal_exclusive: parent.endOrdinalExclusive,
          history_base: {
            thread_id: parent.parentId,
            end_ordinal_exclusive: parent.endOrdinalExclusive,
            end_byte_offset: parent.endByteOffset,
          },
        }
      : {}),
  };
  return [{ type: "session_meta", payload }, ...records]
    .map(
      (value, index) =>
        JSON.stringify({ ...value, ordinal: startOrdinal + index }) + "\n",
    )
    .join("");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseV1Multipart(body: Buffer): {
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
