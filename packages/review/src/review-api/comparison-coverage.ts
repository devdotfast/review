import { createHash } from "node:crypto";

import { structuralRows } from "@dev.fast/review-protocol";

import type { AlignmentRow } from "../lens-selection.js";
import type { FileLineRange } from "../source.js";
import { parseUnifiedPatch } from "../unified-diff.js";
import {
  type CoverageFile,
  emptyCoverage,
  unionIntervals,
} from "../viewed-coverage.js";
import type { Pins } from "./document.js";
import { textualRows } from "./lens-alignment.js";
import type { LocalReviewData } from "./local-data.js";
export type CoverageMode = "structural" | "textual";
const hash = (parts: (string | null)[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");
export interface ComparisonCoverage {
  files: CoverageFile[];
  fileSources: Map<string, FileLineRange[]>;
  alignments: Map<string, readonly AlignmentRow[]>;
}
/** Immutable comparison facts shared by catalog totals and review progress. */
export async function comparisonCoverage(
  data: LocalReviewData,
  reviewId: string,
  pins: Pins,
  mode: CoverageMode,
  signal: AbortSignal,
  publish?: (coverage: ComparisonCoverage) => void,
) {
  const fileSources = new Map<string, FileLineRange[]>();
  const alignments = new Map<string, readonly AlignmentRow[]>();

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
      alignments.set(
        file.path,
        textualRows(
          file.path,
          patch,
          base === null ? 0 : base.split("\n").length,
          head === null ? 0 : head.split("\n").length,
        ),
      );
      const readable =
        (file.status === "added" || base !== null) &&
        (file.status === "deleted" || head !== null);
      const fingerprint = hash([
        pins.repositoryId,
        base,
        head,
        ...(readable ? [] : [pins.base, pins.head, patch]),
      ]);
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
        viewed: emptyCoverage(),
      });
      publish?.({
        files: [...files],
        fileSources: new Map(fileSources),
        alignments: new Map(alignments),
      });
    }
  } else {
    const remaining = new Set<string>();
    for await (const event of data.structuralChanges({
      reviewId,
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

      const sources: FileLineRange[] = [];

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
      if (diff.type === "text") alignments.set(path, structuralRows(diff));
      files.push({
        path,
        previousPath,
        fingerprint,
        changed:
          diff.type === "text" ? diff.structural_changes : emptyCoverage(),
        viewed: emptyCoverage(),
      });
      publish?.({
        files: [...files],
        fileSources: new Map(fileSources),
        alignments: new Map(alignments),
      });
      if (!remaining.size) break;
    }
    if (remaining.size) throw new Error("Structural coverage is incomplete.");
  }

  return { files, fileSources, alignments };
}

