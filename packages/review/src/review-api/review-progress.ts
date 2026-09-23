import { z } from "zod";

import {
  type LensSource,
  comparisonKey,
  resolveDiffSelection,
  selectionKey,
} from "../lens-selection.js";
import { type FileLineRange, fileLineRangeSchema } from "../source.js";
import { type CoverageFile, emptyCoverage } from "../viewed-coverage.js";
import type { ComparisonCoverage } from "./comparison-coverage.js";
import {
  type DiffLens,
  type Lens,
  UNCATEGORIZED_LENS_ID,
  lensSelections,
} from "./diff-lenses.js";
import { type Pins, anchorPins, selectionReferences } from "./document.js";
import { resolveFileLens, uncategorizedSources } from "./file-lenses.js";
import type { LocalSessionData } from "./local-data.js";
import type { SessionStore, Snapshot } from "./store.js";

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
  /** Changed files of the comparisons that references with their own pins
   * named, by `comparisonKey` and then path. They are not the document's
   * comparison, so they are not in `files`; a node attached to one still
   * counts its changed lines, under its own pins only. A comparison that
   * changed nothing at a cited path has an entry with no file for it. */
  referenceFiles?: Record<string, Record<string, CoverageFile>>;
  resolvedSelections: Record<string, FileLineRange[]>;
  /** The review's file lenses, then the automatic "Uncategorized changes". */
  lenses: (DiffLens & { unavailable?: string; pending?: boolean })[];
}

