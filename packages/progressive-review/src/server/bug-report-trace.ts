import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, open, readdir, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createGzip } from "node:zlib";

import {
  type ReviewAgentHarness,
  parseAuthoringSessionKey,
} from "../authoring-session";
import { findLocalTrace, traceEnvValue } from "../review-agent-traces";
import { readReviewStoreRecord } from "../review-worktree-target";
import { USER_DATA_REGEXES } from "../telemetry-clean-text";

const MAX_SUBAGENT_TRACE_BYTES = 1024 * 1024;
const MAX_SUBAGENT_TRACES = 10;
const MAX_CODEX_ANCESTRY_DEPTH = 32;
const INCOMPLETE_FINAL_LINE_RETRIES = 3;
const INCOMPLETE_FINAL_LINE_RETRY_MS = 50;

export interface AuthoringTracePayload {
  harness: ReviewAgentHarness;
  session_id: string;
  parent_session_id?: string;
  files: Record<string, string>;
  omitted_files?: string[];
  truncated: boolean;
}

export interface AuthoringTraceUploadPart {
  field: "source_trace" | "parent_trace";
  filename: "source.jsonl.gz" | "parent.jsonl.gz";
  session_id: string;
  path: string;
  bytes: number;
  sha256: string;
  uncompressed_bytes: number;
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
  start: number;
  end: number;
  ordinal?: number;
}

interface JsonlSnapshot {
  path: string;
  bytes: Buffer;
  records: JsonlRecord[];
  sessionId?: string;
}

interface CodexHistoryBase {
  threadId: string;
  endOrdinalExclusive: number;
  endByteOffset: number;
}

interface CodexSnapshot extends JsonlSnapshot {
  sessionId: string;
  forkedFromId?: string;
  forkedFromOrdinalExclusive?: number;
  historyBase?: CodexHistoryBase;
}

interface SnapshotSegment {
  snapshot: JsonlSnapshot;
  endByteOffset: number;
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
  // Shared telemetry only needs to detect these values. Trace reports retain
  // their lines, so these expressions must consume the complete secret.
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

