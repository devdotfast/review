import {
  type JsonValue,
  isJsonObject,
  isNumberValue,
  isStringValue,
  jsonValueSchema,
} from "@dev.fast/review-protocol";

/** Upgrade retained document attachments at the read/import boundary. New edits
 * use the strict DiffSelection schema and never accept these retired forms. */
// This is the decoder boundary for stored documents in retired wire formats.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export function migrateDiffSelections(input: unknown): JsonValue {
  return migrateNode(jsonValueSchema.parse(input));
}

function migrateNode(value: JsonValue, attachment = false): JsonValue {
  if (Array.isArray(value))
    return value.map((child) => migrateNode(child, attachment));

  if (!isJsonObject(value)) return value;

  if (attachment && isStringValue(value.file)) {
    if (isNumberValue(value.fromLine) && isNumberValue(value.toLine)) {
      const side = value.side ?? value.graph ?? "head";

      return {
        file: value.file,
        start: { side, line: value.fromLine },
        end: { side, line: value.toLine },
      };
    }

    if (
      isJsonObject(value.start) &&
      isJsonObject(value.end) &&
      "baseLine" in value.start
    ) {
      const endpoint = (row: typeof value.start) =>
        isNumberValue(row.headLine)
          ? { side: "head", line: row.headLine }
          : { side: "base", line: row.baseLine };

      return {
        file: value.file,
        start: endpoint(value.start),
        end: endpoint(value.end),
      };
    }
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      migrateNode(
        child,
        ["source", "peek", "sources", "contextSources", "callSite"].includes(
          key,
        ),
      ),
    ]),
  );
}
