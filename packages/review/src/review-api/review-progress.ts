import { createHash } from "node:crypto";

import { z } from "zod";

import { type Source, sourceSchema } from "../source.js";
import { parseUnifiedPatch } from "../unified-diff.js";
import {
  type CoverageFile,
  emptyCoverage,
  unionIntervals,
} from "../viewed-coverage.js";
import { type DiagramLens, diagramLenses } from "./diagram-lenses.js";
import { elements } from "./document.js";
import { resolveFileLens, uncategorizedSources } from "./file-lenses.js";
import type { LocalReviewData } from "./local-data.js";
import type { ReviewStore, Snapshot } from "./store.js";

export const progressUpdateSchema = z.strictObject({
  version: z.number().int().nonnegative(),
  files: z
    .array(
      z.strictObject({
        path: z.string(),
        fingerprint: z.string().min(1),
        sources: z.array(sourceSchema),
      }),
    )
    .max(10000),
  viewed: z.boolean(),
});

export interface ReviewProgress {
  files: CoverageFile[];
  diagrams: (DiagramLens & { unavailable?: string })[];
}

const hash = (parts: (string | null)[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");

/** Coverage survives new pins only when both complete file contents are unchanged. */
export async function reviewProgress(
  store: ReviewStore,
  data: LocalReviewData,
  snapshot: Snapshot,
): Promise<ReviewProgress> {
  const marks = store.viewedCoverage(snapshot.reviewId);
  const fileSources = new Map<string, Source[]>();

  const files = await Promise.all(
    (await data.changes(snapshot.pins)).map(
      async (file): Promise<CoverageFile> => {
        const patch = await data.changes(snapshot.pins, file.path);
        const changed = emptyCoverage();

        for (const hunk of parseUnifiedPatch(file.path, patch))
          for (const line of hunk.lines) {
            if (line.kind === "add")
              changed.head.push([line.newLine! - 1, line.newLine!]);

            if (line.kind === "remove")
              changed.base.push([line.oldLine! - 1, line.oldLine!]);
          }

        changed.base = unionIntervals(changed.base);
        changed.head = unionIntervals(changed.head);

        const [base, head] = await Promise.all([
          file.status === "added"
            ? null
            : data
                .file(snapshot.pins, "base", file.previousPath ?? file.path)
                .then((value) => value.text)
                .catch(() => null),
          file.status === "deleted"
            ? null
            : data
                .file(snapshot.pins, "head", file.path)
                .then((value) => value.text)
                .catch(() => null),
        ]);

        // Unsupported/binary content has no line coverage. Never carry uncertain progress.
        const readable =
          (file.status === "added" || base !== null) &&
          (file.status === "deleted" || head !== null);

        const fingerprint = hash([
          snapshot.pins.repositoryId,
          base,
          head,
          ...(readable ? [] : [snapshot.pins.base, snapshot.pins.head, patch]),
        ]);

        const stored = marks.get(file.path);
        fileSources.set(file.path, [
          ...(file.status !== "added"
            ? [
                {
                  side: "base" as const,
                  file: file.previousPath ?? file.path,
                  fromLine: 1,
                  toLine: base?.split("\n").length ?? 1,
                },
              ]
            : []),
          ...(file.status !== "deleted"
            ? [
                {
                  side: "head" as const,
                  file: file.path,
                  fromLine: 1,
                  toLine: head?.split("\n").length ?? 1,
                },
              ]
            : []),
        ]);

        return {
          path: file.path,
          previousPath: file.previousPath,
          fingerprint,
          changed,
          viewed:
            stored?.fingerprint === fingerprint
              ? stored.coverage
              : emptyCoverage(),
        };
      },
    ),
  );

  const diagrams = await Promise.all(
    diagramLenses(snapshot.document).map(async (lens) => {
      const block = elements(snapshot.document).find(
        (block) => block.id === lens.id,
      )!;

      try {
        if (block.type === "file_lens") {
          // Explicit ranges use the same pin validation as diagram evidence.
          await Promise.all(
            lens.sources.map((source) => data.quote(snapshot.pins, source)),
          );
          const resolved = resolveFileLens(block, files, fileSources);
          return {
            ...lens,
            ...resolved,
            unavailable: resolved.fileCount
              ? undefined
              : "No files match these targets",
          };
        }

        if (block.type === "software_map") {
          const map = await data.map(snapshot.pins, block.mapVersionId);

          const selected = block.focusElementId
            ? map.elements.filter(
                (element) =>
                  element.id === block.focusElementId ||
                  element.path === block.focusElementId,
              )
            : map.elements;

          lens.sources = selected.flatMap((element) => [
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
          ]);
        }

        await Promise.all(
          lens.sources.map((source) => data.quote(snapshot.pins, source)),
        );

        return {
          ...lens,
          unavailable: lens.sources.length ? undefined : "No source links",
        };
      } catch {
        return {
          ...lens,
          unavailable: "Source links need updating at these pins",
        };
      }
    }),
  );

  const uncategorized = uncategorizedSources(
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
    unavailable: uncategorized.length
      ? undefined
      : "All changed lines are covered by lenses",
  });

  return { files, diagrams };
}
