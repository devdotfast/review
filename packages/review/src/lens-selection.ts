import { z } from "zod";

import { type FileLineRange } from "./source.js";
import { unionIntervals } from "./viewed-coverage.js";

const endpointSchema = z.strictObject({
  side: z.enum(["base", "head"]),
  line: z.number().int().positive(),
});

/** Inclusive endpoints in the uncollapsed alignment, independent of diff layout. */
export const diffSelectionSchema = z
  .strictObject({
    file: z.string().trim().min(1),
    start: endpointSchema,
    end: endpointSchema,
  })
  .refine(
    (value) =>
      value.start.side !== value.end.side || value.start.line <= value.end.line,
    "Source range ends before it starts.",
  );

export type DiffSelection = z.infer<typeof diffSelectionSchema>;

export const lensSourceSchema = diffSelectionSchema;

export type LensSource = DiffSelection;

export type AlignmentRow = readonly [number | null, number | null];

export function selectionKey(source: LensSource): string {
  return JSON.stringify([
    source.file,
    source.start.side,
    source.start.line,
    source.end.side,
    source.end.line,
  ]);
}

/** Adapt internal source links (for example software-map evidence) to a selection. */
export function selectSource(source: FileLineRange): DiffSelection {
  return {
    file: source.file,
    start: { side: source.side, line: source.fromLine },
    end: { side: source.side, line: source.toLine },
  };
}

/** Navigation/quote anchors only; never use these as lens coverage. */
export function sourceAnchors(source: LensSource): FileLineRange[] {
  return (["head", "base"] as const).flatMap((side) => {
    const lines = [source.start, source.end].flatMap((endpoint) =>
      endpoint.side === side ? [endpoint.line] : [],
    );

    return lines.length
      ? [
          {
            file: source.file,
            side,
            fromLine: Math.min(...lines),
            toLine: Math.max(...lines),
          },
        ]
      : [];
  });
}

export function sourceAnchor(source: LensSource): FileLineRange {
  return sourceAnchors(source)[0]!;
}

/** Resolve once against the renderer's rows. No matching or context expansion. */
export function resolveDiffSelection(
  source: LensSource,
  rows: readonly AlignmentRow[],
  file: { path: string; previousPath?: string },
): FileLineRange[] {
  const locate = (endpoint: DiffSelection["start"]): number =>
    rows.findIndex(
      (row) => row[endpoint.side === "base" ? 0 : 1] === endpoint.line - 1,
    );

  const start = locate(source.start);
  const end = locate(source.end);

  if (start < 0 || end < start)
    throw new Error(
      "Lens endpoints do not identify an ordered interval in this diff.",
    );
  const selected = rows.slice(start, end + 1);

  return (["base", "head"] as const).flatMap((side, index) =>
    unionIntervals(
      selected.flatMap((row) =>
        row[index] === null ? [] : [[row[index]!, row[index]! + 1]],
      ),
    ).map(([from, to]) => ({
      file: side === "base" ? (file.previousPath ?? file.path) : file.path,
      side,
      fromLine: from + 1,
      toLine: to,
    })),
  );
}

/** Resolve authored references only. Exact coverage sent back by the server stays exact. */
export function resolvedLensSources(
  sources: readonly LensSource[],
  resolved: Readonly<Record<string, FileLineRange[]>> | undefined,
): FileLineRange[] {
  return sources.flatMap((source) => resolved?.[selectionKey(source)] ?? []);
}
