import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { jsonString } from "@dev.fast/review-protocol";

import type { NativeReviewMessage } from "./native-session";
import {
  type JsonRecord,
  isJsonRecord,
  isMissingFileError,
  readJsonLines,
  textBlocks,
} from "./transcript-json";

interface ClaudeStep {
  user: NativeReviewMessage;
  assistantEntries: JsonRecord[];
}

export async function readClaudeReviewMessages(input: {
  sessionId: string;
  transcriptPath?: string;
}): Promise<NativeReviewMessage[]> {
  return projectClaudeReviewMessages(
    await readJsonLines(
      input.transcriptPath ?? (await findClaudeTranscript(input.sessionId)),
    ),
  );
}

export async function findClaudeTranscript(sessionId: string): Promise<string> {
  const configDir = process.env.CLAUDE_CONFIG_DIR
    ? resolve(process.env.CLAUDE_CONFIG_DIR)
    : join(homedir(), ".claude");
  const found = await findTranscript(join(configDir, "projects"), sessionId);
  if (!found) {
    throw new Error(`Claude session "${sessionId}" has no transcript file.`);
  }
  return found;
}

async function findTranscript(
  directory: string,
  sessionId: string,
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
      const found = await findTranscript(path, sessionId);
      if (found) return found;
    } else if (entry.isFile() && entry.name === `${sessionId}.jsonl`) {
      return path;
    }
  }
  return undefined;
}

export function projectClaudeReviewMessages(
  entries: readonly JsonRecord[],
): NativeReviewMessage[] {
  const messages: NativeReviewMessage[] = [];
  let step: ClaudeStep | undefined;
  const flushAssistant = (): void => {
    if (!step) return;
    const completed = step.assistantEntries.filter((entry) => {
      const message = isJsonRecord(entry.message) ? entry.message : undefined;
      return message?.stop_reason === "end_turn";
    });
    const contributing = completed.filter((entry) =>
      assistantText(entry).trim(),
    );
    const body = contributing.map(assistantText).join("\n").trim();
    if (!body) return;
    messages.push({
      role: "assistant",
      body,
      createdAt:
        contributing.flatMap(entryTimestamp).at(-1) ?? step.user.createdAt,
    });
  };

  for (const entry of entries) {
    if (entry.isSidechain === true) continue;
    if (entry.type === "user") {
      const body = messageText(entry);
      if (!body) continue;
      flushAssistant();
      const user: NativeReviewMessage = {
        role: "user",
        body,
        createdAt: entryTimestamp(entry)[0] ?? new Date(0).toISOString(),
      };
      messages.push(user);
      step = { user, assistantEntries: [] };
      continue;
    }
    if (step && entry.type === "assistant") {
      step.assistantEntries.push(entry);
    }
  }
  flushAssistant();
  return messages;
}

function messageText(entry: JsonRecord): string {
  const message = isJsonRecord(entry.message) ? entry.message : undefined;
  return textBlocks(message?.content).join("\n").trim();
}

function assistantText(entry: JsonRecord): string {
  return messageText(entry);
}

function entryTimestamp(entry: JsonRecord): string[] {
  const timestamp = jsonString(entry.timestamp);
  return timestamp ? [timestamp] : [];
}
