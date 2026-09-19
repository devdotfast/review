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
  signal: AbortSignal = new AbortController().signal,
  mode: "structural" | "textual" = "structural",
): Promise<ReviewProgress> {
  const marks = store.viewedCoverage(snapshot.reviewId);
  const fileSources = new Map<string, Source[]>();

  const { pins } = await data.resolveSource(snapshot);
  const files: CoverageFile[] = [];

  if (mode === "textual") {
    for (const file of await data.changes(pins)) {
      signal.throwIfAborted();
      const patch = await data.changes(pins, file.path);
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
              .file(pins, "base", file.previousPath ?? file.path)
              .then((value) => value.text)
              .catch(() => null),
        file.status === "deleted"
          ? null
          : data
              .file(pins, "head", file.path)
              .then((value) => value.text)
              .catch(() => null),
      ]);
      const readable =
        (file.status === "added" || base !== null) &&
        (file.status === "deleted" || head !== null);
      const fingerprint = hash([
        pins.repositoryId,
        base,
        head,
        ...(readable ? [] : [pins.base, pins.head, patch]),
      ]);
      const stored = marks.get(file.path);
      fileSources.set(file.path, [
        ...(base !== null
          ? [
              {
                side: "base" as const,
                file: file.previousPath ?? file.path,
                fromLine: 1,
                toLine: base.split("\n").length,
              },
            ]
          : []),
        ...(head !== null
          ? [
              {
                side: "head" as const,
                file: file.path,
                fromLine: 1,
                toLine: head.split("\n").length,
              },
            ]
          : []),
      ]);
      files.push({
        path: file.path,
        previousPath: file.previousPath,
        fingerprint,
        changed,
        viewed:
          stored?.fingerprint === fingerprint
            ? stored.coverage
            : emptyCoverage(),
      });
    }
  } else {
    const remaining = new Set<string>();
    for await (const event of data.structuralChanges({
      reviewId: snapshot.reviewId,
      pins,
      signal,
    })) {
      if (event.type === "start") {
        for (const entry of event.files)
          remaining.add((entry.file.rhs ?? entry.file.lhs)!.path);
        if (!remaining.size) break;
        continue;
      }
      if (event.type === "complete" && (event.failed || event.aborted))
        throw new Error(
          event.aborted?.message ?? "Structural coverage is incomplete.",
        );

      if (event.type !== "file") continue;

      if (event.error)
        throw new Error(
          `Cannot count ${event.file.rhs?.path ?? event.file.lhs?.path}: ${event.error.message}`,
        );
      const diff = event.diff;
      const path = (event.file.rhs ?? event.file.lhs)!.path;
      if (!remaining.delete(path))
        throw new Error(`Unexpected structural result: ${path}`);

      const previousPath =
        event.file.lhs?.path !== path ? event.file.lhs?.path : undefined;

      const base = diff.type === "text" ? (diff.lhs?.text ?? null) : null;
      const head = diff.type === "text" ? (diff.rhs?.text ?? null) : null;

      const fingerprint = hash([
        pins.repositoryId,
        base,
        head,
        ...(diff.type === "binary"
          ? [event.file.lhs?.oid ?? null, event.file.rhs?.oid ?? null]
          : []),
      ]);

      const sources: Source[] = [];

      if (base !== null)
        sources.push({
          side: "base",
          file: event.file.lhs!.path,
          fromLine: 1,
          toLine: base.split("\n").length,
        });

      if (head !== null)
        sources.push({
          side: "head",
          file: path,
          fromLine: 1,
          toLine: head.split("\n").length,
        });
      fileSources.set(path, sources);
      const stored = marks.get(path);
      files.push({
        path,
        previousPath,
        fingerprint,
        changed:
          diff.type === "text" ? diff.structural_changes : emptyCoverage(),
        viewed:
          stored?.fingerprint === fingerprint
            ? stored.coverage
            : emptyCoverage(),
      });
      if (!remaining.size) break;
    }
    if (remaining.size) throw new Error("Structural coverage is incomplete.");
  }

  const diagrams = await Promise.all(
    diagramLenses(snapshot.document).map(async (lens) => {
      const block = elements(snapshot.document).find(
        (block) => block.id === lens.id,
      )!;

      try {
        if (block.type === "file_lens") {
          // Explicit ranges use the same pin validation as diagram evidence.
          await Promise.all(
            lens.sources.map((source) => data.quote(pins, source)),
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
          const map = await data.map(pins, block.mapVersionId);

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
          lens.sources.map((source) => data.quote(pins, source)),
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
