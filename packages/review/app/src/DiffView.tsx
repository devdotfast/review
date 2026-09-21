import type {
  ReviewCommitScope,
  ReviewDiffLens,
  ReviewDiffProgress,
  ReviewDiffViewHandle,
} from "@dev.fast/review-protocol";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { sourceAnchor } from "../../src/lens-selection";
import {
  type CoverageProgress,
  coverageProgress,
  coverageSources,
} from "../../src/viewed-coverage";
import { compactDiffCount } from "./diff-count";
import { diffSections } from "./diff-sections";
import { useReviewSession } from "./host/review-session";
import { DisclosureChevron } from "./icons";
import { LensDiagram, lensSteps } from "./lens-diagram";
import { ViewedButton, useReviewLenses } from "./review-lenses";
import { activeTargetForScroll } from "./scroll-active-tracking";
import {
  useBottomSheetResize,
  useRightPanelResize,
} from "./side-panel-resizer";

export function DiffCounts({ progress }: { progress: CoverageProgress }) {
  return (
    <span
      className={`diff-counts ${progress.state === "viewed" ? "is-viewed" : ""}`}
      title={`Remaining +${progress.remaining.additions} −${progress.remaining.deletions} · Total +${progress.total.additions} −${progress.total.deletions}`}
    >
      {progress.state === "viewed" ? (
        "✓"
      ) : (
        <>
          <span className="diff-count-added">
            +{compactDiffCount(progress.remaining.additions)}
          </span>
          <span className="diff-count-removed">
            −{compactDiffCount(progress.remaining.deletions)}
          </span>
        </>
      )}
    </span>
  );
}

