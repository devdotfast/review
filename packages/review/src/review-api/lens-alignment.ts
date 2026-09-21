import type { AlignmentRow } from "../lens-selection.js";
import { parseUnifiedPatch } from "../unified-diff.js";

/** Project the already-computed patch's runs, including unchanged gaps. */
export function textualRows(
  path: string,
  patch: string,
  baseCount: number,
  headCount: number,
): AlignmentRow[] {
  const rows: AlignmentRow[] = [];
  let base = 0,
    head = 0;
  const append = (baseEnd: number, headEnd: number) => {
    while (base < baseEnd || head < headEnd)
      rows.push([
        base < baseEnd ? base++ : null,
        head < headEnd ? head++ : null,
      ]);
  };
  for (const hunk of parseUnifiedPatch(path, patch)) {
    append(
      hunk.oldLines ? hunk.oldStart - 1 : hunk.oldStart,
      hunk.newLines ? hunk.newStart - 1 : hunk.newStart,
    );
    let removed = 0,
      added = 0;
    const flush = () => {
      append(base + removed, head + added);
      removed = added = 0;
    };
    for (const line of hunk.lines) {
      if (line.kind === "context") {
        flush();
        append(base + 1, head + 1);
      } else if (line.kind === "add") added++;
      else removed++;
    }
    flush();
  }
  append(baseCount, headCount);
  return rows;
}