  const tempRoot = await mkdtemp(path.join(tmpdir(), "review-bug-trace-"));
  try {
    const parts: AuthoringTraceUploadPart[] = [];
    let parentSessionId: string | undefined;

    if (sourceSession.harness === "codex") {
      const source = await resolveCodexSnapshot(sourceSession.sessionId);
      if (path.resolve(source.path) !== path.resolve(localTrace.tracePath)) {
        throw new Error("Codex source trace resolution is ambiguous.");
      }
      parts.push(
        await writeTracePart({
          field: "source_trace",
          filename: "source.jsonl.gz",
          sessionId: source.sessionId,
          outputPath: path.join(tempRoot, "source.jsonl.gz"),
          segments: [{ snapshot: source, endByteOffset: source.bytes.length }],
          requireContiguousOrdinals: true,
        }),
      );

      if (source.historyBase) {
        validateForkMetadata(source);
        parentSessionId = source.historyBase.threadId;
        const parent = await resolveCodexSnapshot(parentSessionId);
        validateHistoryBoundary(source, parent);
        const parentSegments = await materializeCodexHistory(
          parent,
          new Set([source.sessionId]),
          1,
        );
        parts.push(
          await writeTracePart({
            field: "parent_trace",
            filename: "parent.jsonl.gz",
            sessionId: parent.sessionId,
            outputPath: path.join(tempRoot, "parent.jsonl.gz"),
            segments: parentSegments,
            requireContiguousOrdinals: true,
          }),
        );
      }
    } else {
      const source = await readJsonlSnapshot(localTrace.tracePath);
      parts.push(
        await writeTracePart({
          field: "source_trace",
          filename: "source.jsonl.gz",
          sessionId: sourceSession.sessionId,
          outputPath: path.join(tempRoot, "source.jsonl.gz"),
          segments: [{ snapshot: source, endByteOffset: source.bytes.length }],
          requireContiguousOrdinals: false,
        }),
      );
    }

    const subagents = await readSubagentAttachments(localTrace.subagentPaths);
    return {
      payload: {
        harness: sourceSession.harness,
        session_id: sourceSession.sessionId,
        ...(parentSessionId ? { parent_session_id: parentSessionId } : {}),
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
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

async function materializeCodexHistory(
  snapshot: CodexSnapshot,
  seen: Set<string>,
  depth: number,
): Promise<SnapshotSegment[]> {
  if (depth > MAX_CODEX_ANCESTRY_DEPTH) {
    throw new Error("Codex trace ancestry exceeds the supported depth.");
  }
  if (seen.has(snapshot.sessionId)) {
    throw new Error("Codex trace ancestry contains a cycle.");
  }
  const nextSeen = new Set(seen).add(snapshot.sessionId);
  const segments: SnapshotSegment[] = [];
  if (snapshot.historyBase) {
    validateForkMetadata(snapshot);
    const parent = await resolveCodexSnapshot(snapshot.historyBase.threadId);
    validateHistoryBoundary(snapshot, parent);
    segments.push(
      ...(await materializeCodexHistory(parent, nextSeen, depth + 1)),
    );
    const baseSegment = segments.at(-1);
    if (!baseSegment || baseSegment.snapshot.sessionId !== parent.sessionId) {
      throw new Error("Codex parent history did not materialize correctly.");
    }
    baseSegment.endByteOffset = snapshot.historyBase.endByteOffset;
  }
  segments.push({ snapshot, endByteOffset: snapshot.bytes.length });
  return segments;
}

function validateForkMetadata(snapshot: CodexSnapshot): void {
  const base = snapshot.historyBase;
  if (!base) return;
  if (
    snapshot.forkedFromId !== base.threadId ||
    snapshot.forkedFromOrdinalExclusive !== base.endOrdinalExclusive
  ) {
    throw new Error("Codex fork metadata does not match its history base.");
  }
  if (snapshot.records[0]?.ordinal !== base.endOrdinalExclusive) {
    throw new Error("Codex child trace starts at the wrong ordinal.");
  }
}

function validateHistoryBoundary(
  child: CodexSnapshot,
  parent: CodexSnapshot,
): void {
  const base = child.historyBase;
  if (!base) return;
  if (base.endByteOffset <= 0 || base.endByteOffset > parent.bytes.length) {
    throw new Error("Codex parent byte offset is outside the trace snapshot.");
  }
  const boundaryRecord = parent.records.find(
    (record) => record.end === base.endByteOffset,
  );
  if (
    !boundaryRecord ||
    boundaryRecord.terminator !== "\n" ||
    boundaryRecord.ordinal !== base.endOrdinalExclusive - 1
  ) {
    throw new Error("Codex parent byte offset is not an ordinal boundary.");
  }
}

async function resolveCodexSnapshot(sessionId: string): Promise<CodexSnapshot> {
  const codexRoot =
    traceEnvValue("TRACE_CODEX_SESSIONS_ROOT") ||
    path.join(homedir(), ".codex", "sessions");
  const suffix = `-${sessionId}.jsonl`;
  const candidates = (await listFilesRecursive(codexRoot)).filter((entry) => {
    const name = path.basename(entry);
    return name.startsWith("rollout-") && name.endsWith(suffix);
  });
  if (candidates.length !== 1) {
    throw new Error("Codex trace resolution requires exactly one rollout.");
  }

  const snapshot = await readJsonlSnapshot(candidates[0]);
  const first = snapshot.records[0];
  if (first?.value.type !== "session_meta") {
    throw new Error("Codex trace does not start with session metadata.");
  }
  const payload = objectValue(first.value.payload);
  if (payload?.id !== sessionId) {
    throw new Error("Codex trace metadata does not match its session id.");
  }
  for (const record of snapshot.records) {
    if (!Number.isSafeInteger(record.ordinal) || (record.ordinal ?? -1) < 0) {
      throw new Error("Codex trace record is missing a valid ordinal.");
    }
  }
  validateContiguousOrdinals(snapshot.records);

  const historyBaseValue = objectValue(payload.history_base);
  const forkedFromId = stringValue(payload.forked_from_id);
  const forkedFromOrdinalExclusive = integerValue(
    payload.forked_from_ordinal_exclusive,
  );
  let historyBase: CodexHistoryBase | undefined;
  if (historyBaseValue) {
    const threadId = stringValue(historyBaseValue.thread_id);
    const endOrdinalExclusive = integerValue(
      historyBaseValue.end_ordinal_exclusive,
    );
    const endByteOffset = integerValue(historyBaseValue.end_byte_offset);
    if (
      !threadId ||
      endOrdinalExclusive === undefined ||
      endByteOffset === undefined
    ) {
      throw new Error("Codex history base is malformed.");
    }
    historyBase = { threadId, endOrdinalExclusive, endByteOffset };
  }
  const hasPartialForkMetadata =
    historyBase !== undefined ||
    forkedFromId !== undefined ||
    forkedFromOrdinalExclusive !== undefined;
  if (
    hasPartialForkMetadata &&
    (!historyBase || !forkedFromId || forkedFromOrdinalExclusive === undefined)
  ) {
    throw new Error("Codex fork metadata is incomplete.");
  }

  return {
    ...snapshot,
    sessionId,
    ...(forkedFromId ? { forkedFromId } : {}),
    ...(forkedFromOrdinalExclusive !== undefined
      ? { forkedFromOrdinalExclusive }
      : {}),
    ...(historyBase ? { historyBase } : {}),
  };
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

async function readJsonlSnapshot(filePath: string): Promise<JsonlSnapshot> {
  const handle = await open(filePath, "r");
  try {
    const initialSize = (await handle.stat()).size;
    if (initialSize <= 0) throw new Error("Trace file is empty.");
    let bytes = await readBytes(handle, initialSize);
    try {
      return { path: filePath, bytes, records: parseJsonl(bytes) };
    } catch (error) {
      if (!(error instanceof IncompleteFinalRecordError)) throw error;
    }

    for (let attempt = 0; attempt < INCOMPLETE_FINAL_LINE_RETRIES; attempt++) {
      await delay(INCOMPLETE_FINAL_LINE_RETRY_MS);
      const currentSize = (await handle.stat()).size;
      if (currentSize <= initialSize) continue;
      const currentBytes = await readBytes(handle, currentSize);
      const completionEnd = currentBytes.indexOf(0x0a, initialSize);
      bytes =
        completionEnd === -1
          ? currentBytes
          : currentBytes.subarray(0, completionEnd + 1);
      try {
        return { path: filePath, bytes, records: parseJsonl(bytes) };
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
  size: number,
): Promise<Buffer> {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const result = await handle.read(bytes, offset, size - offset, offset);
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
      start,
      end,
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
  field: AuthoringTraceUploadPart["field"];
  filename: AuthoringTraceUploadPart["filename"];
  sessionId: string;
  outputPath: string;
  segments: SnapshotSegment[];
  requireContiguousOrdinals: boolean;
}): Promise<AuthoringTraceUploadPart> {
  let uncompressedBytes = 0;
  let previousOrdinal: number | undefined;
  const source = Readable.from(
    (async function* () {
      for (const segment of input.segments) {
        const records = segment.snapshot.records.filter(
          (record) => record.end <= segment.endByteOffset,
        );
        if (records.at(-1)?.end !== segment.endByteOffset) {
          throw new Error("Trace segment does not end on a record boundary.");
        }
        for (const record of records) {
          if (input.requireContiguousOrdinals) {
            if (record.ordinal === undefined) {
              throw new Error("Codex trace record is missing an ordinal.");
            }
            if (
              previousOrdinal !== undefined &&
              record.ordinal !== previousOrdinal + 1
            ) {
              throw new Error("Codex trace ordinals are not contiguous.");
            }
            previousOrdinal = record.ordinal;
          }
          const redacted = redactTraceText(record.raw) + record.terminator;
          uncompressedBytes += Buffer.byteLength(redacted);
          yield Buffer.from(redacted);
        }
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
    field: input.field,
    filename: input.filename,
    session_id: input.sessionId,
    path: input.outputPath,
    bytes: fileStat.size,
    sha256: await sha256File(input.outputPath),
    uncompressed_bytes: uncompressedBytes,
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

function validateContiguousOrdinals(records: JsonlRecord[]): void {
  for (let index = 1; index < records.length; index++) {
    if (records[index].ordinal !== (records[index - 1].ordinal ?? -2) + 1) {
      throw new Error("Codex trace ordinals are not contiguous.");
    }
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
