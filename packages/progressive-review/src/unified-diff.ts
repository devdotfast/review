export interface DiffHunk {
  file: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffHunkLine[];
}

export interface DiffHunkLine {
  kind: "context" | "add" | "remove";
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

const HUNK_HEADER =
  /^@@ -(?<oldStart>\d+)(?:,(?<oldLines>\d+))? \+(?<newStart>\d+)(?:,(?<newLines>\d+))? @@/;

export function parseUnifiedPatch(
  file: string,
  patch: string | null | undefined,
): DiffHunk[] {
  if (!patch) return [];

  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const row of patch.split(/\r?\n/)) {
    const header = HUNK_HEADER.exec(row);
    if (header?.groups) {
      current = {
        file,
        oldStart: Number(header.groups.oldStart),
        oldLines: Number(header.groups.oldLines ?? "1"),
        newStart: Number(header.groups.newStart),
        newLines: Number(header.groups.newLines ?? "1"),
        lines: [],
      };
      oldLine = current.oldStart;
      newLine = current.newStart;
      hunks.push(current);
      continue;
    }

    if (!current || row.startsWith("\\ No newline at end of file")) continue;

    const marker = row[0];
    const text = row.slice(1);
    let line: DiffHunkLine | null = null;
    if (marker === " ") {
      line = { kind: "context", oldLine, newLine, text };
      oldLine += 1;
      newLine += 1;
    } else if (marker === "+") {
      line = { kind: "add", oldLine: null, newLine, text };
      newLine += 1;
    } else if (marker === "-") {
      line = { kind: "remove", oldLine, newLine: null, text };
      oldLine += 1;
    }
    if (line) current.lines.push(line);
  }

  return hunks;
}
