import { readFile } from "node:fs/promises";

export type JsonRecord = Record<string, unknown>;

export function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readJsonLines(path: string): Promise<JsonRecord[]> {
  const source = await readFile(path, "utf8");
  return source.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const value: unknown = JSON.parse(line);
      return isJsonRecord(value) ? [value] : [];
    } catch {
      // A native writer can leave the last line incomplete during a read.
      return [];
    }
  });
}

export function textBlocks(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value] : [];
  if (!Array.isArray(value)) return [];
  return value.flatMap((block) =>
    isJsonRecord(block) &&
    block.type === "text" &&
    typeof block.text === "string" &&
    block.text.trim()
      ? [block.text]
      : [],
  );
}
