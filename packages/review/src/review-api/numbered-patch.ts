const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** File headers that repeat what `diff --git` already says. */
const REDUNDANT_HEADER = /^(index |--- |\+\+\+ )/;

/**
 * Prefix every hunk line of one file's Git patch with its base and head line
 * numbers, so a reader can cite lines without counting from the `@@` header:
 *
 *      95  96         409,
 *          99 +   extend(sessionId: string): boolean {
 *     120     -   old line
 *
 * `diff --git`, `@@` and mode/rename/binary lines pass through; `index`,
 * `---` and `+++` lines are dropped.
 */
export function numberPatch(patch: string): string {
  const rows = patch.split(/\r?\n/);
  let width = 1;

  for (const row of rows) {
    const hunk = HUNK_HEADER.exec(row);

    if (hunk)
      width = Math.max(
        width,
        String(Number(hunk[1]) + Number(hunk[2] ?? 1)).length,
        String(Number(hunk[3]) + Number(hunk[4] ?? 1)).length,
      );
  }

  const blank = " ".repeat(width);

  const gutter = (base: number | null, head: number | null) =>
    `${base === null ? blank : String(base).padStart(width)} ${head === null ? blank : String(head).padStart(width)} `;

  const out: string[] = [];
  let inHunk = false;
  let base = 0;
  let head = 0;
  let baseLeft = 0;
  let headLeft = 0;

  for (const row of rows) {
    const hunk = HUNK_HEADER.exec(row);

    if (hunk) {
      inHunk = true;
      base = Number(hunk[1]);
      baseLeft = Number(hunk[2] ?? 1);
      head = Number(hunk[3]);
      headLeft = Number(hunk[4] ?? 1);
      out.push(row);
      continue;
    }

    if (row.startsWith("\\")) {
      out.push(gutter(null, null) + row);
      continue;
    }

    if (inHunk && (baseLeft > 0 || headLeft > 0)) {
      // Some tools strip the space from an empty context line.
      const marker = row[0] ?? " ";

      if (marker === "+") {
        out.push(gutter(null, head++) + row);
        headLeft--;
      } else if (marker === "-") {
        out.push(gutter(base++, null) + row);
        baseLeft--;
      } else {
        out.push(gutter(base++, head++) + (row || " "));
        baseLeft--;
        headLeft--;
      }

      continue;
    }

    if (!inHunk && REDUNDANT_HEADER.test(row)) continue;

    if (row !== "") out.push(row);
  }

  return out.join("\n") + "\n";
}

export interface PatchFile {
  path: string;
  additions: number;
  deletions: number;
  /** One file's Git patch, from its `diff --git` line. */
  patch: string;
}

/**
 * Number whole files, in order, until the next would pass `maxBytes`, then
 * list the rest with a `paths` hint to fetch them. A first file that alone
 * passes the budget is cut at a line boundary with a marker, so every call
 * makes progress and the budget stays a hard limit on patch text.
 */
export function budgetPatches(files: PatchFile[], maxBytes: number): string {
  let text = "";
  let used = 0;
  let index = 0;

  for (; index < files.length; index++) {
    const numbered = numberPatch(files[index]!.patch);
    const size = Buffer.byteLength(numbered);

    if (used + size <= maxBytes) {
      text += numbered;
      used += size;
      continue;
    }

    if (index === 0) {
      text = truncate(numbered, maxBytes, files[0]!.path);
      index = 1;
    }

    break;
  }

  const rest = files.slice(index);

  if (rest.length === 0) return text;
  const listed = rest.slice(0, 200);

  const counts = listed.map((file) => {
    const change = [
      file.additions ? `+${file.additions}` : "",
      file.deletions ? `-${file.deletions}` : "",
    ]
      .filter(Boolean)
      .join(" ");

    return change ? `${file.path} (${change})` : file.path;
  });

  const more =
    rest.length > listed.length ? ` The first ${listed.length}:` : "";

  return (
    text +
    `[${rest.length} more file${rest.length === 1 ? "" : "s"} over the ${maxBytes}-byte budget:${more} ${counts.join(", ")}. ` +
    `Fetch them with paths:${JSON.stringify(listed.map((file) => file.path))}, format:"patch".]\n`
  );
}

function truncate(numbered: string, maxBytes: number, path: string) {
  const lines = numbered.split("\n");
  let kept = 0;
  let size = 0;

  while (
    kept < lines.length &&
    size + Buffer.byteLength(lines[kept]!) + 1 <= maxBytes
  )
    size += Buffer.byteLength(lines[kept++]!) + 1;

  return (
    lines.slice(0, kept).join("\n") +
    (kept ? "\n" : "") +
    `[${path} is cut at the ${maxBytes}-byte budget after ${kept} of ${lines.length - 1} lines. Raise maxBytes (up to 500000), lower context, or read the file with review_file.]\n`
  );
}
