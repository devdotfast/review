import { readFile } from "node:fs/promises";

import {
  type JsonObject,
  type JsonValue,
  isJsonObject,
  jsonArray,
  jsonString,
  parseJsonText,
} from "@dev.fast/review-protocol";

/** One parsed transcript line; the harness parsers narrow its fields. */
export type JsonRecord = JsonObject;

export function isJsonRecord(value: unknown): value is JsonRecord {
  return isJsonObject(value);
}

export async function readJsonLines(path: string): Promise<JsonRecord[]> {
  const source = await readFile(path, "utf8");
  return source.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const value = parseJsonText(line);
      return isJsonRecord(value) ? [value] : [];
    } catch {
      // A native writer can leave the last line incomplete during a read.
      return [];
    }
  });
}

export function textBlocks(value: JsonValue | undefined): string[] {
  const text = jsonString(value);
  if (text !== undefined) return text.trim() ? [text] : [];
  const blocks = jsonArray(value);
  if (!blocks) return [];
  return blocks.flatMap((block) => {
    if (!isJsonRecord(block) || block.type !== "text") return [];
    const blockText = jsonString(block.text);
    return blockText?.trim() ? [blockText] : [];
  });
}

/** Whether a thrown filesystem error reports a missing file (ENOENT). */
export function isMissingFileError(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}
