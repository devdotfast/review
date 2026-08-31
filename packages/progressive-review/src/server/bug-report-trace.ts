import { open, stat } from "node:fs/promises";

import {
  type ReviewAgentHarness,
  parseAuthoringSessionKey,
} from "../authoring-session";
import { findLocalTrace } from "../review-agent-traces";
import { readReviewStoreRecord } from "../review-worktree-target";
import { USER_DATA_REGEXES } from "../telemetry-clean-text";

const MAX_TRACE_BYTES = 6 * 1024 * 1024;
const MAX_SUBAGENT_TRACE_BYTES = 1024 * 1024;
const MAX_SUBAGENT_TRACES = 10;

export interface AuthoringTraceAttachment {
  harness: ReviewAgentHarness;
  session_id: string;
  files: Record<string, string>;
  omitted_files?: string[];
  truncated: boolean;
}

const TRACE_SECRET_LABELS = new Set([
  "Google API Key",
  "JWT",
  "Slack Token",
  "GitHub Token",
  "Microsoft Entra ID",
]);

const TRACE_SECRET_REGEXES = USER_DATA_REGEXES.filter(({ label }) =>
  TRACE_SECRET_LABELS.has(label),
).map(({ label, regex }) => ({
  label,
  // The shared Slack and Entra expressions detect that a line should be
  // discarded by telemetry, so they only need to match a token prefix. Bug
  // report traces preserve the rest of the line, which requires consuming the
  // complete token instead.
  regex:
    label === "Slack Token"
      ? /xox[pbar]-[A-Za-z0-9-]+/g
      : label === "Microsoft Entra ID"
        ? /eyJ(?:0eXAiOiJKV1Qi|hbGci)[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g
        : new RegExp(
            regex.source,
            regex.flags.includes("g") ? regex.flags : `${regex.flags}g`,
          ),
}));

export async function readAuthoringTraceAttachment(input: {
  reviewRootPath: string;
}): Promise<AuthoringTraceAttachment | null> {
  const review = readReviewStoreRecord(input.reviewRootPath);
  const sourceSession = parseAuthoringSessionKey(review.sourceSession);
  if (!sourceSession) return null;

  const localTrace = await findLocalTrace(sourceSession.sessionId);
  if (!localTrace) return null;

  const mainTrace = await readTailTraceFile(
    localTrace.tracePath,
    MAX_TRACE_BYTES,
  );
  if (!mainTrace.contents) return null;

  const files: Record<string, string> = {
    "trace.jsonl": mainTrace.contents,
  };
  const subagentPaths = await Promise.all(
    localTrace.subagentPaths.map(async (subagent) => ({
      ...subagent,
      modifiedAt: await stat(subagent.path).then(
        ({ mtimeMs }) => mtimeMs,
        () => Number.NEGATIVE_INFINITY,
      ),
    })),
  );
  subagentPaths.sort(
    (left, right) =>
      right.modifiedAt - left.modifiedAt || left.name.localeCompare(right.name),
  );
  const omittedFiles = subagentPaths
    .slice(MAX_SUBAGENT_TRACES)
    .map(({ name }) => `subagents/${name}`);
  let truncated = mainTrace.truncated || omittedFiles.length > 0;

  const subagentResults = await Promise.all(
    subagentPaths.slice(0, MAX_SUBAGENT_TRACES).map(async ({ name, path }) => {
      const attachmentName = `subagents/${name}`;
      try {
        return {
          attachmentName,
          trace: await readTailTraceFile(path, MAX_SUBAGENT_TRACE_BYTES),
        };
      } catch {
        return { attachmentName, trace: null };
      }
    }),
  );
  for (const result of subagentResults) {
    if (!result.trace) {
      omittedFiles.push(result.attachmentName);
      truncated = true;
      continue;
    }
    files[result.attachmentName] = result.trace.contents;
    truncated ||= result.trace.truncated;
  }

  return {
    harness: sourceSession.harness,
    session_id: sourceSession.sessionId,
    files,
    ...(omittedFiles.length > 0 ? { omitted_files: omittedFiles.sort() } : {}),
    truncated,
  };
}

async function readTailTraceFile(
  filePath: string,
  maxBytes: number,
): Promise<{ contents: string; truncated: boolean }> {
  const handle = await open(filePath, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.byteLength - offset,
        start + offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }

    let tail = buffer.subarray(0, offset);
    const truncated = start > 0;
    if (truncated) {
      const firstLineBreak = tail.indexOf(0x0a);
      tail =
        firstLineBreak === -1
          ? Buffer.alloc(0)
          : tail.subarray(firstLineBreak + 1);
    }
    const decoded = tail.toString("utf8");
    const completeJsonl = retainCompleteJsonlLines(decoded);
    return {
      contents: redactTraceJsonl(completeJsonl),
      truncated: truncated || completeJsonl.length < decoded.length,
    };
  } finally {
    await handle.close();
  }
}

function retainCompleteJsonlLines(contents: string): string {
  if (!contents || contents.endsWith("\n")) return contents;
  const lastLineBreak = contents.lastIndexOf("\n");
  const finalLine = contents.slice(lastLineBreak + 1);
  try {
    JSON.parse(finalLine);
    return contents;
  } catch {
    return lastLineBreak === -1 ? "" : contents.slice(0, lastLineBreak + 1);
  }
}

function redactTraceJsonl(contents: string): string {
  let redacted = contents;
  for (const { label, regex } of TRACE_SECRET_REGEXES) {
    redacted = redacted.replace(regex, `<REDACTED: ${label}>`);
  }
  return redacted;
}
