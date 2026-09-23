import { type JsonValue, isJsonObject } from "@dev.fast/review-protocol";
import { z } from "zod";

import { migrateDiffSelections } from "./diff-selection-migration.js";
import { label } from "./review-api/blocks/definition.js";
import { type Lens, lensTargetsSchema } from "./review-api/diff-lenses.js";

/** Upgrade a saved or shared Review document to the current block schema at the
 * read/import boundary. New edits use the strict schema and never accept these
 * retired forms. */
// This is the decoder boundary for stored documents in retired wire formats.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export function migrateStoredDocument(input: unknown): JsonValue {
  return dropSectionStatus(migrateDiffSelections(input));
}

/** Sections once carried an optional `status` (pending, in_progress or
 * complete). The authoring lease is now the only signal of work in progress,
 * so versions saved before it was retired drop the field when read. */
function dropSectionStatus(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(dropSectionStatus);

  if (!isJsonObject(value)) return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !(value.type === "section" && key === "status"))
      .map(([key, child]) => [key, dropSectionStatus(child)]),
  );
}

/** A saved `file_lens` block, from before lenses left the document. */
const legacyFileLensSchema = z.object({
  type: z.literal("file_lens"),
  id: label,
  title: label,
  targets: lensTargetsSchema.optional(),
  patterns: z.array(label).min(1).optional(),
});

export interface LiftedLenses {
  document: JsonValue;
  lenses: Lens[];
}

/** Versions saved before lenses moved out of the document hold them as
 * `file_lens` blocks, possibly inside sections. Lift them out of a migrated
 * document, in document order, keeping each id, title and scope (legacy
 * `patterns` become a files target). Viewed state is per file, so it needs
 * no rewrite. */
export function liftFileLenses(document: JsonValue): LiftedLenses {
  const lenses: Lens[] = [];

  const visit = (value: JsonValue): JsonValue => {
    if (Array.isArray(value))
      return value.flatMap((item) => {
        if (!isJsonObject(item) || item.type !== "file_lens")
          return [visit(item)];

        const legacy = legacyFileLensSchema.safeParse(item);

        // A malformed legacy lens is dropped rather than failing the read.
        if (legacy.success && (legacy.data.targets ?? legacy.data.patterns))
          lenses.push({
            id: legacy.data.id,
            title: legacy.data.title,
            targets: legacy.data.targets ?? [
              { kind: "files", patterns: legacy.data.patterns! },
            ],
          });

        return [];
      });

    if (!isJsonObject(value)) return value;

    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, visit(child)]),
    );
  };

  return { document: visit(document), lenses };
}
