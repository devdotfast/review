import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { isMissingFileError } from "./transcript-json";

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
