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
  let claudeRoot: string;
  let codexRoot: string;
  let piRoot: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "bug-report-submit-"));
    reviewRootPath = path.join(tempDir, "review");
    codexRoot = path.join(tempDir, "codex");
    claudeRoot = path.join(tempDir, "claude");
    piRoot = path.join(tempDir, "pi");
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

  it("sends ordered generic parts for a complete Codex lineage", async () => {
    const parentId = "11111111-1111-4111-8111-111111111111";
    const childId = "22222222-2222-4222-8222-222222222222";
    const parentAtFork = codexTrace(parentId, 0, [{ parent: true }]);
    const parent =
      parentAtFork + JSON.stringify({ parentLater: true, ordinal: 2 }) + "\n";
    const child = codexTrace(childId, 2, [{ child: true }], {
      parentId,
      endOrdinalExclusive: 2,
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
      "trace",
      "trace",
    ]);
    const meta = JSON.parse(capture.textPart("meta")) as {
      schema_version: number;
      payload_bytes: number;
      parts: Array<{
        field: string;
        filename: string;
        bytes: number;
        sha256: string;
      }>;
    };
    expect(meta.schema_version).toBe(2);
    expect(meta.parts.map((part) => part.field)).toEqual([
      "payload",
      "trace",
      "trace",
    ]);
    expect(meta.parts.map((part) => part.filename)).toEqual([
      "payload.json.gz",
      "trace-0.jsonl.gz",
      "trace-1.jsonl.gz",
    ]);

    const payloadBytes = capture.filePart("payload");
    const payload = JSON.parse(gunzipSync(payloadBytes).toString("utf8"));
    expect(payload).toMatchObject({
      schema_version: 4,
      trace: {
        harness: "codex",
        truncated: false,
      },
    });
    const traceFiles = capture.fileParts("trace");
    expect(traceFiles).toHaveLength(2);
    expect(gunzipSync(traceFiles[0]).toString("utf8")).toBe(child);
    expect(gunzipSync(traceFiles[1]).toString("utf8")).toBe(parentAtFork);
    expect(meta.payload_bytes).toBe(payloadBytes.byteLength);
    const files = [payloadBytes, ...traceFiles];
    for (const [index, part] of meta.parts.entries()) {
      const bytes = files[index];
      expect(part.bytes).toBe(bytes.byteLength);
      expect(part.sha256).toBe(sha256(bytes));
    }
  });

  it.each([
    ["claude-code", "33333333-3333-4333-8333-333333333333"],
    ["pi", "44444444-4444-4444-8444-444444444444"],
  ] as const)(
    "sends an opted-in %s trace through the generic field",
    async (harness, id) => {
      const source = JSON.stringify({ harness, id }) + "\n";
      writeReview(harness + ":" + id);
      writeHarnessTrace(harness, id, source);
      const capture = captureFetch();

      await submitReviewBugReport({
        report: report({ include_trace: true }),
        reviewDocumentPath: path.join(reviewRootPath, "review.mdx"),
        reviewRootPath,
        clientErrorNames: [],
        fetchImpl: capture.fetchImpl,
      });

      expect(capture.parts().map((part) => part.name)).toEqual([
        "meta",
        "payload",
        "trace",
      ]);
      const meta = JSON.parse(capture.textPart("meta"));
      expect(meta).toMatchObject({
        has_trace: true,
        trace_harness: harness,
        parts: [
          { field: "payload", filename: "payload.json.gz" },
          {
            field: "trace",
            filename: "trace-0.jsonl.gz",
            session_id: id,
          },
        ],
      });
      const payload = JSON.parse(
        gunzipSync(capture.filePart("payload")).toString("utf8"),
      );
      expect(payload.trace).toMatchObject({
        harness,
      });
      expect(gunzipSync(capture.filePart("trace")).toString("utf8")).toBe(
        source,
      );
    },
  );

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

  it("sends schema 2 payload parts for reports without traces", async () => {
    writeReview("disabled:review");
    const capture = captureFetch();

    await submitReviewBugReport({
      report: report(),
      reviewDocumentPath: path.join(reviewRootPath, "review.mdx"),
      reviewRootPath,
      clientErrorNames: [],
      fetchImpl: capture.fetchImpl,
    });

    expect(capture.url()).toBe("https://bug.dev.fast/api/v2/reports");
    expect(capture.headers().get("X-Review-Bug-Report-Schema")).toBeNull();
    expect(capture.parts().map((part) => part.name)).toEqual([
      "meta",
      "payload",
    ]);
    const meta = JSON.parse(capture.textPart("meta")) as {
      schema_version: number;
      has_trace: boolean;
      parts: Array<{ field: string; bytes: number; sha256: string }>;
    };
    expect(meta).toMatchObject({
      schema_version: 2,
      has_trace: false,
      parts: [{ field: "payload" }],
    });
    const payloadBytes = capture.filePart("payload");
    expect(JSON.parse(gunzipSync(payloadBytes).toString("utf8"))).toMatchObject(
      {
        schema_version: 4,
        description: "",
      },
    );
    expect(meta.parts[0].bytes).toBe(payloadBytes.byteLength);
    expect(meta.parts[0].sha256).toBe(sha256(payloadBytes));
  });

  it("does not retry a failed schema 2 report through schema 1", async () => {
    writeReview("disabled:review");
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ ok: false, error: "Unavailable." }, { status: 503 }),
    );

    await expect(
      submitReviewBugReport({
        report: report(),
        reviewDocumentPath: path.join(reviewRootPath, "review.mdx"),
        reviewRootPath,
        clientErrorNames: [],
        fetchImpl,
      }),
    ).rejects.toMatchObject({ status: 502 });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0][0].toString()).toBe(
      "https://bug.dev.fast/api/v2/reports",
    );
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

  function writeHarnessTrace(
    harness: "claude-code" | "pi",
    id: string,
    contents: string,
  ): void {
    const directory = path.join(
      harness === "claude-code" ? claudeRoot : piRoot,
      "project",
    );
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(
        directory,
        harness === "claude-code"
          ? id + ".jsonl"
          : "2026-08-31T12-00-00_" + id + ".jsonl",
      ),
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
  fileParts: (name: string) => Buffer[];
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
    fileParts: (name) =>
      capturedParts
        .filter((candidate) => candidate.name === name)
        .map((candidate) => {
          if (typeof candidate.value === "string") {
            throw new Error(`${name} is not a file.`);
          }
          return candidate.value.bytes;
        }),
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
  },
): string {
  const payload = {
    id,
    ...(parent
      ? {
          history_base: {
            thread_id: parent.parentId,
            end_ordinal_exclusive: parent.endOrdinalExclusive,
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
