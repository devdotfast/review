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

import type { ReviewApiClient } from "../../src/review-api/client";
import { type Block, elements } from "../../src/review-api/document";
import type { ReviewProgress } from "../../src/review-api/review-progress";
import type { Snapshot } from "../../src/review-api/store";
import type { Source } from "../../src/source";
import {
  type CoverageProgress,
  coverageProgress,
  coverageSources,
  scopedCoverage,
} from "../../src/viewed-coverage";

interface Lenses {
  progress: ReviewProgress | null;
  active: ReviewDiffLens | undefined;
  block(id: string): Block | undefined;
  select(id: string, sources?: ReviewDiffLens["ranges"]): void;
  clear(): void;
  stats(sources?: readonly Source[]): CoverageProgress;
  mark(
    sources: readonly Source[] | undefined,
    viewed: boolean,
    collapseLens?: boolean,
  ): Promise<void>;
  changedPaths: string[];
  unfoldRanges: readonly Source[];
  busy: boolean;
  error: string | null;
}

const Context = createContext<Lenses | null>(null);

export const useReviewLenses = () => useContext(Context);

export function ReviewLensesProvider({
  client,
  snapshot,
  structuralDiffEnabled = true,
  children,
}: {
  client: ReviewApiClient;
  snapshot: Snapshot;
  structuralDiffEnabled?: boolean;
  children: ReactNode;
}) {
  const [progress, setProgress] = useState<ReviewProgress | null>(null);
  const [activeId, setActiveId] = useState<string>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [changedPaths, setChangedPaths] = useState<string[]>([]);
  const [unfoldRanges, setUnfoldRanges] = useState<readonly Source[]>([]);
  const generation = useRef(0);
  const pending = useRef(false);
  const mode = structuralDiffEnabled ? "structural" : "textual";
  const route = `/${snapshot.reviewId}/progress`;
  useEffect(() => {
    const abort = new AbortController();
    generation.current++;
    pending.current = false;
    setBusy(false);
    setProgress(null);
    setActiveId(undefined);
    setError(null);
    setChangedPaths([]);
    setUnfoldRanges([]);
    void client
      .read<ReviewProgress>(
        `${route}?version=${snapshot.version}&mode=${mode}`,
        abort.signal,
      )
      .then((value) => {
        if (!abort.signal.aborted) setProgress(value);
      })
      .catch((error) => {
        if (!abort.signal.aborted) setError(String(error));
      });

    return () => {
      abort.abort();
      generation.current++;
    };
  }, [client, route, snapshot.version, mode]);

  const active = useMemo(() => {
    const item = progress?.diagrams.find((item) => item.id === activeId);

    return item
      ? {
          id: item.id,
          title: item.title,
          reviewId: snapshot.reviewId,
          version: snapshot.version,
          ranges: item.sources,
          wholeFiles: item.wholeFiles ?? false,
        }
      : undefined;
  }, [activeId, progress?.diagrams, snapshot.reviewId, snapshot.version]);

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
        diagrams: current?.diagrams ?? next.diagrams,
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
      active,
      changedPaths,
      unfoldRanges,
      busy,
      error,
      block: (id) =>
        elements(snapshot.document).find(
          (block): block is Block => block.type !== "step" && block.id === id,
        ),
      select: (id) => {
        if (
          progress?.diagrams.some((item) => item.id === id && !item.unavailable)
        )
          setActiveId(id);
      },
      clear: () => setActiveId(undefined),
      stats: (sources) => coverageProgress(progress?.files ?? [], sources),
      mark,
    }),
    [
      progress,
      active,
      changedPaths,
      unfoldRanges,
      busy,
      error,
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
