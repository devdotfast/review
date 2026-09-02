import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { readFileAtRevisionSync } from "@dev.fast/local-vcs";
import {
  CodeThreadTargetSchema,
  type GitLabDiffPosition,
  ReviewRecordSchema,
  gitLabDiffPositionRows,
} from "@dev.fast/review-protocol";

import { writeFileAtomic } from "./atomic-write";
import {
  reviewStateDir,
  reviewThreadStoreBackend,
} from "./review-thread-store-backend";
import type {
  CreateReviewCommentInput,
  ReviewCommentAgentSession,
  ReviewCommentDraftThread,
  ReviewCommentDraftThreadMap,
  ReviewCommentMessage,
  ReviewCommentThreadMap,
  ReviewCommentThreadRecord,
  ReviewSubmissionEvent,
  ThreadTarget,
  UpdateReviewCommentInput,
} from "./types";

// Review comments used to live as an `export const` object inside the review
// MDX. They now live beside the document in a per-review SQLite database.
//
// Concurrency: every mutator here is a synchronous read-modify-write
// (read -> mutate -> write) with no `await` between the read and the write, so
// the single-process one-shot server's event loop serializes them — concurrent
// HTTP handlers can't interleave a stale in-memory copy, and each write is
// atomic in a SQLite transaction. The database supports cross-process writers
// with WAL and busy_timeout.

export { reviewStateDir } from "./review-thread-store-backend";

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

interface ReviewCodeTargetContext {
  rootPath: string;
  baseCommit: string;
  headCommit: string | null;
}

function isLegacyCodeTarget(target: unknown): boolean {
  if (!isObject(target) || target.kind !== "text") return false;
  if (!isObject(target.surface)) return false;
  if (target.surface.type === "native") return true;
  return (
    target.surface.type === "anchor" &&
    isObject(target.surface.part) &&
    target.surface.part.type === "code"
  );
}

function validatePositionAtStoredCommits(
  position: GitLabDiffPosition,
  context: ReviewCodeTargetContext | null,
): boolean {
  if (!context) return false;
  const rows = gitLabDiffPositionRows(position);
  if (!rows) return false;
  const baseCommit = position.base_sha ?? position.start_sha;
  const checks = [
    {
      commit: baseCommit,
      path: position.old_path,
      lines: [rows.start.old_line, rows.end.old_line],
    },
    {
      commit: position.head_sha,
      path: position.new_path,
      lines: [rows.start.new_line, rows.end.new_line],
    },
  ];
  for (const check of checks) {
    const lines = check.lines.filter((line): line is number => line !== null);
    if (lines.length === 0) continue;
    if (!check.commit || !check.path) return false;
    const file = readFileAtRevisionSync({
      rootPath: context.rootPath,
      ref: check.commit,
      relativePath: check.path,
    });
    if (!file || file.commit !== check.commit) return false;
    const normalized = file.source.replace(/\r\n?/g, "\n");
    const lineCount = normalized
      ? normalized.split("\n").length - (normalized.endsWith("\n") ? 1 : 0)
      : 0;
    if (Math.max(...lines) > lineCount) return false;
  }
  return true;
}

