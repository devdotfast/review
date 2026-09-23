import type { CallStackChangedLines } from "./call-stack-diff";

// The line numbers a unified patch deletes (base numbering) and adds (head
// numbering). Header lines before the first hunk are ignored. Only tests
// resolve changed lines from a patch now; the document pipeline receives them
// from its caller.
export function patchChangedLines(patch: string): CallStackChangedLines {
  const deleted = new Set<number>();
  const added = new Set<number>();
  let oldLine = 0;
  let newLine = 0;

  for (const line of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);

    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }

    if (oldLine === 0 && newLine === 0) continue;

    if (line.startsWith("-")) {
      deleted.add(oldLine);
      oldLine += 1;
    } else if (line.startsWith("+")) {
      added.add(newLine);
      newLine += 1;
    } else if (line.startsWith(" ")) {
      oldLine += 1;
      newLine += 1;
    }
  }

  return { deleted, added };
}
