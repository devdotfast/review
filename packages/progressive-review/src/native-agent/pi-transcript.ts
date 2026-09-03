import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { jsonNumber, jsonObject, jsonString } from "@dev.fast/review-protocol";

import type { NativeReviewMessage } from "./native-session";
import {
  type JsonRecord,
  isJsonRecord,
  isMissingFileError,
  readJsonLines,
  textBlocks,
} from "./transcript-json";

export async function readPiReviewMessages(input: {
  sessionId: string;
  transcriptPath?: string;
}): Promise<NativeReviewMessage[]> {
  const transcriptPath =
    input.transcriptPath ?? (await findPiSessionFile(input.sessionId));
  return projectPiReviewMessages(
    await readJsonLines(transcriptPath),
    input.sessionId,
  );
}

export function projectPiReviewMessages(
  entries: readonly JsonRecord[],
  sessionId: string,
): NativeReviewMessage[] {
  const header = entries.find((entry) => entry.type === "session");
  if (!header || header.id !== sessionId) {
    throw new Error(`Pi transcript does not belong to session "${sessionId}".`);
  }
  const branch = activeBranch(entries);
  const messages: NativeReviewMessage[] = [];
  let pendingAssistant: NativeReviewMessage | undefined;
  const flushAssistant = (): void => {
    if (pendingAssistant) messages.push(pendingAssistant);
    pendingAssistant = undefined;
  };

  for (const entry of branch) {
    if (entry.type !== "message" || !isJsonRecord(entry.message)) continue;
    const role = entry.message.role;
    const body = textBlocks(entry.message.content).join("\n").trim();
    if (role === "user") {
      flushAssistant();
      if (body) messages.push(projectMessage(entry, "user", body));
      continue;
    }
    if (role === "assistant" && entry.message.stopReason === "stop" && body) {
      pendingAssistant = projectMessage(entry, "assistant", body);
    }
  }
  flushAssistant();
  return messages;
}

function activeBranch(entries: readonly JsonRecord[]): JsonRecord[] {
  const byId = new Map<string, JsonRecord>();
  for (const entry of entries) {
    const id = entryId(entry);
    if (id !== undefined) byId.set(id, entry);
  }
  const leaf = [...entries]
    .reverse()
    .find((entry) => entryId(entry) !== undefined);
  const branch: JsonRecord[] = [];
  const visited = new Set<string>();
  let current: JsonRecord | undefined = leaf;
  while (current) {
    const id = entryId(current);
    if (id === undefined || visited.has(id)) break;
    branch.push(current);
    visited.add(id);
    const parentId = jsonString(current.parentId);
    current = parentId === undefined ? undefined : byId.get(parentId);
  }
  return branch.reverse();
}

/** The entry's non-empty id, or undefined when it has none. */
function entryId(entry: JsonRecord): string | undefined {
  return jsonString(entry.id) || undefined;
}

function projectMessage(
  entry: JsonRecord,
  role: NativeReviewMessage["role"],
  body: string,
): NativeReviewMessage {
  const messageTimestamp = jsonNumber(jsonObject(entry.message)?.timestamp);
  const timestamp =
    jsonString(entry.timestamp) ??
    new Date(messageTimestamp ?? 0).toISOString();
  return {
    role,
    body,
    createdAt: timestamp,
  };
}

export async function findPiSessionFile(sessionId: string): Promise<string> {
  const exact = `${sessionId}.jsonl`;
  const suffix = `_${exact}`;
  const found = await findFile(
    piSessionsDirectory(),
    (name) => name === exact || name.endsWith(suffix),
  );
  if (!found) {
    throw new Error(`Pi session "${sessionId}" has no transcript file.`);
  }
  return found;
}

function piSessionsDirectory(): string {
  const configured = process.env.PI_CODING_AGENT_SESSION_DIR;
  if (configured) return expandHome(configured);
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  return join(
    agentDir ? expandHome(agentDir) : join(homedir(), ".pi", "agent"),
    "sessions",
  );
}

function expandHome(path: string): string {
  return path === "~"
    ? homedir()
    : path.startsWith("~/")
      ? resolve(homedir(), path.slice(2))
      : resolve(path);
}

async function findFile(
  directory: string,
  matches: (name: string) => boolean,
): Promise<string | undefined> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(directory, {
      encoding: "utf8",
      withFileTypes: true,
    });
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = await findFile(path, matches);
      if (found) return found;
    } else if (entry.isFile() && matches(entry.name)) {
      return path;
    }
  }
  return undefined;
}
