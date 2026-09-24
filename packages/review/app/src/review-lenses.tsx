import type { ReviewDiffLens } from "@dev.fast/review-protocol";
import {
  type ReactNode,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  type LensSource,
  comparisonKey,
  selectionKey,
} from "../../src/lens-selection";
import type { ReviewApiClient } from "../../src/review-api/client";
import {
  type Lens,
  UNCATEGORIZED_LENS_ID,
} from "../../src/review-api/diff-lenses";
import type { ReviewProgress } from "../../src/review-api/review-progress";
import type { Snapshot } from "../../src/review-api/store";
import type { FileLineRange } from "../../src/source";
import {
  type CoverageProgress,
  coverageProgress,
  coverageSources,
  mergeCoverageProgress,
  scopedCoverage,
} from "../../src/viewed-coverage";

/** A resolved selection, tagged with the comparison its own pins name so its
 * changed lines are counted there and not in the document's comparison. */
export interface ResolvedRange extends FileLineRange {
  comparison?: string;
}

interface Lenses {
  progress: ReviewProgress | null;
  lenses: ReviewProgress["lenses"];
  /** The lenses as authored on the version shown, targets and all. */
  authored: readonly Lens[];
  availability(
    sources: readonly LensSource[],
  ): "pending" | "ready" | "unavailable";
  active: ReviewDiffLens | undefined;
  select(id: string, sources?: ReviewDiffLens["ranges"]): void;
  clear(): void;
  resolve(sources: readonly LensSource[]): ResolvedRange[];
  stats(sources?: readonly ResolvedRange[]): CoverageProgress;
  mark(
    sources: readonly FileLineRange[] | undefined,
    viewed: boolean,
    collapseLens?: boolean,
  ): Promise<void>;
  changedPaths: string[];
  unfoldRanges: readonly FileLineRange[];
  busy: boolean;
  error: string | null;
  structuralDiffEnabled: boolean;
}

export type ReviewLensView = Pick<Lenses, "progress" | "resolve" | "error">;

const Context = createContext<Lenses | null>(null);

export const useReviewLenses = () => useContext(Context);

