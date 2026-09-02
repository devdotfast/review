import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, open, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createGzip } from "node:zlib";

import {
  type ReviewAgentHarness,
  parseAuthoringSessionKey,
} from "../authoring-session";
import {
  codexSessionsRoot,
  findCodexTraceInFiles,
  findLocalTrace,
  indexCodexTraceFiles,
} from "../review-agent-traces";
import { readReviewStoreRecord } from "../review-worktree-target";
import { USER_DATA_REGEXES } from "../telemetry-clean-text";

const MAX_SUBAGENT_TRACE_BYTES = 1024 * 1024;
const MAX_SUBAGENT_TRACES = 10;
const MAX_CODEX_ANCESTRY_DEPTH = 32;
export const MAX_AUTHORING_TRACE_BYTES = 256 * 1024 * 1024;
const MAX_CODEX_METADATA_BYTES = 1024 * 1024;
const MAX_JSONL_RECORD_COMPLETION_BYTES = 1024 * 1024;
const INCOMPLETE_FINAL_LINE_RETRIES = 3;
const INCOMPLETE_FINAL_LINE_RETRY_MS = 50;

export interface AuthoringTracePayload {
  harness: ReviewAgentHarness;
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

interface JsonObject {
  [key: string]: unknown;
}

interface JsonlRecord {
  value: JsonObject;
  raw: string;
  terminator: string;
  ordinal?: number;
}

interface JsonlSnapshot {
  path: string;
  records: JsonlRecord[];
}

interface CodexHistoryBase {
  threadId: string;
  endOrdinalExclusive: number;
}

interface CodexMetadata {
  sessionId: string;
  historyBase?: CodexHistoryBase;
}

interface ResolvedTraceFile {
  sessionId: string;
  path: string;
  snapshotBytes: number;
  endOrdinalExclusive?: number;
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
    const lineage = await resolveTraceLineage(
      sourceSession.harness,
      sourceSession.sessionId,
      localTrace.tracePath,
    );
    const parts: AuthoringTraceUploadPart[] = [];
    for (const entry of lineage) {
      const snapshot = await readJsonlSnapshot(entry.path, entry.snapshotBytes);
      const part = await writeTracePart({
        index: parts.length,
        sessionId: entry.sessionId,
        outputPath: path.join(tempRoot, `trace-${parts.length}.jsonl.gz`),
        snapshot,
        ...(entry.endOrdinalExclusive !== undefined
          ? { endOrdinalExclusive: entry.endOrdinalExclusive }
          : {}),
      });
      if (part) parts.push(part);
    }

    const subagents = await readSubagentAttachments(localTrace.subagentPaths);
    return {
      payload: {
        harness: sourceSession.harness,
        files: subagents.files,
        ...(subagents.omittedFiles.length > 0
          ? { omitted_files: subagents.omittedFiles }
          : {}),
        truncated: subagents.truncated,
      },
      parts,
      cleanup: () => rm(tempRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function resolveTraceLineage(
  harness: ReviewAgentHarness,
  sessionId: string,
  tracePath: string,
): Promise<ResolvedTraceFile[]> {
  if (harness !== "codex") {
    const snapshotBytes = await traceFileSize(tracePath);
    return [{ sessionId, path: tracePath, snapshotBytes }];
  }

  const rollouts = await listFilesRecursive(codexSessionsRoot());
  const rolloutIndex = indexCodexTraceFiles(rollouts);
  const resolvePath = (targetSessionId: string): string => {
    if (targetSessionId === sessionId) return tracePath;
    const resolved =
      rolloutIndex.get(targetSessionId) ??
      findCodexTraceInFiles(rollouts, targetSessionId);
    if (!resolved) throw new Error("Codex trace parent could not be resolved.");
    return resolved;
  };
  const chain: ResolvedTraceFile[] = [];
  const seen = new Set<string>();
  let currentSessionId = sessionId;
  let endOrdinalExclusive: number | undefined;
  while (true) {
    if (seen.has(currentSessionId)) {
      throw new Error("Codex trace ancestry contains a cycle.");
    }
    if (seen.size >= MAX_CODEX_ANCESTRY_DEPTH + 1) {
      throw new Error("Codex trace ancestry exceeds the supported depth.");
    }
    seen.add(currentSessionId);
    const currentPath = resolvePath(currentSessionId);
    const current = await readCodexMetadata(currentPath, currentSessionId);
    chain.push({
      sessionId: current.sessionId,
      path: currentPath,
      snapshotBytes: await traceFileSize(currentPath),
      ...(endOrdinalExclusive !== undefined ? { endOrdinalExclusive } : {}),
    });
    if (!current.historyBase) break;
    endOrdinalExclusive = Math.min(
      endOrdinalExclusive ?? Number.POSITIVE_INFINITY,
      current.historyBase.endOrdinalExclusive,
    );
    currentSessionId = current.historyBase.threadId;
  }
  const lineageBytes = chain.reduce(
    (total, entry) => total + entry.snapshotBytes,
    0,
  );
  if (lineageBytes > MAX_AUTHORING_TRACE_BYTES) {
    throw new Error("Trace lineage exceeds the supported size.");
  }
  return chain;
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
  const handle = await open(filePath, "r");
  try {
    const { size } = await handle.stat();
    if (size <= 0) throw new Error("Trace file is empty.");
    const length = Math.min(size, MAX_CODEX_METADATA_BYTES);
    const bytes = await readBytes(handle, 0, length);
    const newline = bytes.indexOf(0x0a);
    if (newline === -1 && size > length) {
      throw new Error("Codex session metadata is too large.");
    }
    const record = parseJsonl(
      newline === -1 ? bytes : bytes.subarray(0, newline + 1),
    );
    return record[0].value;
  } finally {
    await handle.close();
  }
}

async function traceFileSize(filePath: string): Promise<number> {
  const { size } = await stat(filePath);
  if (size <= 0) throw new Error("Trace file is empty.");
  if (size > MAX_AUTHORING_TRACE_BYTES) {
    throw new Error("Trace lineage exceeds the supported size.");
  }
  return size;
}

async function listFilesRecursive(root: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await listFilesRecursive(entryPath)));
    } else if (entry.isFile()) {
      results.push(entryPath);
    }
  }
  return results.sort();
}

