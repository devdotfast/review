import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  type JsonObject,
  jsonObject,
  jsonString,
  parseJsonText,
} from "@dev.fast/review-protocol";

import { reviewCommentPromptPrefix } from "../review-comment-agent";
import {
  findClaudeTranscript,
  projectClaudeReviewMessages,
} from "./claude-transcript";
import { projectCodexTurns } from "./codex";
import { CodexAppServerClient } from "./codex-app-server";
import type { NativeReviewMessage, SessionRef } from "./native-session";
import { projectOpencodeMessages } from "./opencode";
import { textBlocks } from "./transcript-json";

/** Migration only. Never submit a prompt or resume a terminal to recover history. */
export async function readLegacyConversation(
  binding: SessionRef,
): Promise<NativeReviewMessage[]> {
  switch (binding.harness) {
    case "claude-code":
      return projectClaudeReviewMessages(
        await readTranscript(await findClaudeTranscript(binding.sessionId)),
      );
    case "codex": {
      const client = await CodexAppServerClient.connect();
      try {
        const result = await client.request("thread/read", {
          threadId: binding.sessionId,
          includeTurns: true,
        });
        const thread = jsonObject(jsonObject(result)?.thread);
        if (thread?.id !== binding.sessionId || !Array.isArray(thread.turns))
          throw new Error("Codex returned no matching transcript.");
        return projectCodexTurns(thread.turns);
      } finally {
        await client.close();
      }
    }
    case "pi":
      return readPiConversation(binding.sessionId);
    case "opencode": {
      const { stdout } = await promisify(execFile)(
        "opencode",
        ["export", binding.sessionId],
        { maxBuffer: 64 * 1024 * 1024 },
      );
      const exported = jsonObject(parseJsonText(stdout));
      if (
        jsonObject(exported?.info)?.id !== binding.sessionId ||
        !Array.isArray(exported?.messages)
      )
        throw new Error("OpenCode returned no matching transcript.");
      return projectOpencodeMessages(exported.messages);
    }
  }
}

async function readPiConversation(
  sessionId: string,
): Promise<NativeReviewMessage[]> {
  const root = process.env.PI_CODING_AGENT_SESSION_DIR
    ? expandHome(process.env.PI_CODING_AGENT_SESSION_DIR)
    : join(
        process.env.PI_CODING_AGENT_DIR
          ? expandHome(process.env.PI_CODING_AGENT_DIR)
          : join(homedir(), ".pi", "agent"),
        "sessions",
      );
  const files = await readdir(root, { recursive: true });
  const matches = files.filter(
    (file) =>
      file.endsWith(`_${sessionId}.jsonl`) ||
      file === `${sessionId}.jsonl` ||
      file.endsWith(`/${sessionId}.jsonl`),
  );
  if (matches.length !== 1)
    throw new Error(`Expected one Pi transcript for ${sessionId}.`);
  const entries = await readTranscript(join(root, matches[0]!));
  if (entries[0]?.type !== "session" || entries[0].id !== sessionId)
    throw new Error("Pi transcript has the wrong session ID.");
  const byId = new Map(
    entries
      .filter((entry) => jsonString(entry.id) !== undefined)
      .map((entry) => [String(entry.id), entry]),
  );
  const branch: JsonObject[] = [];
  const seen = new Set<string>();
  let entry = [...entries]
    .reverse()
    .find(
      (entry) => jsonString(entry.id) !== undefined && entry.type !== "session",
    );
  while (entry) {
    const id = String(entry.id);
    if (seen.has(id)) throw new Error("Pi transcript contains a parent cycle.");
    seen.add(id);
    branch.push(entry);
    if (entry.parentId === null) break;
    const parent = jsonString(entry.parentId);
    if (!parent || !byId.has(parent))
      throw new Error("Pi transcript has a missing parent.");
    entry = byId.get(parent);
  }
  const messages: NativeReviewMessage[] = [];
  let assistant: NativeReviewMessage | undefined;
  for (const entry of branch.reverse()) {
    const message = jsonObject(entry.message);
    if (entry.type !== "message" || !message) continue;
    const role = message.role;
    const body = textBlocks(message.content).join("\n").trim();
    if (role !== "user" && role !== "assistant") continue;
    const createdAt = jsonString(entry.timestamp);
    if (!createdAt) throw new Error("Pi message has no timestamp.");
    const projected: NativeReviewMessage = {
      id: String(entry.id),
      role,
      body,
      createdAt,
    };
    if (role === "user") {
      if (assistant) messages.push(assistant);
      assistant = undefined;
      if (body) messages.push(projected);
    } else if (body && message.stopReason === "stop") assistant = projected;
  }
  if (assistant) messages.push(assistant);
  return messages;
}

function expandHome(value: string): string {
  return value === "~"
    ? homedir()
    : value.startsWith("~/")
      ? join(homedir(), value.slice(2))
      : resolve(value);
}

/** Find a unique ordered correspondence. Repeated text alone is not an identity. */
export function recoverLegacyConversation(
  thread: JsonObject,
  binding: SessionRef,
  native: readonly NativeReviewMessage[],
): JsonObject | null {
  const prefix = reviewCommentPromptPrefix(String(thread.threadId));
  const start = native.findIndex(
    (message) => message.role === "user" && message.body.startsWith(prefix),
  );
  if (start < 0 || !Array.isArray(thread.messages) || !thread.messages.length)
    return null;
  const stored = thread.messages.map(jsonObject);
  if (
    stored.some((message) => !message || jsonString(message.body) === undefined)
  )
    return null;
  const tail = native.slice(start);
  const matches = (i: number, j: number) => {
    const message = stored[i]!;
    const candidate = tail[j]!;
    const body =
      candidate.role === "user" && candidate.body.startsWith(prefix)
        ? candidate.body.slice(prefix.length)
        : candidate.body;
    return (
      (message.role ?? "reviewer") ===
        (candidate.role === "user" ? "reviewer" : "agent") &&
      String(message.body).trim() === body.trim()
    );
  };
  // Earliest and latest valid subsequences coincide iff the mapping is unique.
  const forward: number[] = [];
  let cursor = 0;
  for (let i = 0; i < stored.length; i++) {
    while (cursor < tail.length && !matches(i, cursor)) cursor++;
    if (cursor === tail.length) return null;
    forward.push(cursor++);
  }
  if (forward[0] !== 0) return null;
  cursor = tail.length - 1;
  for (let i = stored.length - 1; i >= 0; i--) {
    while (cursor >= 0 && !matches(i, cursor)) cursor--;
    if (cursor !== forward[i]) return null;
    cursor--;
  }
  return {
    ...thread,
    agentSession: { ...binding, firstMessageId: tail[0]!.id },
    messages: stored.map((message, i) => {
      const matched = tail[forward[i]!]!;
      return {
        ...message,
        agentInput: matched.role === "user" && matched.body.startsWith(prefix),
        agentMessage: { sessionId: binding.sessionId, messageId: matched.id },
      };
    }),
  };
}

async function readTranscript(path: string): Promise<JsonObject[]> {
  const source = await readFile(path, "utf8");
  return source
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const record = jsonObject(parseJsonText(line));
      if (!record) throw new Error(`Invalid transcript record in ${path}.`);
      return record;
    });
}