export function ReviewDiffView({ scope }: { scope?: ReviewCommitScope }) {
  const workspaceRef = useRef<HTMLDivElement>(null);
  const cabinetsRef = useRef<HTMLDivElement>(null);
  const sidebarResize = useRightPanelResize({
    side: "left",
    stateKey: "diff-sidebar-width",
    defaultWidth: 320,
    minWidth: 250,
    maxWidth: 800,
    minMainWidth: 320,
    label: "Resize diff sidebar",
    containerRef: workspaceRef,
  });
  const cabinetsResize = useBottomSheetResize({
    stateKey: "diff-files-height",
    defaultFraction: 0.45,
    minFraction: 0.2,
    maxFraction: 0.8,
    label: "Resize lenses and files",
    containerRef: cabinetsRef,
  });
  const lenses = useReviewLenses();
  const lens = scope ? undefined : lenses?.active;
  const [fullTree, setFullTree] = useState<HTMLDivElement | null>(null);
  const [lensTree, setLensTree] = useState<HTMLDivElement | null>(null);
  const activeHandle = useRef<ReviewDiffViewHandle | null>(null);
  const [handle, setHandle] = useState<ReviewDiffViewHandle | null>(null);

  // The step the diff is scrolled to, and the lens it belongs to. Every
  // diagram's steps are placed by the editor's own geometry and fed to the
  // rule the contents rail and the tour feed share, so a click on a step
  // lands on it without lighting up the steps in between, and the sidebar
  // answers "which step" the way the file tree already answers "which file".
  const [current, setCurrent] = useState<{
    lensId: string;
    stepId: string;
  } | null>(null);

  const stepsByLens = useMemo(
    () =>
      lenses
        ? lenses.diagrams.flatMap((item) => {
            const block = lenses.block(item.id);

            return block
              ? lensSteps(block).map((step) => ({ lensId: item.id, ...step }))
              : [];
          })
        : [],
    [lenses],
  );

  const lastViewport = useRef<{ height: number } | null>(null);

  useEffect(() => {
    if (!handle?.onDidScroll || !handle.sourceOffset) return;

    let frame: number | null = null;

    const update = (viewport: { height: number }) => {
      const targets = stepsByLens
        .flatMap((step) => {
          const top = handle.sourceOffset?.(sourceAnchor(step.source));

          return top === undefined ? [] : [{ id: step.id, top }];
        })
        .sort((a, b) => a.top - b.top);

      const stepId = activeTargetForScroll(targets, 0, viewport.height / 2);

      const step = stepsByLens.find((candidate) => candidate.id === stepId);

      setCurrent((previous) =>
        step
          ? previous?.stepId === step.id
            ? previous
            : { lensId: step.lensId, stepId: step.id }
          : null,
      );
    };

    const subscription = handle.onDidScroll((viewport) => {
      lastViewport.current = viewport;

      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        update(viewport);
      });
    });

    // Diagrams can arrive after the last scroll; place them right away.
    if (lastViewport.current) update(lastViewport.current);

    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      subscription.dispose();
    };
  }, [handle, stepsByLens]);

  const sections = useMemo(
    () =>
      diffSections(lens ? lenses?.block(lens.id) : undefined).map(
        (section) => ({
          ...section,
          sources: lenses?.resolve(section.sources) ?? [],
        }),
      ),
    [lens?.id, lens?.version, lenses?.progress],
  );

  const fullProgress = useMemo(
    () =>
      lenses?.progress
        ? {
            files: lenses.progress.files.map((file) => ({
              path: file.path,
              ...coverageProgress([file]),
              viewedRanges: coverageSources(file),
              changedRanges: coverageSources(file, file.changed),
              unfoldRanges: lenses.unfoldRanges.filter(
                (source) =>
                  source.file ===
                  (source.side === "base"
                    ? (file.previousPath ?? file.path)
                    : file.path),
              ),
            })),
            changedPaths: lenses.changedPaths,
          }
        : undefined,
    [lenses?.progress, lenses?.changedPaths, lenses?.unfoldRanges],
  );

  const lensProgress = useMemo(
    () =>
      lenses?.progress && lens
        ? {
            files: lenses.progress.files.map((file) => ({
              path: file.path,
              ...coverageProgress([file], lens.ranges),
              viewedRanges: coverageSources(file),
              changedRanges: coverageSources(file, file.changed),
              unfoldRanges: lenses.unfoldRanges.filter(
                (source) =>
                  source.file ===
                  (source.side === "base"
                    ? (file.previousPath ?? file.path)
                    : file.path),
              ),
            })),
            changedPaths: lenses.changedPaths,
            sections: sections.map((section) => ({
              ...section,
              ...coverageProgress(lenses.progress!.files, section.sources),
              files: lenses.progress!.files.map((file) => ({
                path: file.path,
                ...coverageProgress([file], section.sources),
                viewedRanges: coverageSources(file),
                changedRanges: coverageSources(file, file.changed),
              })),
            })),
          }
        : undefined,
    [
      lenses?.progress,
      lenses?.changedPaths,
      lenses?.unfoldRanges,
      lens,
      sections,
    ],
  );

  const markFile = (path: string, scoped: boolean, sectionId?: string) => {
    const file = lenses?.progress?.files.find((file) => file.path === path);

    if (!file || !lenses) return;

    const sources = scoped
      ? (sectionId
          ? sections.find((section) => section.id === sectionId)?.sources
          : lens?.ranges
        )?.filter(
          (source) =>
            source.file ===
            (source.side === "base"
              ? (file.previousPath ?? file.path)
              : file.path),
        )
      : coverageSources(file, file.changed);

    void lenses.mark(sources, lenses.stats(sources).state !== "viewed");
  };

  if (scope || !lenses) return <NativeDiffView scope={scope} />;
  const global = lenses.stats();
  const total = global.total.additions + global.total.deletions;
  const remaining = global.remaining.additions + global.remaining.deletions;
  const percent = total ? Math.round((100 * (total - remaining)) / total) : 0;

  return (
    <div className="diff-workspace" ref={workspaceRef}>
      <aside
        className="diff-workspace-sidebar"
        style={{ width: sidebarResize.width }}
      >
        <div className="diff-global-progress">
          <span>
            {lenses.error &&
            !(lenses.progress && lenses.progress.complete !== false) ? (
              "Counts unavailable"
            ) : (
              <>
                Remaining{" "}
                {lenses.progress && lenses.progress.complete !== false ? (
                  <DiffCounts progress={global} />
                ) : (
                  <span className="diff-counts" aria-label="Counting changes">
                    …
                  </span>
                )}
              </>
            )}
          </span>
          {lenses.progress && lenses.progress.complete !== false && (
            <span
              className="diff-progress-ring"
              role="progressbar"
              aria-label="Changed lines viewed"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              title={`${total - remaining} of ${total} changed lines viewed`}
            >
              <svg width="18" height="18" viewBox="0 0 20 20">
                <circle cx="10" cy="10" r="7" />
                <circle
                  cx="10"
                  cy="10"
                  r="7"
                  pathLength="100"
                  strokeDasharray={`${percent} 100`}
                />
              </svg>
              {percent}%
            </span>
          )}
        </div>
        <div className="diff-sidebar-cabinets" ref={cabinetsRef}>
          <div
            className="diff-sidebar-lenses"
            aria-label="Lenses"
            style={{ flexBasis: `${(1 - cabinetsResize.fraction) * 100}%` }}
          >
            <div className="diff-sidebar-heading">Lenses</div>
            {lenses.diagrams.map((item) => {
              const selected = lens?.id === item.id,
                stats = lenses.stats(item.sources),
                block = lenses.block(item.id),
                fileLens = item.kind === "file_lens";

              return (
                <section
                  key={item.id}
                  className={`diff-lens-section ${selected ? "is-expanded" : ""}`}
                >
                  <div className="diff-lens-row">
                    <button
                      className={`diff-lens-toggle ${fileLens && selected ? "is-active" : ""} ${stats.state === "viewed" ? "is-viewed" : ""} ${!selected && current?.lensId === item.id ? "is-current" : ""}`}
                      aria-expanded={fileLens ? undefined : selected}
                      aria-pressed={fileLens ? selected : undefined}
                      disabled={!!item.unavailable}
                      title={item.unavailable ?? item.title}
                      onClick={() =>
                        selected ? lenses.clear() : lenses.select(item.id)
                      }
                    >
                      {!fileLens && <DisclosureChevron expanded={selected} />}
                      <LensIcon kind={item.kind} />
                      <span className="diff-lens-name">{item.title}</span>
                      {item.pending ? (
                        <span
                          className="diff-counts"
                          aria-label="Counting changes"
                        >
                          …
                        </span>
                      ) : fileLens && item.fileCount === 0 ? (
                        <span className="diff-counts">0 files</span>
                      ) : (
                        <DiffCounts progress={stats} />
                      )}
                    </button>
                    <ViewedButton
                      progress={stats}
                      disabled={
                        lenses.busy || !!item.unavailable || !!item.pending
                      }
                      label={`Mark ${item.title} viewed`}
                      onClick={() =>
                        void lenses.mark(
                          item.sources,
                          stats.state !== "viewed",
                          selected,
                        )
                      }
                    />
                  </div>
                  {selected && block && !fileLens && (
                    <LensDiagram
                      block={block}
                      currentStepId={
                        current?.lensId === item.id ? current.stepId : null
                      }
                      onReveal={(source, sectionId) =>
                        activeHandle.current?.revealSource?.(source, sectionId)
                      }
                    />
                  )}
                </section>
              );
            })}
            {lenses.progress && !lenses.diagrams.length && (
              <p className="lens-diagram-note">No lenses in this review yet.</p>
            )}
          </div>
          <div
            {...cabinetsResize.separatorProps}
            className={`side-panel-sheet-resizer diff-cabinets-resizer ${cabinetsResize.isResizing ? "is-resizing" : ""}`}
          />
          <div className="diff-sidebar-files">
            <div className="diff-sidebar-heading diff-files-heading">
              Files <span aria-hidden="true">·</span>{" "}
              {lenses.progress
                ? lens
                  ? new Set(
                      lens.ranges.map(
                        (source) =>
                          lenses.progress!.files.find(
                            (file) =>
                              source.file ===
                              (source.side === "base"
                                ? (file.previousPath ?? file.path)
                                : file.path),
                          )?.path ?? source.file,
                      ),
                    ).size
                  : lenses.progress.files.length
                : "…"}
            </div>
            <div
              className="diff-native-tree"
              ref={setFullTree}
              style={lens ? { display: "none" } : undefined}
            />
            <div
              className="diff-native-tree"
              ref={setLensTree}
              style={!lens ? { display: "none" } : undefined}
            />
          </div>
        </div>
      </aside>
      <div
        {...sidebarResize.separatorProps}
        className={`side-panel-resizer diff-sidebar-resizer ${sidebarResize.isResizing ? "is-resizing" : ""}`}
      />
      <div className="diff-workspace-editor">
        {fullTree && (
          <NativeDiffView
            treeContainer={fullTree}
            progress={fullProgress}
            onToggleViewed={(path) => markFile(path, false)}
            hidden={!!lens}
          />
        )}
        {lens && lensTree && (
          <NativeDiffView
            lens={lens}
            treeContainer={lensTree}
            progress={lensProgress}
            onToggleViewed={(path, sectionId) =>
              markFile(path, true, sectionId)
            }
            onToggleSection={(id) => {
              const section = sections.find((section) => section.id === id);

              if (section)
                void lenses.mark(
                  section.sources,
                  lenses.stats(section.sources).state !== "viewed",
                );
            }}
            onHandle={(handle) => {
              activeHandle.current = handle;
              setHandle(handle);
            }}
          />
        )}
        {lenses.error && (
          <div className="diff-workspace-error" role="alert">
            {lenses.error}
          </div>
        )}
      </div>
    </div>
  );
}

