import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";

import {
  type ReviewBugReportMeta,
  type ReviewBugReportRequest,
  parseReviewBugReportResponse,
} from "@dev.fast/review-protocol";

import { readProgressiveReviewPackageVersion } from "../package-paths";
import {
  type ReviewDiffFilesResult,
  resolveReviewDiffFiles,
} from "../review-diff-files";
import {
  type ReviewSourceTarget,
  resolveReviewSourceTarget,
} from "../review-worktree-target";
import { readSoftwareMapSourceForRef } from "../software-map-artifact";
import {
  type AuthoringTraceAttachment,
  readAuthoringTraceAttachment,
} from "./bug-report-trace";

const BUG_REPORT_URL = "https://bug.dev.fast/api/v1/reports";
const MAX_MULTIPART_BYTES = 10 * 1024 * 1024;
const MULTIPART_BOUNDARY = "dev-fast-review-bug-report-v1";
const UPSTREAM_TIMEOUT_MS = 20_000;
// The review directory is a git repo, but its tracked set also holds
// `review.json` (an absolute home path, the repo key, the pull request URL) and
// the compiled `.bundle/` output. So the report attaches an explicit source set
// instead: the current document, plus the TypeScript modules it imports. A
// non-recursive scan keeps `.build/` and `.bundle/` out, which matters because
// `.build/<revision>/` holds a second copy of every source file.
const REVIEW_SOURCE_MODULE_RE = /\.tsx?$/;
const MAX_REVIEW_SOURCE_FILES = 20;
// Not a transfer limit: `MAX_MULTIPART_BYTES` already bounds what reaches the
// Worker. This bounds one file, because the size ladder below drops the whole
// review attachment rather than one module. So a single huge file would cost
// the report its entire review. Authored modules run to a few kilobytes, and
// 2 MiB leaves room for a generated one.
const MAX_REVIEW_SOURCE_FILE_BYTES = 2 * 1024 * 1024;

type AttachmentName = "review" | "map" | "diff" | "trace";
type AttachmentError = {
  attachment: AttachmentName;
  error: "unavailable";
};

interface BugReportPayload {
  schema_version: 3;
  description: string;
  screenshot?: { mime: "image/jpeg"; base64: string };
  // File name to text. The document alone cannot render: every anchor lives in
  // a sibling TypeScript module.
  review?: Record<string, string>;
  map?: string;
  diff?: ReviewDiffFilesResult;
  trace?: AuthoringTraceAttachment;
  diagnostics: {
    app_version: string;
    cli_version: string;
    platform: NodeJS.Platform;
    app_session_id: string;
    client_error_names: string[];
    attachment_errors?: AttachmentError[];
    // Review source files the report did not send, by name. Triage reads a
    // missing module as a rendering bug unless the report says it dropped one.
    review_omitted_files?: string[];
  };
}

export class BugReportUpstreamError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "BugReportUpstreamError";
  }
}

