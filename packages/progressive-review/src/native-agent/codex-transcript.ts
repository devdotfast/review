import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import { type JsonValue, jsonString } from "@dev.fast/review-protocol";

import type { NativeReviewMessage } from "./native-session";
import {
  type JsonRecord,
  isJsonRecord,
  isMissingFileError,
  readJsonLines,
} from "./transcript-json";

interface CodexMessageEntry {
  body: string;
  phase?: string;
  timestamp: string;
  turnId?: string;
}

export async function readCodexReviewMessages(input: {
  sessionId: string;
  transcriptPath?: string;
}): Promise<NativeReviewMessage[]> {
  const transcriptPath =
    input.transcriptPath ?? (await findCodexRollout(input.sessionId));
  return projectCodexReviewMessages(
    await readJsonLines(transcriptPath),
    input.sessionId,
  );
}

export function projectCodexReviewMessages(
  entries: readonly JsonRecord[],
  sessionId: string,
): NativeReviewMessage[] {
  const header = entries.find((entry) => entry.type === "session_meta");
  if (
    !header ||
    !isJsonRecord(header.payload) ||
    header.payload.id !== sessionId
  ) {
    throw new Error(`Codex rollout does not belong to session "${sessionId}".`);
  }

  const messages: NativeReviewMessage[] = [];
  const assistantEntriesByTurn = new Map<string, CodexMessageEntry[]>();
  let unscopedAssistantEntries: CodexMessageEntry[] = [];

  for (const entry of entries) {
    if (!isJsonRecord(entry.payload)) continue;
    const payload = entry.payload;
    if (entry.type === "response_item" && payload.type === "message") {
      const message = codexMessageEntry(entry, payload);
      if (!message) continue;
      if (payload.role === "user") {
        messages.push({
          role: "user",
          body: message.body,
          createdAt: message.timestamp,
        });
      } else if (payload.role === "assistant") {
        if (message.turnId) {
          const turnEntries = assistantEntriesByTurn.get(message.turnId) ?? [];
          turnEntries.push(message);
          assistantEntriesByTurn.set(message.turnId, turnEntries);
        } else {
          unscopedAssistantEntries.push(message);
        }
      }
      continue;
    }
    if (entry.type !== "event_msg" || payload.type !== "task_complete") {
      continue;
    }
    const turnId = jsonString(payload.turn_id);
    const candidates = turnId
      ? (assistantEntriesByTurn.get(turnId) ?? unscopedAssistantEntries)
      : unscopedAssistantEntries;
    const final = finalAssistantEntry(candidates);
    if (final) {
      messages.push({
        role: "assistant",
        body: final.body,
        createdAt: timestamp(entry) ?? final.timestamp,
      });
    }
    if (turnId) assistantEntriesByTurn.delete(turnId);
    unscopedAssistantEntries = [];
  }
  return messages;
}

export async function findCodexRollout(sessionId: string): Promise<string> {
  const codexHome = process.env.CODEX_HOME
    ? resolve(process.env.CODEX_HOME)
    : join(homedir(), ".codex");
  const suffix = `-${sessionId}.jsonl`;
  const found = await findFile(
    join(codexHome, "sessions"),
    (name) => name.startsWith("rollout-") && name.endsWith(suffix),
  );
  if (!found) {
    throw new Error(`Codex session "${sessionId}" has no rollout file.`);
  }
  return found;
}

function codexMessageEntry(
  entry: JsonRecord,
  payload: JsonRecord,
): CodexMessageEntry | undefined {
  const body = codexContentText(payload.content).join("\n").trim();
  if (!body) return undefined;
  const metadata = isJsonRecord(
    payload.internal_chat_message_metadata_passthrough,
  )
    ? payload.internal_chat_message_metadata_passthrough
    : undefined;
  return {
    body,
    timestamp: timestamp(entry) ?? new Date(0).toISOString(),
    phase: jsonString(payload.phase),
    turnId: jsonString(metadata?.turn_id),
  };
}

function codexContentText(value: JsonValue | undefined): string[] {
  const text = jsonString(value);
  if (text !== undefined) return text.trim() ? [text] : [];
  if (!Array.isArray(value)) return [];
  return value.flatMap((block) => {
    if (
      !isJsonRecord(block) ||
      (block.type !== "input_text" &&
        block.type !== "output_text" &&
        block.type !== "text")
    ) {
      return [];
    }
    const blockText = jsonString(block.text);
    return blockText?.trim() ? [blockText] : [];
  });
}

function finalAssistantEntry(
  entries: readonly CodexMessageEntry[],
): CodexMessageEntry | undefined {
  const finalAnswers = entries.filter(
    (entry) => entry.phase === "final_answer",
  );
  return (finalAnswers.length > 0 ? finalAnswers : entries).at(-1);
}

function timestamp(entry: JsonRecord): string | undefined {
  return jsonString(entry.timestamp) || undefined;
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
    } else if (entry.isFile() && matches(basename(entry.name))) {
      return path;
    }
  }
  return undefined;
}