export function ReviewLensesProvider({
  client,
  snapshot,
  structuralDiffEnabled = true,
  coverageRevision = 0,
  children,
}: {
  client: ReviewApiClient;
  snapshot: Snapshot;
  structuralDiffEnabled?: boolean;
  coverageRevision?: number;
  children: ReactNode;
}) {
  const [progress, setProgress] = useState<ReviewProgress | null>(null);
  const [activeId, setActiveId] = useState<string>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [changedPaths, setChangedPaths] = useState<string[]>([]);

  const [unfoldRanges, setUnfoldRanges] = useState<readonly FileLineRange[]>(
    [],
  );

  const generation = useRef(0);
  const pending = useRef(false);
  const mode = structuralDiffEnabled ? "structural" : "textual";
  const route = `/${snapshot.reviewId}/progress`;
  useEffect(() => {
    generation.current++;
    pending.current = false;
    setBusy(false);
    setProgress(null);
    setActiveId(undefined);
    setError(null);
    setChangedPaths([]);
    setUnfoldRanges([]);

    return () => {
      generation.current++;
    };
  }, [client, route, snapshot.version, mode]);
  useEffect(() => {
    const abort = new AbortController();
    void client
      .read<ReviewProgress>(
        `${route}?version=${snapshot.version}&mode=${mode}&wait=false`,
        abort.signal,
      )
      .then((value) => {
        if (abort.signal.aborted) return;
        setProgress(value);
        setError(null);
      })
      .catch((error) => {
        if (!abort.signal.aborted) setError(String(error));
      });

    return () => abort.abort();
  }, [client, route, snapshot.version, mode, coverageRevision]);

  const lenses: ReviewProgress["lenses"] = progress?.lenses ?? [
    ...(snapshot.lenses ?? []).map((lens) => ({
      id: lens.id,
      title: lens.title,
      sources: [],
      pending: true,
    })),
    {
      id: UNCATEGORIZED_LENS_ID,
      title: "Uncategorized changes",
      sources: [],
      pending: true,
    },
  ];

  const item = lenses.find((item) => item.id === activeId);
  // Scope contains only resolved correspondence; navigation anchors are not coverage.
  const ranges = item?.sources ?? [];
  const scopeKey = JSON.stringify(ranges);

  const active = useMemo(
    () =>
      item
        ? {
            id: item.id,
            title: item.title,
            reviewId: snapshot.reviewId,
            version: snapshot.version,
            // SAFETY: scopeKey was produced from item.sources, which are validated file ranges.
            ranges: JSON.parse(scopeKey) as FileLineRange[],
            wholeFiles: item.wholeFiles ?? false,
          }
        : undefined,
    [
      activeId,
      item?.id,
      item?.title,
      item?.wholeFiles,
      snapshot.reviewId,
      snapshot.version,
      scopeKey,
    ],
  );

  const mark: Lenses["mark"] = async (
    sources,
    viewed,
    collapseLens = false,
  ) => {
    if (!progress || pending.current) return;
    pending.current = true;
    setBusy(true);
    const currentGeneration = generation.current;

    const files = progress.files
      .map((file) => ({ ...file, scope: scopedCoverage(file, sources) }))
      .filter((file) => file.scope.base.length || file.scope.head.length)
      .map((file) => ({
        path: file.path,
        fingerprint: file.fingerprint,
        sources: coverageSources(file, file.scope),
      }));

    try {
      const next = await client.post<ReviewProgress>(route, {
        version: snapshot.version,
        mode,
        files,
        viewed,
      });

      if (generation.current !== currentGeneration) return;
      setProgress((current) => ({
        ...next,
        lenses: current?.lenses ?? next.lenses,
      }));
      setChangedPaths(files.map((file) => file.path));
      setUnfoldRanges(viewed ? [] : files.flatMap((file) => file.sources));
      setError(null);

      if (collapseLens && viewed) setActiveId(undefined);
    } catch (error) {
      if (generation.current === currentGeneration) setError(String(error));
    } finally {
      if (generation.current === currentGeneration) {
        pending.current = false;
        setBusy(false);
      }
    }
  };

  const value = useMemo<Lenses>(
    () => ({
      progress,
      lenses,
      authored: snapshot.lenses ?? [],
      availability: (sources) => {
        if (
          sources.some(
            (source) => progress?.unavailableSelections?.[selectionKey(source)],
          )
        )
          return "unavailable";

        if (
          sources.every(
            (source) =>
              progress?.resolvedSelections[selectionKey(source)] !== undefined,
          )
        )
          return "ready";

        return progress?.complete === true ? "unavailable" : "pending";
      },
      active,
      changedPaths,
      unfoldRanges,
      busy,
      error,
      structuralDiffEnabled,
      select: (id) => {
        if (lenses.some((item) => item.id === id && !item.unavailable))
          setActiveId(id);
      },
      clear: () => setActiveId(undefined),
      resolve: (sources) =>
        sources.flatMap((source) =>
          (progress?.resolvedSelections[selectionKey(source)] ?? []).map(
            (range): ResolvedRange =>
              source.pins
                ? { ...range, comparison: comparisonKey(source.pins) }
                : range,
          ),
        ),
      // Each selection counts against the comparison its own pins name: the
      // document's files, or the files of a reference's own comparison.
      stats: (sources) => {
        if (!sources) return coverageProgress(progress?.files ?? []);

        const groups = new Map<string | undefined, ResolvedRange[]>();

        for (const source of sources) {
          const key =
            source.comparison !== undefined &&
            progress?.referenceFiles?.[source.comparison]
              ? source.comparison
              : undefined;

          groups.set(key, [...(groups.get(key) ?? []), source]);
        }

        return mergeCoverageProgress(
          [...groups].map(([key, ranges]) =>
            coverageProgress(
              key === undefined
                ? (progress?.files ?? [])
                : Object.values(progress!.referenceFiles![key]!),
              ranges,
            ),
          ),
        );
      },
      mark,
    }),
    [
      progress,
      lenses,
      active,
      changedPaths,
      unfoldRanges,
      busy,
      error,
      structuralDiffEnabled,
      client,
      route,
      snapshot,
    ],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function ViewedButton({
  progress,
  onClick,
  disabled,
  label = "Mark viewed",
}: {
  progress: CoverageProgress;
  onClick(): void;
  disabled?: boolean;
  label?: string;
}) {
  const done = progress.state === "viewed";

  return (
    <button
      type="button"
      className={`viewed-check viewed-check--${progress.state}`}
      role="checkbox"
      aria-checked={progress.state === "partial" ? "mixed" : done}
      aria-label={done ? "Mark unviewed" : label}
      title={done ? "Mark unviewed and unfold" : label}
      disabled={
        disabled || progress.total.additions + progress.total.deletions === 0
      }
      onClick={onClick}
    >
      {done ? "✓" : progress.state === "partial" ? "−" : ""}
    </button>
  );
}
