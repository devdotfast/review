import { z } from "zod";

const label = z.string().trim().min(1);

/** The repository and commits one source reference was read from. A
 * reference without pins resolves against its document's pins; one with
 * pins names them itself, so a document can quote several repositories or
 * commits. `base` is only needed by references to the base side. */
export const sourcePinsSchema = z.strictObject({
  repositoryId: label,
  head: label,
  base: label.optional(),
});

export type SourcePins = z.infer<typeof sourcePinsSchema>;

/** Internal coordinates for reading one revision or storing resolved coverage.
 * Authored document attachments use DiffSelection instead. */
export const fileLineRangeSchema = z
  .strictObject({
    side: z.enum(["base", "head"]).default("head"),
    file: label,
    fromLine: z.number().int().positive(),
    toLine: z.number().int().positive(),
    pins: sourcePinsSchema.optional(),
  })
  .refine((s) => s.toLine >= s.fromLine, "Source range ends before it starts.")
  .refine(
    (s) => s.side === "head" || !s.pins || s.pins.base !== undefined,
    "A base-side source needs base pins.",
  );

export type FileLineRange = z.infer<typeof fileLineRangeSchema>;

export type SourceRange = Pick<FileLineRange, "file" | "fromLine" | "toLine">;

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
}): FileLineRange {
  return {
    side: props.graph ?? "head",
    file: props.file,
    fromLine: props.fromLine,
    toLine: props.toLine,
  };
}