export async function submitReviewBugReport(input: {
  report: ReviewBugReportRequest;
  reviewDocumentPath: string;
  reviewRootPath: string;
  clientErrorNames: string[];
  fetchImpl?: typeof fetch;
}) {
  const cliVersion = readProgressiveReviewPackageVersion();
  const attachmentErrors: AttachmentError[] = [];
  const payload: BugReportPayload = {
    schema_version: 3,
    description: input.report.description,
    ...(input.report.screenshot ? { screenshot: input.report.screenshot } : {}),
    diagnostics: {
      app_version: input.report.app_version,
      cli_version: cliVersion,
      platform: process.platform,
      app_session_id: input.report.app_session_id,
      client_error_names: input.clientErrorNames.slice(-20),
    },
  };

  let reviewSource: Record<string, string> | undefined;
  let omittedReviewFiles: string[] | undefined;
  let mapSource: string | undefined;
  let changedFileDiffs: ReviewDiffFilesResult | undefined;
  let traceAttachment: AuthoringTraceAttachment | undefined;
  let sourceTargetPromise: Promise<ReviewSourceTarget> | undefined;
  const sourceTarget = () =>
    (sourceTargetPromise ??= resolveReviewSourceTarget({
      reviewRootPath: input.reviewRootPath,
    }));
  const tasks: Array<Promise<void>> = [];
  if (input.report.include_review) {
    tasks.push(
      readReviewSourceFiles(input.reviewDocumentPath).then(
        (result) => {
          reviewSource = result.files;
          if (result.omitted.length > 0) omittedReviewFiles = result.omitted;
        },
        () => {
          attachmentErrors.push(unavailable("review"));
        },
      ),
    );
  }
  if (input.report.include_map) {
    tasks.push(
      sourceTarget()
        .then(readHeadSoftwareMap)
        .then(
          // A review does not need a software map: #840 split document and map
          // publishing, so "no map" is a normal state, not a failed read.
          // `readSoftwareMapSourceForRef` returns null when there is nothing to
          // send and throws when a read fails, so only the throw is an error.
          (source) => {
            if (source !== null) mapSource = source;
          },
          () => {
            attachmentErrors.push(unavailable("map"));
          },
        ),
    );
  }
  if (input.report.include_diff) {
    tasks.push(
      sourceTarget()
        .then(readChangedFileDiffs)
        .then(
          (diff) => {
            changedFileDiffs = diff;
          },
          () => {
            attachmentErrors.push(unavailable("diff"));
          },
        ),
    );
  }
  if (input.report.include_trace) {
    tasks.push(
      readAuthoringTraceAttachment({
        reviewRootPath: input.reviewRootPath,
      }).then(
        (trace) => {
          if (trace === null) {
            attachmentErrors.push(unavailable("trace"));
            return;
          }
          traceAttachment = trace;
        },
        () => {
          attachmentErrors.push(unavailable("trace"));
        },
      ),
    );
  }
  await Promise.all(tasks);
  if (reviewSource !== undefined) payload.review = reviewSource;
  if (omittedReviewFiles !== undefined) {
    payload.diagnostics.review_omitted_files = omittedReviewFiles;
  }
  if (mapSource !== undefined) payload.map = mapSource;
  if (changedFileDiffs !== undefined) payload.diff = changedFileDiffs;
  if (traceAttachment !== undefined) payload.trace = traceAttachment;
  if (attachmentErrors.length > 0) {
    payload.diagnostics.attachment_errors = attachmentErrors.sort(
      (left, right) => left.attachment.localeCompare(right.attachment),
    );
  }

  const request = buildSizedBugReportRequest(payload, {
    appVersion: input.report.app_version,
    cliVersion,
  });

  const response = await (input.fetchImpl ?? fetch)(BUG_REPORT_URL, {
    method: "POST",
    headers: { "content-type": request.contentType },
    body: request.body,
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  }).catch((error) => {
    throw new BugReportUpstreamError(
      502,
      error instanceof Error ? error.message : "Bug report service failed.",
    );
  });
  const responseBody = await response.json().catch(() => null);
  if (!response.ok) {
    throw new BugReportUpstreamError(
      response.status === 429 || response.status === 413
        ? response.status
        : 502,
      response.status === 429
        ? "Too many reports. Try again later."
        : response.status === 413
          ? "Bug report is too large."
          : "Bug report service failed.",
    );
  }
  const result = parseReviewBugReportResponse(responseBody);
  if (!result.ok) throw new BugReportUpstreamError(502, result.error);
  return result;
}

export function buildSizedBugReportRequest(
  payload: BugReportPayload,
  input: {
    appVersion: string;
    cliVersion: string;
  },
) {
  let truncatedDiff = false;
  let truncatedMap = false;
  let truncatedScreenshot = false;
  let truncatedTrace = payload.trace?.truncated ?? false;
  const traceHarness = payload.trace?.harness;
  const build = () =>
    buildBugReportRequest(payload, {
      ...input,
      truncatedDiff,
      truncatedMap,
      truncatedScreenshot,
      truncatedTrace,
      traceHarness,
    });

  let request = build();
  if (request.body.byteLength > MAX_MULTIPART_BYTES && payload.trace) {
    delete payload.trace;
    truncatedTrace = true;
    request = build();
  }
  if (request.body.byteLength > MAX_MULTIPART_BYTES && payload.diff) {
    delete payload.diff;
    truncatedDiff = true;
    request = build();
  }
  if (request.body.byteLength > MAX_MULTIPART_BYTES && payload.map) {
    delete payload.map;
    truncatedMap = true;
    request = build();
  }
  if (request.body.byteLength > MAX_MULTIPART_BYTES && payload.screenshot) {
    delete payload.screenshot;
    truncatedScreenshot = true;
    request = build();
  }
  if (request.body.byteLength > MAX_MULTIPART_BYTES && payload.review) {
    delete payload.review;
    request = build();
  }
  if (request.body.byteLength > MAX_MULTIPART_BYTES) {
    throw new BugReportUpstreamError(413, "Bug report is too large.");
  }
  return request;
}