function readReviewCodeTargetContext(
  reviewMdxPath: string,
): ReviewCodeTargetContext | null {
  const recordPath = path.join(reviewStateDir(reviewMdxPath), "review.json");
  try {
    const parsed = ReviewRecordSchema.safeParse(
      JSON.parse(readFileSync(recordPath, "utf8")),
    );
    if (!parsed.success) return null;
    return {
      rootPath: parsed.data.worktreePath,
      baseCommit: parsed.data.baseCommit,
      headCommit: parsed.data.sourceCommit,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function requireValidCodeTarget(
  reviewMdxPath: string,
  target: ThreadTarget,
): void {
  if (isLegacyCodeTarget(target)) {
    throw new Error("Legacy code targets cannot be persisted.");
  }
  if (target.kind !== "code") return;
  const parsed = CodeThreadTargetSchema.safeParse(target);
  const context = readReviewCodeTargetContext(reviewMdxPath);
  if (
    !parsed.success ||
    !context?.headCommit ||
    parsed.data.position.base_sha !== context.baseCommit ||
    parsed.data.position.start_sha !== context.baseCommit ||
    parsed.data.position.head_sha !== context.headCommit ||
    !isDeepStrictEqual(parsed.data.original_position, parsed.data.position) ||
    parsed.data.change_position ||
    !validatePositionAtStoredCommits(parsed.data.position, context)
  ) {
    throw new Error(
      "Code target must contain a current text diff position for its review.",
    );
  }
}

function requireValidStoredCodeThreads(
  reviewMdxPath: string,
  threads: Iterable<ReviewCommentThreadRecord>,
): void {
  let context: ReviewCodeTargetContext | null | undefined;
  for (const thread of threads) {
    const target = thread.target;
    if (target.kind !== "code") continue;
    context ??= readReviewCodeTargetContext(reviewMdxPath);
    const activePosition = target.change_position ?? target.position;
    if (
      !context?.headCommit ||
      activePosition.base_sha !== context.baseCommit ||
      activePosition.start_sha !== context.baseCommit ||
      activePosition.head_sha !== context.headCommit ||
      !validatePositionAtStoredCommits(target.original_position, context) ||
      !validatePositionAtStoredCommits(target.position, context)
    ) {
      throw new Error(
        "Stored code thread has an invalid original, current, or change position target.",
      );
    }
  }
}

export function readReviewComments(
  reviewMdxPath: string,
): ReviewCommentThreadMap {
  const comments = reviewThreadStoreBackend(reviewMdxPath).readComments();
  requireValidStoredCodeThreads(reviewMdxPath, Object.values(comments));
  return comments;
}

function writeReviewComments(
  reviewMdxPath: string,
  comments: ReviewCommentThreadMap,
): void {
  reviewThreadStoreBackend(reviewMdxPath).writeComments(comments);
}

export function appendReviewComment(
  reviewMdxPath: string,
  input: CreateReviewCommentInput & { author: string },
): { threadId: string; thread: ReviewCommentThreadRecord } {
  if (!input.threadId.trim()) {
    throw new Error("Comment threadId is required.");
  }
  if (!input.messageId.trim()) {
    throw new Error("Comment messageId is required.");
  }
  if (!input.target?.kind) {
    throw new Error("Comment target is required.");
  }
  const comments = readReviewComments(reviewMdxPath);
  const existing = comments[input.threadId];
  if (existing) {
    // A reply inherits the thread's target, and that target may be outdated.
    // Matching the stored thread is the whole requirement; re-checking it
    // against the current pins would forbid answering an outdated thread.
    if (!isDeepStrictEqual(existing.target, input.target)) {
      throw new Error(
        `Comment thread ${input.threadId} already targets different content.`,
      );
    }
  } else {
    requireValidCodeTarget(reviewMdxPath, input.target);
  }
  if (existing?.messages.some((message) => message.id === input.messageId)) {
    return { threadId: input.threadId, thread: existing };
  }
  const message = {
    id: input.messageId,
    by: input.author,
    at: new Date().toISOString(),
    body: input.body,
    agentInput: input.agentInput ?? false,
  };
  const thread: ReviewCommentThreadRecord = existing
    ? {
        ...existing,
        messages: [...existing.messages, message],
      }
    : {
        threadId: input.threadId,
        target: input.target,
        status: "open",
        messages: [message],
      };
  comments[input.threadId] = thread;
  writeReviewComments(reviewMdxPath, comments);
  return { threadId: input.threadId, thread };
}

export function readReviewCommentDrafts(
  reviewMdxPath: string,
): ReviewCommentDraftThreadMap {
  const drafts = reviewThreadStoreBackend(reviewMdxPath).readCommentDrafts();
  requireValidStoredCodeThreads(
    reviewMdxPath,
    Object.values(drafts).map((draft) => draft.thread),
  );
  return drafts;
}

function writeReviewCommentDrafts(
  reviewMdxPath: string,
  drafts: ReviewCommentDraftThreadMap,
): void {
  reviewThreadStoreBackend(reviewMdxPath).writeCommentDrafts(drafts);
}

export function appendReviewCommentDraft(
  reviewMdxPath: string,
  input: CreateReviewCommentInput & { author: string },
): { threadId: string; draft: ReviewCommentDraftThread } {
  const { author, ...draftInput } = input;
  requireValidCodeTarget(reviewMdxPath, input.target);
  const drafts = readReviewCommentDrafts(reviewMdxPath);
  const persisted = readReviewComments(reviewMdxPath)[input.threadId];
  const existing = drafts[input.threadId];
  const current = existing?.thread ?? persisted;
  if (current && !isDeepStrictEqual(current.target, input.target)) {
    throw new Error(
      `Comment thread ${input.threadId} already targets different content.`,
    );
  }
  if (
    existing?.inputs.some(
      (candidate) => candidate.messageId === input.messageId,
    )
  ) {
    return { threadId: input.threadId, draft: existing };
  }
  const message = {
    id: input.messageId,
    by: author,
    at: new Date().toISOString(),
    body: input.body,
    agentInput: input.agentInput ?? false,
  };
  const thread: ReviewCommentThreadRecord = current
    ? {
        ...current,
        status: "open",
        messages: [...current.messages, message],
      }
    : {
        threadId: input.threadId,
        target: input.target,
        status: "open",
        messages: [message],
      };
  const draft = {
    thread,
    inputs: [...(existing?.inputs ?? []), draftInput],
  } satisfies ReviewCommentDraftThread;
  drafts[input.threadId] = draft;
  writeReviewCommentDrafts(reviewMdxPath, drafts);
  return { threadId: input.threadId, draft };
}

export function updateReviewCommentDraft(
  reviewMdxPath: string,
  threadId: string,
  input: UpdateReviewCommentInput,
): ReviewCommentDraftThread | null {
  const drafts = readReviewCommentDrafts(reviewMdxPath);
  const draft = drafts[threadId];
  if (!draft) return null;
  const messageIndex =
    input.messageId !== undefined
      ? draft.thread.messages.findIndex(
          (message) => message.id === input.messageId,
        )
      : draft.thread.messages.length - 1;
  if (messageIndex < 0) {
    throw new Error(
      `Comment message ${input.messageId ?? "in thread"} does not exist in thread ${threadId}.`,
    );
  }
  const body = input.body?.trim();
  const messageId = draft.thread.messages[messageIndex]?.id;
  const next = {
    thread: {
      ...draft.thread,
      ...(input.status ? { status: input.status } : {}),
      ...(body
        ? {
            messages: draft.thread.messages.map((message, index) =>
              index === messageIndex ? { ...message, body } : message,
            ),
          }
        : {}),
    },
    inputs:
      body && messageId
        ? draft.inputs.map((candidate) =>
            candidate.messageId === messageId
              ? { ...candidate, body }
              : candidate,
          )
        : draft.inputs,
  } satisfies ReviewCommentDraftThread;
  drafts[threadId] = next;
  writeReviewCommentDrafts(reviewMdxPath, drafts);
  return next;
}

export function deleteReviewCommentDraft(
  reviewMdxPath: string,
  threadId: string,
): boolean {
  const drafts = readReviewCommentDrafts(reviewMdxPath);
  if (!drafts[threadId]) return false;
  delete drafts[threadId];
  writeReviewCommentDrafts(reviewMdxPath, drafts);
  return true;
}

export function deleteReviewCommentDraftMessage(
  reviewMdxPath: string,
  threadId: string,
  messageId: string,
): ReviewCommentDraftThread | false | null {
  const drafts = readReviewCommentDrafts(reviewMdxPath);
  const draft = drafts[threadId];
  if (!draft) return false;
  if (!draft.thread.messages.some((message) => message.id === messageId)) {
    throw new Error(
      `Comment message ${messageId} does not exist in thread ${threadId}.`,
    );
  }
  const inputs = draft.inputs.filter((input) => input.messageId !== messageId);
  if (inputs.length === 0) {
    delete drafts[threadId];
    writeReviewCommentDrafts(reviewMdxPath, drafts);
    return null;
  }
  const next = {
    ...draft,
    thread: {
      ...draft.thread,
      messages: draft.thread.messages.filter(
        (message) => message.id !== messageId,
      ),
    },
    inputs,
  } satisfies ReviewCommentDraftThread;
  drafts[threadId] = next;
  writeReviewCommentDrafts(reviewMdxPath, drafts);
  return next;
}

export function submitReviewCommentDrafts(
  reviewMdxPath: string,
  expectedInputs: CreateReviewCommentInput[],
): {
  threads: ReviewCommentThreadRecord[];
  deletedDraftThreadIds: string[];
} {
  const backend = reviewThreadStoreBackend(reviewMdxPath);
  const comments = backend.readComments();
  const drafts = backend.readCommentDrafts();
  const actualInputs = Object.values(drafts).flatMap((draft) => draft.inputs);
  const expectedByMessage = new Map(
    expectedInputs.map((input) => [input.messageId, input]),
  );
  if (
    actualInputs.length !== expectedInputs.length ||
    expectedByMessage.size !== expectedInputs.length ||
    actualInputs.some(
      (input) =>
        !isDeepStrictEqual(expectedByMessage.get(input.messageId), input),
    )
  ) {
    throw new Error("Submitted comments do not match the durable drafts.");
  }
  if (actualInputs.length === 0) {
    return { threads: [], deletedDraftThreadIds: [] };
  }
  const threads = Object.values(drafts).map((draft) => draft.thread);
  requireValidStoredCodeThreads(reviewMdxPath, threads);
  for (const thread of threads) comments[thread.threadId] = thread;
  const deletedDraftThreadIds = Object.keys(drafts);
  backend.writeCommentState(comments, {});
  return { threads, deletedDraftThreadIds };
}

export function appendReviewAgentMessage(
  reviewMdxPath: string,
  threadId: string,
  messageInput: ReviewCommentMessageInput,
):
  | { location: "draft"; draft: ReviewCommentDraftThread }
  | { location: "comment"; thread: ReviewCommentThreadRecord }
  | null {
  const message = normalizeReviewCommentMessage(messageInput);
  const drafts = readReviewCommentDrafts(reviewMdxPath);
  const draft = drafts[threadId];
  if (draft) {
    if (
      draft.thread.messages.some((candidate) => candidate.id === message.id)
    ) {
      return { location: "draft", draft };
    }
    const thread = {
      ...draft.thread,
      messages: [...draft.thread.messages, message],
    } satisfies ReviewCommentThreadRecord;
    const nextDraft = { ...draft, thread };
    drafts[threadId] = nextDraft;
    writeReviewCommentDrafts(reviewMdxPath, drafts);
    return { location: "draft", draft: nextDraft };
  }

  const comments = readReviewComments(reviewMdxPath);
  const comment = comments[threadId];
  if (!comment) return null;
  if (comment.messages.some((candidate) => candidate.id === message.id)) {
    return { location: "comment", thread: comment };
  }
  const thread = {
    ...comment,
    messages: [...comment.messages, message],
  } satisfies ReviewCommentThreadRecord;
  comments[threadId] = thread;
  writeReviewComments(reviewMdxPath, comments);
  return { location: "comment", thread };
}

export function upsertReviewAgentSessionMessage(
  reviewMdxPath: string,
  threadId: string,
  messageInput: ReviewCommentMessageInput,
):
  | {
      location: "draft";
      draft: ReviewCommentDraftThread;
      changed: boolean;
    }
  | {
      location: "comment";
      thread: ReviewCommentThreadRecord;
      changed: boolean;
    }
  | null {
  const message = normalizeReviewCommentMessage(messageInput);
  const drafts = readReviewCommentDrafts(reviewMdxPath);
  const draft = drafts[threadId];
  if (draft) {
    const updated = upsertThreadMessage(draft.thread, message);
    if (!updated.changed) {
      return { location: "draft", draft, changed: false };
    }
    const nextDraft = { ...draft, thread: updated.thread };
    drafts[threadId] = nextDraft;
    writeReviewCommentDrafts(reviewMdxPath, drafts);
    return { location: "draft", draft: nextDraft, changed: true };
  }

  const comments = readReviewComments(reviewMdxPath);
  const comment = comments[threadId];
  if (!comment) return null;
  const updated = upsertThreadMessage(comment, message);
  if (!updated.changed) {
    return { location: "comment", thread: comment, changed: false };
  }
  comments[threadId] = updated.thread;
  writeReviewComments(reviewMdxPath, comments);
  return { location: "comment", thread: updated.thread, changed: true };
}

type ReviewCommentMessageInput = Omit<ReviewCommentMessage, "agentInput"> & {
  agentInput?: boolean;
};

function normalizeReviewCommentMessage(
  message: ReviewCommentMessageInput,
): ReviewCommentMessage {
  return { ...message, agentInput: message.agentInput ?? false };
}

function upsertThreadMessage(
  thread: ReviewCommentThreadRecord,
  message: ReviewCommentMessage,
): { thread: ReviewCommentThreadRecord; changed: boolean } {
  const index = thread.messages.findIndex(
    (candidate) => candidate.id === message.id,
  );
  if (index < 0) {
    return {
      thread: { ...thread, messages: [...thread.messages, message] },
      changed: true,
    };
  }
  const existing = thread.messages[index];
  if (existing && isDeepStrictEqual(existing, message)) {
    return { thread, changed: false };
  }
  return {
    thread: {
      ...thread,
      messages: thread.messages.map((candidate, candidateIndex) =>
        candidateIndex === index ? message : candidate,
      ),
    },
    changed: true,
  };
}

export function setReviewCommentAgentSession(
  reviewMdxPath: string,
  threadId: string,
  agentSession: ReviewCommentAgentSession,
):
  | { location: "draft"; draft: ReviewCommentDraftThread }
  | { location: "comment"; thread: ReviewCommentThreadRecord }
  | null {
  const drafts = readReviewCommentDrafts(reviewMdxPath);
  const draft = drafts[threadId];
  if (draft) {
    const nextDraft = {
      ...draft,
      thread: { ...draft.thread, agentSession },
    } satisfies ReviewCommentDraftThread;
    drafts[threadId] = nextDraft;
    writeReviewCommentDrafts(reviewMdxPath, drafts);
    return { location: "draft", draft: nextDraft };
  }

  const comments = readReviewComments(reviewMdxPath);
  const thread = comments[threadId];
  if (!thread) return null;
  const nextThread = {
    ...thread,
    agentSession,
  } satisfies ReviewCommentThreadRecord;
  comments[threadId] = nextThread;
  writeReviewComments(reviewMdxPath, comments);
  return { location: "comment", thread: nextThread };
}

export function updateReviewComment(
  reviewMdxPath: string,
  threadId: string,
  input: UpdateReviewCommentInput,
): boolean {
  const comments = readReviewComments(reviewMdxPath);
  const thread = comments[threadId];
  if (!thread) return false;
  const messageIndex =
    input.messageId !== undefined
      ? thread.messages.findIndex((message) => message.id === input.messageId)
      : thread.messages.length - 1;
  if (input.messageId !== undefined && messageIndex < 0) {
    throw new Error(
      `Comment message ${input.messageId} does not exist in thread ${threadId}.`,
    );
  }
  const body = input.body?.trim();
  comments[threadId] = {
    ...thread,
    ...(input.status ? { status: input.status } : {}),
    ...(body
      ? {
          messages: thread.messages.map((message, index) =>
            index === messageIndex ? { ...message, body } : message,
          ),
        }
      : {}),
  };
  writeReviewComments(reviewMdxPath, comments);
  return true;
}

export function deleteReviewComment(
  reviewMdxPath: string,
  threadId: string,
): boolean {
  const comments = readReviewComments(reviewMdxPath);
  if (!comments[threadId]) return false;
  delete comments[threadId];
  writeReviewComments(reviewMdxPath, comments);
  return true;
}

export function deleteReviewCommentMessage(
  reviewMdxPath: string,
  threadId: string,
  messageId: string,
): boolean {
  const comments = readReviewComments(reviewMdxPath);
  const thread = comments[threadId];
  if (!thread) return false;
  const messageIndex = thread.messages.findIndex(
    (message) => message.id === messageId,
  );
  if (messageIndex < 0) {
    throw new Error(
      `Comment message ${messageId} does not exist in thread ${threadId}.`,
    );
  }
  if (thread.messages.length === 1) {
    delete comments[threadId];
  } else {
    comments[threadId] = {
      ...thread,
      messages: thread.messages.filter((_, index) => index !== messageIndex),
    };
  }
  writeReviewComments(reviewMdxPath, comments);
  return true;
}

// ---------------------------------------------------------------------------
// History + submission audit (Phase 4)
//
// Version history of the review document (numbered, deduplicated snapshots) plus
// a durable audit trail of every submission — recovering what deleting the old
// submissions/ queue removed. Ported from Plannotator's saveToHistory dedup.
// ---------------------------------------------------------------------------

export function reviewHistoryDir(reviewMdxPath: string): string {
  return path.join(reviewStateDir(reviewMdxPath), "history");
}

export function reviewHistoryDocDir(reviewMdxPath: string): string {
  return path.join(reviewHistoryDir(reviewMdxPath), "doc");
}

export function reviewHistorySubmissionsDir(reviewMdxPath: string): string {
  return path.join(reviewHistoryDir(reviewMdxPath), "submissions");
}

// Highest existing NNN.mdx snapshot + 1 (1 when none exist).
function nextDocHistoryVersion(dir: string): number {
  let max = 0;
  try {
    for (const entry of readdirSync(dir)) {
      const match = /^(\d+)\.mdx$/.exec(entry);
      if (match) {
        const num = Number.parseInt(match[1], 10);
        if (num > max) max = num;
      }
    }
  } catch {
    return 1;
  }
  return max + 1;
}

/**
 * Snapshot the review document into history/doc/NNN.mdx, skipping the write when
 * the latest snapshot is byte-identical (so re-running a review with no doc
 * change doesn't accumulate duplicate versions).
 */
export function saveReviewDocHistory(
  reviewMdxPath: string,
  content: string,
): { version: number; path: string; isNew: boolean } {
  const dir = reviewHistoryDocDir(reviewMdxPath);
  const nextVersion = nextDocHistoryVersion(dir);
  if (nextVersion > 1) {
    const latestPath = path.join(
      dir,
      `${String(nextVersion - 1).padStart(3, "0")}.mdx`,
    );
    try {
      if (readFileSync(latestPath, "utf8") === content) {
        return { version: nextVersion - 1, path: latestPath, isNew: false };
      }
    } catch {
      // Latest snapshot unreadable — fall through and write a fresh one.
    }
  }
  const filePath = path.join(
    dir,
    `${String(nextVersion).padStart(3, "0")}.mdx`,
  );
  writeFileAtomic(filePath, content, "utf8");
  return { version: nextVersion, path: filePath, isNew: true };
}

/**
 * Append a submission to the durable audit trail
 * (history/submissions/{createdAt}-{id}.json). Pure audit — never read back by
 * the runtime.
 */
export function saveReviewSubmissionAudit(
  reviewMdxPath: string,
  event: ReviewSubmissionEvent,
): string {
  const createdAtSlug = event.createdAt.replace(/[:.]/g, "-");
  const idSlug = event.id.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
  const filePath = path.join(
    reviewHistorySubmissionsDir(reviewMdxPath),
    `${createdAtSlug}-${idSlug}.json`,
  );
  writeFileAtomic(filePath, `${JSON.stringify(event, null, 2)}\n`, "utf8");
  return filePath;
}
