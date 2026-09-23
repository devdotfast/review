import { createHash } from "node:crypto";

import {
  type StructuralDiff,
  type StructuralRegion,
  type StructuralSource,
  type StructuralVisibility,
  structuralRows,
} from "@dev.fast/review-protocol";

import type { AlignmentRow } from "../lens-selection.js";
import type { FileLineRange } from "../source.js";
import { parseUnifiedPatch } from "../unified-diff.js";
import {
  type Coverage,
  type CoverageFile,
  type LineInterval,
  emptyCoverage,
  intersectIntervals,
  subtractIntervals,
  unionIntervals,
} from "../viewed-coverage.js";
import type { Pins } from "./document.js";
import { textualRows } from "./lens-alignment.js";
import type { LocalSessionData } from "./local-data.js";

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
  data: LocalSessionData,
  sessionId: string,
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
      sessionId,
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
        folded: foldedChanges(event.visibility, diff),
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

/**
 * The changed lines diffr folds by default. A file it hides (lockfiles,
 * generated, vendored and test files, per its plugins) folds all of them.
 * Otherwise they are the changed lines under regions that start collapsed
 * and in no visible leaf: `structural_changes` less what diffr counts in
 * `stats.visible`, recomputed the way diffr's `change_coverage` does so that
 * the lines, not just the counts, are known. A paired leaf contributes its
 * changed spans' lines; an unpaired leaf, all of its lines.
 */
export function foldedChanges(
  visibility: StructuralVisibility | undefined,
  diff: StructuralDiff,
): Coverage {
  if (diff.type !== "text") return emptyCoverage();
  const all = diff.structural_changes;

  if (visibility?.collapsed)
    return { base: unionIntervals(all.base), head: unionIntervals(all.head) };

  const side = (
    changed: readonly LineInterval[],
    source: StructuralSource | undefined,
    other: StructuralSource | undefined,
  ): LineInterval[] => {
    const paired = new Set<number>();

    const pair = (region: StructuralRegion) => {
      if (region.kind === "leaf") paired.add(region.alignment_id);
      else region.children.forEach(pair);
    };

    other?.regions?.forEach(pair);

    const hidden: LineInterval[] = [],
      visible: LineInterval[] = [];

    const collect = (region: StructuralRegion, folded: boolean) => {
      folded ||= region.visibility?.collapsed === true;

      if (region.kind === "fold") {
        for (const child of region.children) collect(child, folded);

        return;
      }

      const lines = folded ? hidden : visible;

      if (paired.has(region.alignment_id))
        for (const span of region.changed ?? [])
          lines.push([span.line, span.line + 1]);
      else
        lines.push([
          region.start.line,
          region.end.column === 0 ? region.end.line : region.end.line + 1,
        ]);
    };

    for (const region of source?.regions ?? []) collect(region, false);

    return subtractIntervals(intersectIntervals(changed, hidden), visible);
  };

  return {
    base: side(all.base, diff.lhs, diff.rhs),
    head: side(all.head, diff.rhs, diff.lhs),
  };
}