function NativeDiffView({
  scope,
  lens,
  treeContainer,
  progress,
  onToggleViewed,
  onToggleSection,
  onHandle,
  hidden = false,
}: {
  scope?: ReviewCommitScope;
  lens?: ReviewDiffLens;
  treeContainer?: HTMLElement;
  progress?: ReviewDiffProgress;
  onToggleViewed?(path: string, sectionId?: string): void;
  onToggleSection?(id: string): void;
  onHandle?(handle: ReviewDiffViewHandle | null): void;
  hidden?: boolean;
}) {
  const session = useReviewSession();
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const handle = useRef<ReviewDiffViewHandle | null>(null);

  const current = useRef({
    progress,
    onToggleViewed,
    onToggleSection,
    onHandle,
  });

  current.current = { progress, onToggleViewed, onToggleSection, onHandle };
  useLayoutEffect(() => {
    if (!container) return;
    setError(null);

    try {
      const view = session.bridge.diffView.create({
        container,
        scope,
        lens,
        fileTreeContainer: treeContainer,
        progress: current.current.progress,
        onToggleViewed: current.current.onToggleViewed
          ? (path, sectionId) =>
              current.current.onToggleViewed?.(path, sectionId)
          : undefined,
        onToggleSection: (id) => current.current.onToggleSection?.(id),
      });

      handle.current = view;
      current.current.onHandle?.(view);
      const subscription = view.onDidError(setError);

      return () => {
        subscription.dispose();
        current.current.onHandle?.(null);
        view.dispose();
        handle.current = null;
      };
    } catch (error) {
      setError(String(error));
    }
  }, [
    container,
    session.bridge.diffView,
    session.config.reviewId,
    scope?.commit,
    lens,
    treeContainer,
  ]);
  useLayoutEffect(() => {
    if (progress) handle.current?.setProgress?.(progress);
  }, [progress]);

  return (
    <>
      <div
        ref={setContainer}
        className="review-diff-view-host"
        style={hidden ? { display: "none" } : undefined}
      />
      {!hidden && error && (
        <div role="alert" className="review-diff-view-error">
          {error}
        </div>
      )}
    </>
  );
}

