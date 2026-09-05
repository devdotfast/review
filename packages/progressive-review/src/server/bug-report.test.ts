import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import {
  type JsonObject,
  REVIEW_SCHEMA_VERSION,
  type ReviewBugReportRequest,
} from "@dev.fast/review-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type BugReportPayload,
  buildBugReportRequest,
  submitReviewBugReport,
} from "./bug-report";
import type { AuthoringTraceAttachment } from "./bug-report-trace";

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
  });

  afterEach(() => {
    delete process.env.TRACE_LOCAL_TRACE_ROOT;
    delete process.env.TRACE_CODEX_SESSIONS_ROOT;
    delete process.env.TRACE_PI_SESSIONS_ROOT;
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
    expect(meta).not.toHaveProperty("description");
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

  it("includes a verbatim meaningful description in report metadata", async () => {
    writeReview("disabled:review");
    const description = "First line\nSnow: 雪\nLast line";
    const capture = captureFetch();

    await submitReviewBugReport({
      report: report({ description }),
      reviewDocumentPath: path.join(reviewRootPath, "review.mdx"),
      reviewRootPath,
      clientErrorNames: [],
      fetchImpl: capture.fetchImpl,
    });

    expect(JSON.parse(capture.textPart("meta"))).toMatchObject({
      description,
      description_length: Buffer.byteLength(description),
    });
  });

  it("omits a whitespace-only description from report metadata", async () => {
    writeReview("disabled:review");
    const capture = captureFetch();

    await submitReviewBugReport({
      report: report({ description: " \n\t " }),
      reviewDocumentPath: path.join(reviewRootPath, "review.mdx"),
      reviewRootPath,
      clientErrorNames: [],
      fetchImpl: capture.fetchImpl,
    });

    const meta = JSON.parse(capture.textPart("meta"));
    expect(meta).not.toHaveProperty("description");
    expect(meta.description_length).toBe(4);
  });

  it.each([503, 422])(
    "reports an upstream %s as a service failure without retrying",
    async (status) => {
      writeReview("disabled:review");
      const fetchImpl = vi.fn<typeof fetch>(async () =>
        Response.json({ ok: false, error: "Rejected." }, { status }),
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
    },
  );

  it("drops subagent trace files before a changed-file diff", async () => {
    const trace: AuthoringTraceAttachment = {
      payload: {
        harness: "claude-code",
        session_id: "11111111-1111-4111-8111-111111111111",
        files: {
          "subagents/agent.jsonl": randomBytes(2048).toString("base64"),
        },
        truncated: false,
      },
      parts: [],
      cleanup: async () => {},
    };
    const payload: BugReportPayload = {
      schema_version: 4,
      description: "",
      trace: trace.payload,
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
      diagnostics: diagnostics(),
    };

    const request = await buildBugReportRequest(payload, trace, {
      appVersion: "1.2.3",
      cliVersion: "0.0.1",
      maxPayloadBytes: 1024,
    });
    const formPayload = request.body.get("payload");
    if (!(formPayload instanceof Blob)) throw new Error("Missing payload.");
    const fitted = JSON.parse(
      gunzipSync(Buffer.from(await formPayload.arrayBuffer())).toString("utf8"),
    );
    const meta = JSON.parse(String(request.body.get("meta")));

    expect(fitted.trace).toEqual({
      harness: "claude-code",
      session_id: "11111111-1111-4111-8111-111111111111",
      files: {},
      omitted_files: ["subagents/agent.jsonl"],
      truncated: true,
    });
    expect(fitted).toHaveProperty("diff.files.0.path", "src/example.ts");
    expect(meta).toMatchObject({
      has_diff: true,
      truncated_diff: false,
      truncated_trace: true,
    });
    expect(trace.payload.truncated).toBe(false);
  });

  it("drops trace parts that exceed the upload cap instead of the report", async () => {
    const trace: AuthoringTraceAttachment = {
      payload: {
        harness: "codex",
        session_id: "22222222-2222-4222-8222-222222222222",
        files: {},
        truncated: false,
      },
      parts: [
        {
          filename: "trace-0.jsonl.gz",
          session_id: "22222222-2222-4222-8222-222222222222",
          path: path.join(tempDir, "missing-trace-0.jsonl.gz"),
          bytes: 99_000_001,
          sha256: "0".repeat(64),
        },
      ],
      cleanup: async () => {},
    };
    const payload: BugReportPayload = {
      schema_version: 4,
      description: "",
      trace: trace.payload,
      diagnostics: {
        ...diagnostics(),
        attachment_errors: [{ attachment: "review", error: "unavailable" }],
      },
    };

    const request = await buildBugReportRequest(payload, trace, {
      appVersion: "1.2.3",
      cliVersion: "0.0.1",
    });
    const formPayload = request.body.get("payload");
    if (!(formPayload instanceof Blob)) throw new Error("Missing payload.");
    const fitted = JSON.parse(
      gunzipSync(Buffer.from(await formPayload.arrayBuffer())).toString("utf8"),
    );
    const meta = JSON.parse(String(request.body.get("meta")));

    expect(request.body.getAll("trace")).toEqual([]);
    expect(fitted).not.toHaveProperty("trace");
    expect(fitted.diagnostics.attachment_errors).toEqual([
      { attachment: "review", error: "unavailable" },
      { attachment: "trace", error: "too_large" },
    ]);
    expect(meta).toMatchObject({ has_trace: false, truncated_trace: false });
    expect(meta).not.toHaveProperty("trace_harness");
    expect(meta.parts).toHaveLength(1);
  });

  it("does not replace a successful submit when trace cleanup fails", async () => {
    writeReview("claude-code:cleanup-test");
    const cleanup = vi.fn<() => Promise<void>>(async () => {
      throw new Error("busy");
    });
    const trace: AuthoringTraceAttachment = {
      payload: {
        harness: "claude-code",
        session_id: "cleanup-test",
        files: {},
        truncated: false,
      },
      parts: [],
      cleanup,
    };
    const capture = captureFetch();

    await expect(
      submitReviewBugReport({
        report: report({ include_trace: true }),
        reviewDocumentPath: path.join(reviewRootPath, "review.mdx"),
        reviewRootPath,
        clientErrorNames: [],
        fetchImpl: capture.fetchImpl,
        readTraceAttachment: async () => trace,
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(cleanup).toHaveBeenCalledOnce();
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

function diagnostics(): BugReportPayload["diagnostics"] {
  return {
    app_version: "1.2.3",
    cli_version: "0.0.1",
    platform: process.platform,
    app_session_id: "session-1234567890",
    client_error_names: [],
  };
}

interface CapturedFile {
  filename: string;
  type: string;
  bytes: Buffer;
}

type CapturedPart =
  | { name: string; text: string }
  | { name: string; file: CapturedFile };

interface CapturedFetch {
  fetchImpl: typeof fetch;
  url: () => string;
  headers: () => Headers;
  parts: () => CapturedPart[];
  textPart: (name: string) => string;
  filePart: (name: string) => Buffer;
  fileParts: (name: string) => Buffer[];
}

function captureFetch(): CapturedFetch {
  let url: string | undefined;
  let headers: Headers | undefined;
  const capturedParts: CapturedPart[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    url = input.toString();
    headers = new Headers(init?.headers);
    const form = init?.body;
    if (!(form instanceof FormData)) throw new Error("Expected FormData.");
    for (const [name, value] of form.entries()) {
      capturedParts.push(
        value instanceof File
          ? {
              name,
              file: {
                filename: value.name,
                type: value.type,
                bytes: Buffer.from(await value.arrayBuffer()),
              },
            }
          : { name, text: value },
      );
    }
    return successResponse();
  };
  const part = (name: string) => {
    const result = capturedParts.find((candidate) => candidate.name === name);
    if (!result) throw new Error(`Missing captured ${name} part.`);
    return result;
  };
  return {
    fetchImpl,
    url: () => url ?? "",
    headers: () => headers ?? new Headers(),
    parts: () => capturedParts,
    textPart: (name) => {
      const captured = part(name);
      if (!("text" in captured)) throw new Error(`${name} is not text.`);
      return captured.text;
    },
    filePart: (name) => {
      const captured = part(name);
      if (!("file" in captured)) throw new Error(`${name} is not a file.`);
      return captured.file.bytes;
    },
    fileParts: (name) =>
      capturedParts
        .filter((candidate) => candidate.name === name)
        .map((candidate) => {
          if (!("file" in candidate)) {
            throw new Error(`${name} is not a file.`);
          }
          return candidate.file.bytes;
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
  records: JsonObject[],
  parent?: {
    parentId: string;
    endOrdinalExclusive: number;
  },
): string {
  const payload: JsonObject = { id };
  if (parent) {
    payload.history_base = {
      thread_id: parent.parentId,
      end_ordinal_exclusive: parent.endOrdinalExclusive,
    };
  }
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