// The document is required: a failure to read it makes the attachment
// unavailable. Each TypeScript module is optional, because a report that loses
// one module is still better than a report that loses the review.
async function readReviewSourceFiles(
  documentPath: string,
): Promise<{ files: Record<string, string>; omitted: string[] }> {
  const documentName = path.basename(documentPath);
  const files: Record<string, string> = {
    [documentName]: await readFile(documentPath, "utf8"),
  };
  const omitted: string[] = [];

  const directory = path.dirname(documentPath);
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  );
  const moduleNames = entries
    .filter(
      (entry) => entry.isFile() && REVIEW_SOURCE_MODULE_RE.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort();
  for (const name of moduleNames.slice(MAX_REVIEW_SOURCE_FILES - 1)) {
    omitted.push(name);
  }

  await Promise.all(
    moduleNames.slice(0, MAX_REVIEW_SOURCE_FILES - 1).map(async (name) => {
      if (name === documentName) return;
      const source = await readFile(path.join(directory, name), "utf8").catch(
        () => null,
      );
      // Name what the report drops. A truncated module is invalid TypeScript,
      // and a silently missing one reads during triage as a rendering bug.
      if (
        source === null ||
        Buffer.byteLength(source) > MAX_REVIEW_SOURCE_FILE_BYTES
      ) {
        omitted.push(name);
        return;
      }
      files[name] = source;
    }),
  );
  return { files, omitted: omitted.sort() };
}

async function readHeadSoftwareMap(target: ReviewSourceTarget) {
  if (!target.headRef) return null;
  return (
    (
      await readSoftwareMapSourceForRef({
        repoRootPath: target.repoRoot,
        ref: target.headRef,
        role: "head",
      })
    )?.source ?? null
  );
}

async function readChangedFileDiffs(
  target: ReviewSourceTarget,
): Promise<ReviewDiffFilesResult> {
  return resolveReviewDiffFiles({
    rootPath: target.diffRootPath,
    baseRef: target.baseRef,
    headRef: target.headRef,
    includePatch: true,
  });
}

function buildBugReportRequest(
  payload: BugReportPayload,
  input: {
    appVersion: string;
    cliVersion: string;
    truncatedDiff: boolean;
    truncatedMap: boolean;
    truncatedScreenshot: boolean;
    truncatedTrace: boolean;
    traceHarness?: AuthoringTraceAttachment["harness"];
  },
) {
  const payloadBytes = gzipSync(Buffer.from(JSON.stringify(payload)), {
    level: 9,
  });
  const meta: ReviewBugReportMeta = {
    schema_version: 1,
    description_length: Buffer.byteLength(payload.description),
    has_review: payload.review !== undefined,
    has_map: payload.map !== undefined,
    has_diff: payload.diff !== undefined,
    has_screenshot: payload.screenshot !== undefined,
    ...(input.traceHarness
      ? {
          has_trace: payload.trace !== undefined,
          trace_harness: input.traceHarness,
          truncated_trace: input.truncatedTrace,
        }
      : {}),
    payload_bytes: payloadBytes.byteLength,
    app_version: input.appVersion,
    cli_version: input.cliVersion,
    platform: process.platform,
    truncated_diff: input.truncatedDiff,
    truncated_map: input.truncatedMap,
    truncated_screenshot: input.truncatedScreenshot,
  };
  const body = Buffer.concat([
    Buffer.from(
      `--${MULTIPART_BOUNDARY}\r\nContent-Disposition: form-data; name="meta"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(meta)}\r\n`,
    ),
    Buffer.from(
      `--${MULTIPART_BOUNDARY}\r\nContent-Disposition: form-data; name="payload"; filename="payload.json.gz"\r\nContent-Type: application/gzip\r\n\r\n`,
    ),
    payloadBytes,
    Buffer.from(`\r\n--${MULTIPART_BOUNDARY}--\r\n`),
  ]);
  return {
    body,
    contentType: `multipart/form-data; boundary=${MULTIPART_BOUNDARY}`,
  };
}

function unavailable(attachment: AttachmentName): AttachmentError {
  return { attachment, error: "unavailable" };
}