/** Coverage survives new pins only when both complete file contents are unchanged. */
export async function reviewProgress(
  store: SessionStore,
  data: LocalSessionData,
  snapshot: Snapshot,
  signal: AbortSignal = new AbortController().signal,
  mode: "structural" | "textual" = "structural",
  partial?: ComparisonCoverage,
): Promise<ReviewProgress> {
  // A shared review is read-only and never enters the store, so it has no
  // persisted marks to look up.
  const marks: ReturnType<SessionStore["viewedCoverage"]> = snapshot.shared
    ? new Map()
    : store.viewedCoverage(snapshot.sessionId);

  const pins = snapshot.pins
    ? (await data.resolveSource(snapshot)).pins
    : undefined;

  // A document without pins of its own has no changed files; its references
  // each resolve against the comparison their own pins name.
  const comparison: ComparisonCoverage = pins
    ? (partial ?? (await data.coverage(snapshot.sessionId, pins, mode)))
    : { files: [], fileSources: new Map(), alignments: new Map() };

  signal.throwIfAborted();

  const documentKey = JSON.stringify(pins);
  const comparisons = new Map<string, Promise<ComparisonCoverage>>();

  /** The comparison a reference's own pins name, shared across references. */
  const ownComparison = (
    own: Pins,
  ): Promise<ComparisonCoverage> | undefined => {
    const key = JSON.stringify(own);
    let loading = comparisons.get(key);

    if (loading) return loading;

    if (partial) {
      const state = data.coverageSnapshot(snapshot.sessionId, own, mode);

      if (state.pending) return undefined;
    }

    loading = data.coverage(snapshot.sessionId, own, mode);
    comparisons.set(key, loading);

    return loading;
  };

  const withViewed = (file: CoverageFile): CoverageFile => ({
    ...file,
    viewed:
      marks.get(file.path)?.fingerprint === file.fingerprint
        ? marks.get(file.path)!.coverage
        : emptyCoverage(),
  });

  const files = comparison.files.map(withViewed);
  const referenceFiles: Record<string, Record<string, CoverageFile>> = {};

  const fileSources = new Map(comparison.fileSources);
  const alignments = new Map(comparison.alignments);
  const resolvedSelections: Record<string, FileLineRange[]> = {};

  const unavailableSelections: Record<string, string> = {};
  const pendingSources = new Set<string>();

  const resolve = async (source: LensSource): Promise<FileLineRange[]> => {
    const key = selectionKey(source);

    if (resolvedSelections[key]) return resolvedSelections[key];
    const sourcePins = anchorPins(source, pins);
    const own = JSON.stringify(sourcePins) !== documentKey;
    let ownFiles = files;
    let ownAlignments = alignments;

    if (own) {
      const loading = ownComparison(sourcePins);

      if (!loading) {
        pendingSources.add(key);

        return [];
      }

      const loaded = await loading;
      ownFiles = loaded.files;
      ownAlignments = loaded.alignments;
    }

    const file = ownFiles.find(
      (file) => source.file === file.path || source.file === file.previousPath,
    );

    if (own) {
      const group = (referenceFiles[comparisonKey(sourcePins)] ??= {});

      if (file) group[file.path] ??= withViewed(file);
    }

    let rows = file && ownAlignments.get(file.path);

    // Context-only files are absent from the changed-file stream. Read both pins
    // and require equality rather than inventing correspondence for missing diffs.
    if (!file && partial && !own) {
      pendingSources.add(key);

      return [];
    }

    if (!file) {
      const [base, head] = await Promise.all([
        data.file(sourcePins, "base", source.file),
        data.file(sourcePins, "head", source.file),
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

  const lenses: ReviewProgress["lenses"] = await Promise.all(
    (snapshot.lenses ?? []).map(async (authored) => {
      const lens = { id: authored.id, title: authored.title };

      try {
        // Explicit ranges use the same pin validation as diagram evidence.
        await Promise.all(
          lensSelections([authored]).map(({ source }) =>
            resolveAvailable(source),
          ),
        );

        const resolved = resolveFileLens(
          authored,
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
        lenses
          .filter((lens) => !lens.unavailable)
          .flatMap((lens) => lens.sources),
      );

  lenses.push({
    id: UNCATEGORIZED_LENS_ID,
    title: "Uncategorized changes",
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
    referenceFiles,
    lenses,
    resolvedSelections,
    unavailableSelections,
  };
}

/** The most files an uncategorized report names; the rest are counted. */
const REPORT_FILES = 50;

export interface UncategorizedReport {
  /** Changed lines, counting each side, that no lens selects. */
  lines: number;
  files: {
    path: string;
    lines: number;
    ranges: Pick<FileLineRange, "side" | "fromLine" | "toLine">[];
  }[];
  /** Files past the first REPORT_FILES, left out of `files`. */
  moreFiles?: number;
}

/** What a lens author still has to place: the changed lines no lens selects,
 * grouped by file. */
export function uncategorizedReport(
  progress: ReviewProgress,
): UncategorizedReport {
  const sources =
    progress.lenses.find((lens) => lens.id === UNCATEGORIZED_LENS_ID)
      ?.sources ?? [];

  const byPath = new Map<string, UncategorizedReport["files"][number]>();

  for (const source of sources) {
    const path =
      progress.files.find(
        (file) =>
          source.file ===
          (source.side === "base"
            ? (file.previousPath ?? file.path)
            : file.path),
      )?.path ?? source.file;

    const entry = byPath.get(path) ?? { path, lines: 0, ranges: [] };
    entry.lines += source.toLine - source.fromLine + 1;
    entry.ranges.push({
      side: source.side,
      fromLine: source.fromLine,
      toLine: source.toLine,
    });
    byPath.set(path, entry);
  }

  const files = [...byPath.values()];

  const report: UncategorizedReport = {
    lines: files.reduce((total, file) => total + file.lines, 0),
    files: files.slice(0, REPORT_FILES),
  };

  if (files.length > REPORT_FILES)
    report.moreFiles = files.length - REPORT_FILES;

  return report;
}

/** Each lens as authored, with what it resolves to, for a lens author. */
export function lensReport(lenses: readonly Lens[], progress: ReviewProgress) {
  return {
    lenses: lenses.map((lens) => {
      const resolved = progress.lenses.find((item) => item.id === lens.id);

      return {
        ...lens,
        fileCount: resolved?.fileCount ?? 0,
        ...(resolved?.unavailable && { unavailable: resolved.unavailable }),
      };
    }),
    uncategorized: uncategorizedReport(progress),
  };
}