function LensIcon({ kind }: { kind: string }) {
  return (
    <svg
      className="diff-lens-icon"
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      aria-hidden="true"
    >
      {kind === "file_lens" ? (
        <path d="M2 2h5l2 2h5v10H2zM2 6h12" />
      ) : kind === "sequence" ? (
        <>
          <path d="M3 1v14M13 1v14M3 5h10M13 10H3M10 3l3 2-3 2M6 8l-3 2 3 2" />
        </>
      ) : kind === "call_stack_diff" ? (
        <>
          <rect x="1" y="1" width="8" height="4" rx="1" />
          <rect x="7" y="11" width="8" height="4" rx="1" />
          <path d="M5 5v5h6v1" />
        </>
      ) : kind === "database_lens" ? (
        <>
          <ellipse cx="8" cy="3" rx="6" ry="2" />
          <path d="M2 3v10c0 3 12 3 12 0V3M2 8c0 3 12 3 12 0" />
        </>
      ) : (
        <>
          <rect x="5" y="1" width="6" height="4" rx="1" />
          <rect x="1" y="11" width="5" height="4" rx="1" />
          <rect x="10" y="11" width="5" height="4" rx="1" />
          <path d="M8 5v3H3v3M8 8h5v3" />
        </>
      )}
    </svg>
  );
}
