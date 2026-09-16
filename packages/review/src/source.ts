import { z } from "zod";

const label = z.string().trim().min(1);

/** A pinned source range as the canonical review document expresses it. The
 * side resolves against the enclosing review version's pins; a range alone is
 * never a global identity or cache key. */
export const sourceSchema = z
  .strictObject({
    side: z.enum(["base", "head"]),
    file: label,
    fromLine: z.number().int().positive(),
    toLine: z.number().int().positive(),
  })
  .refine((s) => s.toLine >= s.fromLine, "Source range ends before it starts.");

export type Source = z.infer<typeof sourceSchema>;

export type SourceRange = Pick<Source, "file" | "fromLine" | "toLine">;

/** Thrown by the pure checks; each boundary translates it for its clients. */
export class SourceRangeError extends Error {}

/** Git and jj read committed objects, so a lexical check suffices: nothing
 * here follows a working-copy symlink. An empty string names the root. */
export function checkSourcePath(file: string): void {
  if (
    file.startsWith("/") ||
    file.includes("\\") ||
    file.split("/").some((part) => part === ".." || part === ".") ||
    /[\u0000-\u001f]/.test(file)
  )
    throw new SourceRangeError(
      "Source file must be a repository-relative path.",
    );
}

/** The range's text from a whole file. A trailing newline is not a line. */
export function sliceSourceRange(text: string, range: SourceRange): string {
  const lines = text.split(/\r?\n/);

  if (text.endsWith("\n")) lines.pop();

  if (text === "" || range.toLine > lines.length)
    throw new SourceRangeError(
      `Source range ${range.file}:${range.fromLine}-${range.toLine} exceeds the pinned file (${lines.length} lines).`,
    );

  return lines.slice(range.fromLine - 1, range.toLine).join("\n");
}

/** A source shown as a peek must contain visible text; a whitespace-only
 * range is an authoring mistake. Prose links may point at blank lines, so
 * only peek-rendering references call this. */
export function requireVisibleSource(text: string, range: SourceRange): void {
  if (text.trim() === "")
    throw new SourceRangeError(
      `Source range ${range.file}:${range.fromLine}-${range.toLine} contains only whitespace.`,
    );
}

/** The authoring input names the diff side `graph`; the document names it
 * `side`. */
export function codePeekSource(props: {
  file: string;
  fromLine: number;
  toLine: number;
  graph?: "head" | "base";
}): Source {
  return {
    side: props.graph ?? "head",
    file: props.file,
    fromLine: props.fromLine,
    toLine: props.toLine,
  };
}
