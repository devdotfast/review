import { type JsonValue, isJsonObject } from "@dev.fast/review-protocol";

import { migrateDiffSelections } from "./diff-selection-migration.js";

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
