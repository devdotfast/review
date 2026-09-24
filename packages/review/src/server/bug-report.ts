import { createHash } from "node:crypto";
import { openAsBlob } from "node:fs";
import { gzipSync } from "node:zlib";

import { type JsonValue } from "@dev.fast/json";
import {
  type ReviewBugReportMetaV2,
  type ReviewBugReportRequest,
  parseReviewBugReportResponse,
} from "@dev.fast/review-protocol";

import { readReviewPackageVersion } from "../package-paths";
import { type PostHogCaptureProperties } from "../posthog-capture-client";
import { type ReviewDiffFilesResult } from "../review-diff-files";
import {
  type AuthoringTraceAttachment,
  type AuthoringTracePayload,
} from "./bug-report-trace";

const BUG_REPORT_URL = "https://bug.dev.fast/api/v2/reports";

const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;

const UPSTREAM_TIMEOUT_MS = 20_000;

const TRACE_UPSTREAM_TIMEOUT_MS = 5 * 60_000;

// Keep room for multipart headers and boundaries below the Worker request cap.
const MAX_MULTIPART_CONTENT_BYTES = 99_000_000;

type AttachmentName = "review" | "map" | "diff" | "trace";

type AttachmentError = {
  attachment: AttachmentName;
  error: "unavailable" | "too_large";
};

