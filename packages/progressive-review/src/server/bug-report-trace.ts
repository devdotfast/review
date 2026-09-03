import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

import {
  type JsonObject,
  isJsonObject,
  parseJsonText,
} from "@dev.fast/review-protocol";

import {
  type ReviewAgentHarness,
  parseAuthoringSessionKey,
} from "../authoring-session";
import {
  codexSessionsRoot,
  findLocalTrace,
  indexCodexTraceFiles,
  listFilesRecursive,
} from "../review-agent-traces";
import { readReviewStoreRecord } from "../review-worktree-target";
import { USER_DATA_REGEXES } from "../telemetry-clean-text";

const MAX_SUBAGENT_TRACE_BYTES = 5 * 1024 * 1024;
const MAX_SUBAGENT_TRACES = 10;
const MAX_CODEX_ANCESTRY_DEPTH = 32;
export const MAX_AUTHORING_TRACE_BYTES = 256 * 1024 * 1024;
const MAX_CODEX_METADATA_BYTES = 1024 * 1024;
const TRACE_READ_CHUNK_BYTES = 1024 * 1024;

export interface AuthoringTracePayload {
  harness: ReviewAgentHarness;
  session_id: string;
  files: Record<string, string>;
  omitted_files?: string[];
  truncated: boolean;
}

export interface AuthoringTraceUploadPart {
  filename: string;
  session_id: string;
  path: string;
  bytes: number;
  sha256: string;
}

export interface AuthoringTraceAttachment {
  payload: AuthoringTracePayload;
  parts: AuthoringTraceUploadPart[];
  cleanup: () => Promise<void>;
}

interface CodexHistoryBase {
  threadId: string;
  endOrdinalExclusive: number;
}

interface CodexMetadata {
  sessionId: string;
  historyBase?: CodexHistoryBase;
}

const TRACE_SECRET_LABELS = [
  "Google API Key",
  "Microsoft Entra ID",
  "JWT",
  "Slack Token",
  "GitHub Token",
] as const;