async function readJsonlSnapshot(
  filePath: string,
  snapshotBytes: number,
): Promise<JsonlSnapshot> {
  const handle = await open(filePath, "r");
  try {
    let bytes = await readBytes(handle, 0, snapshotBytes);
    for (let attempt = 0; attempt <= INCOMPLETE_FINAL_LINE_RETRIES; attempt++) {
      if (attempt > 0) {
        await delay(INCOMPLETE_FINAL_LINE_RETRY_MS);
        const currentSize = (await handle.stat()).size;
        if (currentSize > bytes.length) {
          const nextSize = Math.min(
            currentSize,
            bytes.length + MAX_JSONL_RECORD_COMPLETION_BYTES,
          );
          const appended = await readBytes(
            handle,
            bytes.length,
            nextSize - bytes.length,
          );
          const completionEnd = appended.indexOf(0x0a);
          bytes = Buffer.concat([
            bytes,
            completionEnd === -1
              ? appended
              : appended.subarray(0, completionEnd + 1),
          ]);
        }
      }
      try {
        return { path: filePath, records: parseJsonl(bytes) };
      } catch (error) {
        if (!(error instanceof IncompleteFinalRecordError)) throw error;
      }
    }
    throw new Error("Trace file ends with an incomplete JSONL record.");
  } finally {
    await handle.close();
  }
}

async function readBytes(
  handle: Awaited<ReturnType<typeof open>>,
  position: number,
  size: number,
): Promise<Buffer> {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const result = await handle.read(
      bytes,
      offset,
      size - offset,
      position + offset,
    );
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  if (offset !== size) throw new Error("Trace snapshot changed while reading.");
  return bytes;
}

class IncompleteFinalRecordError extends Error {}

function parseJsonl(bytes: Buffer): JsonlRecord[] {
  const records: JsonlRecord[] = [];
  let start = 0;
  while (start < bytes.length) {
    const lineFeed = bytes.indexOf(0x0a, start);
    const end = lineFeed === -1 ? bytes.length : lineFeed + 1;
    const contentEnd = lineFeed === -1 ? end : lineFeed;
    const rawBytes = bytes.subarray(start, contentEnd);
    let raw: string;
    try {
      raw = new TextDecoder("utf-8", { fatal: true }).decode(rawBytes);
    } catch {
      throw new Error("Trace file contains invalid UTF-8.");
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      if (lineFeed === -1) throw new IncompleteFinalRecordError();
      throw new Error("Trace file contains malformed JSONL.");
    }
    if (!isJsonObject(value)) {
      throw new Error("Trace JSONL records must be objects.");
    }
    records.push({
      value,
      raw,
      terminator: lineFeed === -1 ? "" : "\n",
      ...(Number.isSafeInteger(value.ordinal)
        ? { ordinal: value.ordinal as number }
        : {}),
    });
    start = end;
  }
  if (records.length === 0) throw new Error("Trace file is empty.");
  return records;
}

async function writeTracePart(input: {
  index: number;
  sessionId: string;
  outputPath: string;
  snapshot: JsonlSnapshot;
  endOrdinalExclusive?: number;
}): Promise<AuthoringTraceUploadPart | null> {
  const records =
    input.endOrdinalExclusive === undefined
      ? input.snapshot.records
      : input.snapshot.records.filter((record) => {
          if (record.ordinal === undefined || record.ordinal < 0) {
            throw new Error("Codex trace record is missing a valid ordinal.");
          }
          return record.ordinal < input.endOrdinalExclusive!;
        });
  if (records.length === 0) return null;
  const source = Readable.from(
    (async function* () {
      for (const record of records) {
        const redacted = redactTraceText(record.raw) + record.terminator;
        yield Buffer.from(redacted);
      }
    })(),
  );
  await pipeline(
    source,
    createGzip({ level: 9 }),
    createWriteStream(input.outputPath, { mode: 0o600 }),
  );
  const fileStat = await stat(input.outputPath);
  return {
    filename: `trace-${input.index}.jsonl.gz`,
    session_id: input.sessionId,
    path: input.outputPath,
    bytes: fileStat.size,
    sha256: await sha256File(input.outputPath),
  };
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
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

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
