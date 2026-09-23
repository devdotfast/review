import { z } from "zod";

import { type LensSource, lensSourceSchema } from "../lens-selection.js";
import type { FileLineRange } from "../source.js";
import { label } from "./blocks/definition.js";
import { SessionInputError } from "./input-error.js";

/**
 * Lenses partition a review's change for the Diff view. They live on the
 * snapshot beside the document, are versioned with it, and are written one
 * at a time with the lens command; the document never holds them.
 */

const patternsSchema = z.array(label).min(1).max(1000);

export const lensTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("files"), patterns: patternsSchema }),
  z.strictObject({
    kind: z.literal("ranges"),
    sources: z.array(lensSourceSchema).min(1).max(10000),
  }),
]);

export type LensTarget = z.infer<typeof lensTargetSchema>;

export const lensTargetsSchema = z
  .array(lensTargetSchema)
  .min(1)
  .max(1000)
  .describe(
    "Union of changed-file paths/globs ({kind:files,patterns}) and pinned source ranges ({kind:ranges,sources}). Counts and viewed actions apply only to the selected changed lines.",
  );

export const lensSchema = z.strictObject({
  id: label,
  title: label,
  targets: lensTargetsSchema,
});

export type Lens = z.infer<typeof lensSchema>;

export const LENS_LIMIT = 200;

/** One lens edit. Ids are host-assigned (`lens-N`); an update patches only
 * the fields it names. */
export const lensEditSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("insert"),
    title: label,
    targets: lensTargetsSchema,
    afterId: label
      .optional()
      .describe("The lens this one follows. Omitted appends."),
  }),
  z.strictObject({
    type: z.literal("update"),
    targetId: label,
    title: label.optional(),
    targets: lensTargetsSchema.optional(),
  }),
  z.strictObject({ type: z.literal("remove"), targetId: label }),
]);

export type LensEdit = z.infer<typeof lensEditSchema>;

/** What a document insert of the retired block says instead of a schema dump. */
export const FILE_LENS_MOVED =
  "file_lens is no longer a document block. Lenses live beside the document: author them one at a time with review_lens_edit (insert, update or remove).";

/** Patterns are evaluated against the changed-file list, never the
 * filesystem, but must still read as repository-relative globs. */
export function checkLensTargets(targets: readonly LensTarget[]): void {
  for (const pattern of targets.flatMap((target) =>
    target.kind === "files" ? target.patterns : [],
  ))
    if (
      pattern.startsWith("/") ||
      pattern.split("/").includes("..") ||
      pattern.includes("\\") ||
      pattern.includes("\0")
    )
      throw new SessionInputError(
        "File lens patterns must be repository-relative paths or globs using forward slashes.",
      );
}

/** Apply one edit in place and return the lens it landed on. */
export function applyLensEdit(
  lenses: Lens[],
  edit: LensEdit,
  allocate: () => string,
): Lens {
  const index = (id: string) => {
    const at = lenses.findIndex((lens) => lens.id === id);

    if (at < 0) throw new SessionInputError(`Lens ${id} does not exist.`);

    return at;
  };

  if (edit.type === "insert") {
    if (lenses.length >= LENS_LIMIT)
      throw new SessionInputError(
        `A review holds at most ${LENS_LIMIT} lenses.`,
      );
    checkLensTargets(edit.targets);

    const lens: Lens = {
      id: allocate(),
      title: edit.title,
      targets: edit.targets,
    };

    lenses.splice(
      edit.afterId === undefined ? lenses.length : index(edit.afterId) + 1,
      0,
      lens,
    );

    return lens;
  }

  const at = index(edit.targetId);
  const lens = lenses[at]!;

  if (edit.type === "remove") {
    lenses.splice(at, 1);

    return lens;
  }

  if (edit.title === undefined && edit.targets === undefined)
    throw new SessionInputError("A lens update names a title or targets.");

  if (edit.targets) checkLensTargets(edit.targets);

  const next: Lens = {
    ...lens,
    ...(edit.title !== undefined && { title: edit.title }),
    ...(edit.targets !== undefined && { targets: edit.targets }),
  };

  lenses[at] = next;

  return next;
}

/** Every pinned range a lens selects, with an id stable for its position. */
export function lensSelections(
  lenses: readonly Lens[],
): { id: string; source: LensSource }[] {
  return lenses.flatMap((lens) =>
    lens.targets.flatMap((target, index) =>
      target.kind === "ranges"
        ? target.sources.map((source, range) => ({
            id: `${lens.id}:target:${index}:${range}`,
            source,
          }))
        : [],
    ),
  );
}

/** A lens the Diff view lists: a named set of changed lines. */
export interface DiffLens {
  id: string;
  title: string;
  sources: FileLineRange[];
  fileCount?: number;
  wholeFiles?: boolean;
}

/** The lens id the Diff view gives changed lines no lens selects. */
export const UNCATEGORIZED_LENS_ID = "automatic-uncategorized";