const TRACE_SECRET_REGEXES = TRACE_SECRET_LABELS.map((label) => {
  const entry = USER_DATA_REGEXES.find(
    (candidate) => candidate.label === label,
  );
  if (!entry) throw new Error(`Missing trace secret redaction for ${label}.`);
  return {
    label,
    // Shared telemetry only needs to detect these values. Trace reports retain
    // their lines, so these expressions must consume the complete secret.
    regex:
      label === "Slack Token"
        ? /xox[pbar]-[A-Za-z0-9-]+/g
        : label === "Microsoft Entra ID"
          ? /eyJ(?:0eXAiOiJKV1Qi|hbGci)[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g
          : new RegExp(
              entry.regex.source,
              entry.regex.flags.includes("g")
                ? entry.regex.flags
                : `${entry.regex.flags}g`,
            ),
  };
});

export async function readAuthoringTraceAttachment(input: {
  reviewRootPath: string;
}): Promise<AuthoringTraceAttachment | null> {
  const review = readReviewStoreRecord(input.reviewRootPath);
  const sourceSession = parseAuthoringSessionKey(review.sourceSession);
  if (!sourceSession) return null;

  const localTrace = await findLocalTrace(sourceSession.sessionId);
  if (!localTrace) return null;

  const tempRoot = await mkdtemp(path.join(tmpdir(), "review-bug-trace-"));
  try {
    const lineage = await writeTraceLineage({
      harness: sourceSession.harness,
      sessionId: sourceSession.sessionId,
      tracePath: localTrace.tracePath,
      tempRoot,
    });
    const subagents = await readSubagentAttachments(localTrace.subagentPaths);
    const omittedFiles = [
      ...lineage.omittedFiles,
      ...subagents.omittedFiles,
    ].sort();
    return {
      payload: {
        harness: sourceSession.harness,
        session_id: sourceSession.sessionId,
        files: subagents.files,
        ...(omittedFiles.length > 0 ? { omitted_files: omittedFiles } : {}),
        truncated: lineage.truncated || subagents.truncated,
      },
      parts: lineage.parts,
      cleanup: () => rm(tempRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

// The source session's own trace is required: a report that opted into the
// trace fails without it. Ancestors are best effort. The report keeps the
// parts it has written and names the first ancestor it could not include.
async function writeTraceLineage(input: {
  harness: ReviewAgentHarness;
  sessionId: string;
  tracePath: string;
  tempRoot: string;
}): Promise<{
  parts: AuthoringTraceUploadPart[];
  omittedFiles: string[];
  truncated: boolean;
}> {
  const parts: AuthoringTraceUploadPart[] = [];
  const omittedFiles: string[] = [];
  let truncated = false;
  const resolveRollout =
    input.harness === "codex"
      ? codexRolloutResolver(input.sessionId, input.tracePath)
      : undefined;
  const seen = new Set<string>();
  let sessionId = input.sessionId;
  let lineageBytes = 0;
  let endOrdinalExclusive: number | undefined;
  while (true) {
    let historyBase: CodexHistoryBase | undefined;
    try {
      if (seen.has(sessionId)) {
        throw new Error("Codex trace ancestry contains a cycle.");
      }
      if (seen.size > MAX_CODEX_ANCESTRY_DEPTH) {
        throw new Error("Codex trace ancestry exceeds the supported depth.");
      }
      seen.add(sessionId);
      const sourcePath = resolveRollout
        ? resolveRollout(sessionId)
        : input.tracePath;
      const snapshotBytes = await traceFileSize(sourcePath);
      lineageBytes += snapshotBytes;
      if (lineageBytes > MAX_AUTHORING_TRACE_BYTES) {
        throw new Error("Trace lineage exceeds the supported size.");
      }
      if (resolveRollout) {
        historyBase = (await readCodexMetadata(sourcePath, sessionId))
          .historyBase;
      }
      const written = await writeTracePart({
        index: parts.length,
        sessionId,
        sourcePath,
        snapshotBytes,
        outputPath: path.join(input.tempRoot, `trace-${parts.length}.jsonl.gz`),
        ...(endOrdinalExclusive !== undefined ? { endOrdinalExclusive } : {}),
      });
      truncated ||= written.truncated;
      if (written.part) parts.push(written.part);
      else if (parts.length === 0) throw new Error("Trace file is empty.");
    } catch (error) {
      if (parts.length === 0) throw error;
      omittedFiles.push(`ancestors/${sessionId}.jsonl`);
      truncated = true;
      break;
    }
    if (!historyBase) break;
    endOrdinalExclusive = Math.min(
      endOrdinalExclusive ?? Number.POSITIVE_INFINITY,
      historyBase.endOrdinalExclusive,
    );
    sessionId = historyBase.threadId;
  }
  return { parts, omittedFiles, truncated };
}

function codexRolloutResolver(
  sessionId: string,
  tracePath: string,
): (targetSessionId: string) => string {
  let index: Map<string, string> | undefined;
  return (targetSessionId) => {
    if (targetSessionId === sessionId) return tracePath;
    index ??= indexCodexTraceFiles(listFilesRecursive(codexSessionsRoot()));
    const resolved = index.get(targetSessionId);
    if (!resolved) throw new Error("Codex trace parent could not be resolved.");
    return resolved;
  };
}

async function readCodexMetadata(
  filePath: string,
  sessionId: string,
): Promise<CodexMetadata> {
  const first = await readFirstJsonlRecord(filePath);
  if (first.type !== "session_meta") {
    throw new Error("Codex trace does not start with session metadata.");
  }
  const payload = objectValue(first.payload);
  if (payload?.id !== sessionId) {
    throw new Error("Codex trace metadata does not match its session id.");
  }
  const historyBaseValue = objectValue(payload.history_base);
  let historyBase: CodexHistoryBase | undefined;
  if (payload.history_base !== undefined) {
    if (!historyBaseValue) {
      throw new Error("Codex history base is malformed.");
    }
    const threadId = stringValue(historyBaseValue.thread_id);
    const endOrdinalExclusive = integerValue(
      historyBaseValue.end_ordinal_exclusive,
    );
    if (!threadId || endOrdinalExclusive === undefined) {
      throw new Error("Codex history base is malformed.");
    }
    historyBase = { threadId, endOrdinalExclusive };
  }

  return {
    sessionId,
    ...(historyBase ? { historyBase } : {}),
  };
}

async function readFirstJsonlRecord(filePath: string): Promise<JsonObject> {
  for await (const line of readJsonlLines(filePath, MAX_CODEX_METADATA_BYTES)) {
    if (line.trim() === "") continue;
    const value = parseJsonObject(line);
    if (!value) throw new Error("Codex session metadata is malformed.");
    return value;
  }
  throw new Error("Trace file is empty.");
}

async function traceFileSize(filePath: string): Promise<number> {
  const { size } = await stat(filePath);
  if (size <= 0) throw new Error("Trace file is empty.");
  if (size > MAX_AUTHORING_TRACE_BYTES) {
    throw new Error("Trace lineage exceeds the supported size.");
  }
  return size;
}

// Yields each line without its line feed. Reads at most `byteLimit` bytes, so
// a trace that grows during the read stays at its measured snapshot. A final
// line cut by that limit, or one the harness is still writing, is yielded
// as-is and fails to parse.
async function* readJsonlLines(
  filePath: string,
  byteLimit: number,
): AsyncGenerator<string> {
  const handle = await open(filePath, "r");
  try {
    let carry = Buffer.alloc(0);
    let position = 0;
    while (position < byteLimit) {
      const chunk = Buffer.alloc(
        Math.min(TRACE_READ_CHUNK_BYTES, byteLimit - position),
      );
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const buffer = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
      let start = 0;
      while (true) {
        const lineFeed = buffer.indexOf(0x0a, start);
        if (lineFeed === -1) break;
        yield buffer.subarray(start, lineFeed).toString("utf8");
        start = lineFeed + 1;
      }
      carry = buffer.subarray(start);
    }
    if (carry.length > 0) yield carry.toString("utf8");
  } finally {
    await handle.close();
  }
}

async function writeTracePart(input: {
  index: number;
  sessionId: string;
  sourcePath: string;
  snapshotBytes: number;
  outputPath: string;
  endOrdinalExclusive?: number;
}): Promise<{ part: AuthoringTraceUploadPart | null; truncated: boolean }> {
  let records = 0;
  let truncated = false;
  const source = Readable.from(
    (async function* () {
      for await (const line of readJsonlLines(
        input.sourcePath,
        input.snapshotBytes,
      )) {
        if (line.trim() === "") continue;
        const value = parseJsonObject(line);
        if (!value) {
          // A record the harness has not finished writing, or one a crash cut
          // short. The report drops it and says so instead of failing.
          truncated = true;
          continue;
        }
        if (input.endOrdinalExclusive !== undefined) {
          const ordinal = integerValue(value.ordinal);
          if (ordinal === undefined) {
            throw new Error("Codex trace record is missing a valid ordinal.");
          }
          // Ordinals only grow, so the first post-fork record ends the part.
          if (ordinal >= input.endOrdinalExclusive) break;
        }
        records += 1;
        yield Buffer.from(redactTraceText(line) + "\n");
      }
    })(),
  );
  const hash = createHash("sha256");
  let bytes = 0;
  await pipeline(
    source,
    createGzip({ level: 9 }),
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        bytes += chunk.length;
        callback(null, chunk);
      },
    }),
    createWriteStream(input.outputPath, { mode: 0o600 }),
  );
  if (records === 0) return { part: null, truncated };
  return {
    part: {
      filename: `trace-${input.index}.jsonl.gz`,
      session_id: input.sessionId,
      path: input.outputPath,
      bytes,
      sha256: hash.digest("hex"),
    },
    truncated,
  };
}

async function readSubagentAttachments(
  paths: Array<{ name: string; path: string }>,
): Promise<{
  files: Record<string, string>;
  omittedFiles: string[];
  truncated: boolean;
}> {
  const candidates = await Promise.all(
    paths.map(async (subagent) => ({
      ...subagent,
      modifiedAt: await stat(subagent.path).then(
        ({ mtimeMs }) => mtimeMs,
        () => Number.NEGATIVE_INFINITY,
      ),
    })),
  );
  candidates.sort(
    (left, right) =>
      right.modifiedAt - left.modifiedAt || left.name.localeCompare(right.name),
  );
  const omittedFiles = candidates
    .slice(MAX_SUBAGENT_TRACES)
    .map(({ name }) => `subagents/${name}`);
  const files: Record<string, string> = {};
  let truncated = omittedFiles.length > 0;
  const results = await Promise.all(
    candidates.slice(0, MAX_SUBAGENT_TRACES).map(async ({ name, path }) => {
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
  for (const result of results) {
    if (!result.trace) {
      omittedFiles.push(result.attachmentName);
      truncated = true;
      continue;
    }
    files[result.attachmentName] = result.trace.contents;
    truncated ||= result.trace.truncated;
  }
  return { files, omittedFiles: omittedFiles.sort(), truncated };
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
      contents: redactTraceText(completeJsonl),
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

function redactTraceText(contents: string): string {
  let redacted = contents;
  for (const { label, regex } of TRACE_SECRET_REGEXES) {
    redacted = redacted.replace(regex, `<REDACTED: ${label}>`);
  }
  return redacted;
}

function parseJsonObject(line: string): JsonObject | undefined {
  try {
    return objectValue(parseJsonText(line));
  } catch {
    return undefined;
  }
}

function objectValue(value: unknown): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function integerValue(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : undefined;
}
