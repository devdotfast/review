import type { Source } from "./document.js";
import { sourceDiff } from "./source-diff.js";

/** Map complete unchanged ranges; edited/deleted lines are never clamped. */
export async function mapSourceRange(
  source: Source,
  before: string,
  after: string,
): Promise<Source | undefined> {
  if (before === after) return { ...source };
  const diff = await sourceDiff(source.file, before, after);
  const mapping = new Map<number, number>();

  let old = 1,
    next = 1;

  for (const line of diff?.patch.split("\n") ?? []) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);

    if (hunk) {
      const start = Number(hunk[1]);

      while (old < start) mapping.set(old++, next++);
      old = start;
      next = Number(hunk[2]);
    } else if (line.startsWith("---") || line.startsWith("+++")) continue;
    else if (line.startsWith("-")) old++;
    else if (line.startsWith("+")) next++;
    else if (line.startsWith(" ")) mapping.set(old++, next++);
  }

  const count = before.split("\n").length;

  while (old <= count) mapping.set(old++, next++);
  const start = mapping.get(source.fromLine);

  if (start === undefined) return;

  for (let line = source.fromLine; line <= source.toLine; line++)
    if (mapping.get(line) !== start + line - source.fromLine) return;

  return {
    ...source,
    fromLine: start,
    toLine: start + source.toLine - source.fromLine,
  };
}
