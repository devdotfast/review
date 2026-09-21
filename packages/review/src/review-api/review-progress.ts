import { z } from "zod";

import {
  type LensSource,
  resolveDiffSelection,
  selectionKey,
  selectSource,
} from "../lens-selection.js";
import { type FileLineRange, fileLineRangeSchema } from "../source.js";
import { type CoverageFile, emptyCoverage } from "../viewed-coverage.js";
import type { ComparisonCoverage } from "./comparison-coverage.js";
import { type DiagramLens, diagramLenses } from "./diagram-lenses.js";
import { selectionReferences } from "./document.js";
import { elements } from "./document.js";
import { resolveFileLens, uncategorizedSources } from "./file-lenses.js";
import type { LocalReviewData } from "./local-data.js";
import type { ReviewStore, Snapshot } from "./store.js";

export const coverageModeSchema = z
  .enum(["structural", "textual"])
  .default("structural");

export const progressUpdateSchema = z.strictObject({
  mode: coverageModeSchema,
  version: z.number().int().nonnegative(),
  files: z
    .array(
      z.strictObject({
        path: z.string(),
        fingerprint: z.string().min(1),
        sources: z.array(fileLineRangeSchema),
      }),
    )
    .max(10000),
  viewed: z.boolean(),
});

export interface ReviewProgress {
  complete?: boolean;
  unavailableSelections?: Record<string, string>;
  files: CoverageFile[];
  resolvedSelections: Record<string, FileLineRange[]>;
  diagrams: (DiagramLens & { unavailable?: string; pending?: boolean })[];
}

/** Coverage survives new pins only when both complete file contents are unchanged. */
export async function reviewProgress(
  store: ReviewStore,
  data: LocalReviewData,
  snapshot: Snapshot,
  signal: AbortSignal = new AbortController().signal,
  mode: "structural" | "textual" = "structural",
  partial?: ComparisonCoverage,
): Promise<ReviewProgress> {
  const marks = store.viewedCoverage(snapshot.reviewId);
  const { pins } = await data.resolveSource(snapshot);
  const comparison =
    partial ?? (await data.coverage(snapshot.reviewId, pins, mode));
  signal.throwIfAborted();
  const files = comparison.files.map((file) => ({
    ...file,
    viewed:
      marks.get(file.path)?.fingerprint === file.fingerprint
        ? marks.get(file.path)!.coverage
        : emptyCoverage(),
  }));
  const fileSources = new Map(comparison.fileSources);
  const alignments = new Map(comparison.alignments);
  const resolvedSelections: Record<string, FileLineRange[]> = {};

  const unavailableSelections: Record<string, string> = {};
  const pendingSources = new Set<string>();
  const resolve = async (source: LensSource): Promise<FileLineRange[]> => {
    const key = selectionKey(source);
    if (resolvedSelections[key]) return resolvedSelections[key];
    const file = files.find(
      (file) => source.file === file.path || source.file === file.previousPath,
    );
    let rows = file && alignments.get(file.path);
    // Context-only files are absent from the changed-file stream. Read both pins
    // and require equality rather than inventing correspondence for missing diffs.
    if (!file && partial) {
      pendingSources.add(key);
      return [];
    }
    if (!file) {
      const [base, head] = await Promise.all([
        data.file(pins, "base", source.file),
        data.file(pins, "head", source.file),
      ]);
      if (base.text !== head.text)
        throw new Error("Changed context file has no alignment.");
      rows = Array.from(
        { length: base.text.split("\n").length },
        (_, line) => [line, line] as const,
      );
    }
    if (!rows) throw new Error("File has no text alignment.");
    const result = resolveDiffSelection(
      source,
      rows,
      file ?? { path: source.file },
    );
    resolvedSelections[key] = result;
    return result;
  };

  const resolveAvailable = async (source: LensSource) => {
    try {
      return await resolve(source);
    } catch {
      unavailableSelections[selectionKey(source)] =
        "Source links need updating at these pins";
      return [];
    }
  };
  const diagrams: ReviewProgress["diagrams"] = await Promise.all(
    diagramLenses(snapshot.document).map(async (lens) => {
      const block = elements(snapshot.document).find(
        (block) => block.id === lens.id,
      )!;

      try {
        if (block.type === "file_lens") {
          // Explicit ranges use the same pin validation as diagram evidence.
          await Promise.all(lens.sources.map(resolveAvailable));
          const resolved = resolveFileLens(
            block,
            files,
            fileSources,
            (source) => resolvedSelections[selectionKey(source)] ?? [],
          );
          return {
            ...lens,
            ...resolved,
            pending: !!partial,
            unavailable:
              partial || resolved.fileCount
                ? undefined
                : "No files match these targets",
          };
        }

        if (block.type === "software_map" && partial)
          return { ...lens, sources: [], pending: true };
        if (block.type === "software_map") {
          const map = await data.map(pins, block.mapVersionId);

          const selected = block.focusElementId
            ? map.elements.filter(
                (element) =>
                  element.id === block.focusElementId ||
                  element.path === block.focusElementId,
              )
            : map.elements;

          lens.sources = selected
            .flatMap((element) => [
              ...(element.sourceRanges ?? []).map((source) => ({
                ...source,
                side: map.side,
              })),
              ...(element.coverage?.files ?? []).flatMap((file) =>
                file.ranges.map((range) => ({
                  ...range,
                  file: file.path,
                  side: map.side,
                })),
              ),
            ])
            .map(selectSource);
        }

        const sources = (
          await Promise.all(lens.sources.map(resolveAvailable))
        ).flat();

        return {
          ...lens,
          sources,
          pending: lens.sources.some((source) =>
            pendingSources.has(selectionKey(source)),
          ),
          unavailable:
            sources.length ||
            lens.sources.some((source) =>
              pendingSources.has(selectionKey(source)),
            )
              ? undefined
              : "No valid source links",
        };
      } catch {
        return {
          ...lens,
          sources: [],
          unavailable: "Source links need updating at these pins",
        };
      }
    }),
  );

  // Peeks share alignment resolution without claiming lens coverage.
  await Promise.all(
    selectionReferences(snapshot.document, { tolerant: true }).map(
      async ({ source }) => {
        try {
          await resolveAvailable(source);
        } catch {
          /* An unavailable peek does not hide other content. */
        }
      },
    ),
  );

  const uncategorized = partial
    ? []
    : uncategorizedSources(
        files,
        diagrams
          .filter((lens) => !lens.unavailable)
          .flatMap((lens) => lens.sources),
      );
  diagrams.push({
    id: "automatic-uncategorized",
    title: "Uncategorized changes",
    kind: "file_lens",
    sources: uncategorized,
    wholeFiles: false,
    fileCount: new Set(
      uncategorized.map(
        (source) =>
          files.find(
            (file) =>
              source.file ===
              (source.side === "base"
                ? (file.previousPath ?? file.path)
                : file.path),
          )?.path ?? source.file,
      ),
    ).size,
    pending: !!partial,
    unavailable:
      partial || uncategorized.length
        ? undefined
        : "All changed lines are covered by lenses",
  });

  return {
    complete: !partial,
    files,
    diagrams,
    resolvedSelections,
    unavailableSelections,
  };
}