export interface BugReportPayload {
  schema_version: 4;
  description: string;
  screenshot?: { mime: "image/jpeg"; base64: string };
  // File name to text. The document alone cannot render: every anchor lives in
  // a sibling TypeScript module.
  review?: Record<string, string>;
  map?: string;
  diff?: ReviewDiffFilesResult;
  trace?: AuthoringTracePayload;
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
    /** The telemetry envelope, so triage can tell channel, environment and surface apart. */
    telemetry?: Record<string, JsonValue>;
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

export interface BugReportSource {
  review(): Promise<{ files: Record<string, string>; omitted: string[] }>;
  map(): Promise<string | null>;
  diff(): Promise<ReviewDiffFilesResult>;
  trace(): Promise<AuthoringTraceAttachment | null>;
}

export async function submitReviewBugReport(input: {
  report: ReviewBugReportRequest;
  clientErrorNames: string[];
  fetchImpl?: typeof fetch;
  source: BugReportSource;
  telemetryEnvelope?: PostHogCaptureProperties;
}) {
  const cliVersion = readReviewPackageVersion();
  const attachmentErrors: AttachmentError[] = [];

  const payload: BugReportPayload = {
    schema_version: 4,
    description: input.report.description,
    diagnostics: {
      app_version: input.report.app_version,
      cli_version: cliVersion,
      platform: process.platform,
      app_session_id: input.report.app_session_id,
      client_error_names: input.clientErrorNames.slice(-20),
    },
  };

  if (input.telemetryEnvelope) {
    payload.diagnostics.telemetry = Object.fromEntries(
      Object.entries(input.telemetryEnvelope).filter(
        (entry): entry is [string, JsonValue] => entry[1] !== undefined,
      ),
    );
  }

  if (input.report.screenshot) payload.screenshot = input.report.screenshot;

  let reviewSource: Record<string, string> | undefined;
  let omittedReviewFiles: string[] | undefined;
  let mapSource: string | undefined;
  let changedFileDiffs: ReviewDiffFilesResult | undefined;
  let traceAttachment: AuthoringTraceAttachment | undefined;
  const tasks: Array<Promise<void>> = [];

  if (input.report.include_review) {
    tasks.push(
      input.source.review().then(
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
      input.source.map().then(
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
      input.source.diff().then(
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
      input.source.trace().then(
        (trace) => {
          if (trace === null) {
            throw new BugReportUpstreamError(
              422,
              "The complete authoring trace is unavailable.",
            );
          }

          traceAttachment = trace;
        },
        () => {
          throw new BugReportUpstreamError(
            422,
            "The complete authoring trace is unavailable.",
          );
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

  if (traceAttachment !== undefined) {
    payload.trace = traceAttachment.payload;
  }

  if (attachmentErrors.length > 0) {
    payload.diagnostics.attachment_errors = attachmentErrors.sort(byAttachment);
  }

  try {
    const request = await buildBugReportRequest(payload, traceAttachment, {
      appVersion: input.report.app_version,
      cliVersion,
    });

    const response = await (input.fetchImpl ?? fetch)(BUG_REPORT_URL, {
      method: "POST",
      body: request.body,
      signal: AbortSignal.timeout(
        traceAttachment ? TRACE_UPSTREAM_TIMEOUT_MS : UPSTREAM_TIMEOUT_MS,
      ),
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
  } finally {
    await traceAttachment?.cleanup().catch(() => {});
  }
}

export async function buildBugReportRequest(
  payload: BugReportPayload,
  trace: AuthoringTraceAttachment | undefined,
  input: {
    appVersion: string;
    cliVersion: string;
    maxPayloadBytes?: number;
  },
): Promise<{ body: FormData }> {
  const maxPayloadBytes = input.maxPayloadBytes ?? MAX_PAYLOAD_BYTES;
  let truncatedDiff = false;
  let truncatedMap = false;
  let truncatedScreenshot = false;
  let traceParts = trace?.parts ?? [];
  let payloadBytes = gzipPayload(payload);

  if (
    payloadBytes.byteLength > maxPayloadBytes &&
    payload.trace &&
    Object.keys(payload.trace.files).length > 0
  ) {
    payload.trace = {
      ...payload.trace,
      files: {},
      omitted_files: [
        ...new Set([
          ...(payload.trace.omitted_files ?? []),
          ...Object.keys(payload.trace.files),
        ]),
      ].sort(),
      truncated: true,
    };
    payloadBytes = gzipPayload(payload);
  }

  if (payloadBytes.byteLength > maxPayloadBytes && payload.diff) {
    delete payload.diff;
    truncatedDiff = true;
    payloadBytes = gzipPayload(payload);
  }

  if (payloadBytes.byteLength > maxPayloadBytes && payload.map) {
    delete payload.map;
    truncatedMap = true;
    payloadBytes = gzipPayload(payload);
  }

  if (payloadBytes.byteLength > maxPayloadBytes && payload.screenshot) {
    delete payload.screenshot;
    truncatedScreenshot = true;
    payloadBytes = gzipPayload(payload);
  }

  if (payloadBytes.byteLength > maxPayloadBytes && payload.review) {
    delete payload.review;
    payloadBytes = gzipPayload(payload);
  }

  if (payloadBytes.byteLength > maxPayloadBytes) {
    throw new BugReportUpstreamError(413, "Bug report is too large.");
  }

  // The trace parts are the only attachment that can outgrow the Worker's
  // request cap on their own. The rest of the report still helps triage, so
  // it goes without the trace instead of being refused.
  const contentBytes = () =>
    traceParts.reduce(
      (total, part) => total + part.bytes,
      payloadBytes.byteLength,
    );

  if (contentBytes() > MAX_MULTIPART_CONTENT_BYTES && payload.trace) {
    traceParts = [];
    delete payload.trace;

    const tooLarge: AttachmentError = {
      attachment: "trace",
      error: "too_large",
    };

    payload.diagnostics.attachment_errors = [
      ...(payload.diagnostics.attachment_errors ?? []),
      tooLarge,
    ].sort(byAttachment);
    payloadBytes = gzipPayload(payload);
  }

  if (contentBytes() > MAX_MULTIPART_CONTENT_BYTES) {
    throw new BugReportUpstreamError(413, "Bug report is too large.");
  }

  const meta: ReviewBugReportMetaV2 = {
    schema_version: 2,
    description_length: Buffer.byteLength(payload.description),
    has_review: payload.review !== undefined,
    has_map: payload.map !== undefined,
    has_diff: payload.diff !== undefined,
    has_screenshot: payload.screenshot !== undefined,
    has_trace: payload.trace !== undefined,
    payload_bytes: payloadBytes.byteLength,
    app_version: input.appVersion,
    cli_version: input.cliVersion,
    platform: process.platform,
    truncated_diff: truncatedDiff,
    truncated_map: truncatedMap,
    truncated_screenshot: truncatedScreenshot,
    truncated_trace: payload.trace?.truncated ?? false,
    parts: [
      {
        field: "payload",
        filename: "payload.json.gz",
        bytes: payloadBytes.byteLength,
        sha256: sha256Bytes(payloadBytes),
      },
      ...traceParts.map((part) => ({
        field: "trace" as const,
        filename: part.filename,
        session_id: part.session_id,
        bytes: part.bytes,
        sha256: part.sha256,
      })),
    ],
  };

  if (payload.description.trim().length > 0) {
    meta.description = payload.description;
  }

  if (payload.trace) meta.trace_harness = payload.trace.harness;
  const form = new FormData();
  form.append("meta", JSON.stringify(meta));
  form.append(
    "payload",
    new Blob([Uint8Array.from(payloadBytes)], { type: "application/gzip" }),
    "payload.json.gz",
  );

  for (const part of traceParts) {
    form.append(
      "trace",
      await openAsBlob(part.path, { type: "application/gzip" }),
      part.filename,
    );
  }

  return { body: form };
}

function gzipPayload(payload: BugReportPayload): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(payload)), { level: 9 });
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// The document is required: a failure to read it makes the attachment
// unavailable. Each TypeScript module is optional, because a report that loses
// one module is still better than a report that loses the review.
function unavailable(attachment: AttachmentName): AttachmentError {
  return { attachment, error: "unavailable" };
}

function byAttachment(left: AttachmentError, right: AttachmentError): number {
  return left.attachment.localeCompare(right.attachment);
}
