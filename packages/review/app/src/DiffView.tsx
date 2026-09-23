import type {
  ReviewCommitScope,
  ReviewDiffLens,
  ReviewDiffProgress,
  ReviewDiffViewHandle,
} from "@dev.fast/review-protocol";
import {
  type CSSProperties,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { Lens } from "../../src/review-api/diff-lenses";
import {
  type CoverageProgress,
  coverageProgress,
  coverageSources,
} from "../../src/viewed-coverage";
import { AuthoringActivityContext } from "./authoring-activity";
import { scopeLive } from "./authoring-cursor";
import { Courier, LensCursorContext, lensRowElement } from "./courier";
import { compactDiffCount } from "./diff-count";
import { withErasedBlocks } from "./draw-queue";
import { useMotionPhases } from "./draw-queue-provider";
import { useReviewSession } from "./host/review-session";
import { ViewedButton, useReviewLenses } from "./review-lenses";
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
  const [lensList, setLensList] = useState<HTMLDivElement | null>(null);
  const rows = useLensRows(lenses?.lenses ?? []);
  const lensCursor = useContext(LensCursorContext);

  const lensesLive = scopeLive(useContext(AuthoringActivityContext), "lenses");
  const [fullTree, setFullTree] = useState<HTMLDivElement | null>(null);
  const [lensTree, setLensTree] = useState<HTMLDivElement | null>(null);

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
          }
        : undefined,
    [lenses?.progress, lenses?.changedPaths, lenses?.unfoldRanges, lens],
  );

  const markFile = (path: string, scoped: boolean) => {
    const file = lenses?.progress?.files.find((file) => file.path === path);

    if (!file || !lenses) return;

    const sources = scoped
      ? lens?.ranges.filter(
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
            ref={setLensList}
            style={{ flexBasis: `${(1 - cabinetsResize.fraction) * 100}%` }}
          >
            <div className="diff-sidebar-heading">Lenses</div>
            {rows.items.map((item) => {
              const selected = lens?.id === item.id,
                stats = lenses.stats(item.sources),
                phase = rows.phases.get(item.id);

              return (
                <section
                  key={item.id}
                  className={`diff-lens-section ${selected ? "is-expanded" : ""}`}
                  data-lens-id={item.id}
                  data-motion={phase}
                >
                  <div className="diff-lens-row">
                    <button
                      className={`diff-lens-toggle ${selected ? "is-active" : ""} ${stats.state === "viewed" ? "is-viewed" : ""}`}
                      aria-pressed={selected}
                      disabled={!!item.unavailable}
                      title={item.unavailable ?? item.title}
                      onClick={() =>
                        selected ? lenses.clear() : lenses.select(item.id)
                      }
                    >
                      <LensIcon />
                      <span className="diff-lens-name">{item.title}</span>
                      {item.pending ? (
                        <span
                          className="diff-counts"
                          aria-label="Counting changes"
                        >
                          …
                        </span>
                      ) : item.fileCount === 0 ? (
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
                </section>
              );
            })}
            <Courier
              scope="lenses"
              container={lensList}
              find={lensRowElement}
            />
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
            onToggleViewed={(path) => markFile(path, true)}
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
  hidden = false,
}: {
  scope?: ReviewCommitScope;
  lens?: ReviewDiffLens;
  treeContainer?: HTMLElement;
  progress?: ReviewDiffProgress;
  onToggleViewed?(path: string): void;
  hidden?: boolean;
}) {
  const session = useReviewSession();
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const handle = useRef<ReviewDiffViewHandle | null>(null);

  const current = useRef({ progress, onToggleViewed });

  current.current = { progress, onToggleViewed };
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
          ? (path) => current.current.onToggleViewed?.(path)
          : undefined,
      });

      handle.current = view;
      const subscription = view.onDidError(setError);

      return () => {
        subscription.dispose();
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

/** The lens rows on screen: the current lenses plus a removed one while the
 * lens draw queue erases it, and each row's phase. */
function useLensRows<Item extends { id: string }>(items: Item[]) {
  const phases = useMotionPhases("lenses");
  const previous = useRef(items);
  const shown = withErasedBlocks(items, previous.current, phases);

  useEffect(() => {
    previous.current = shown;
  });

  return { items: shown, phases };
}

function LensIcon() {
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
      <path d="M2 2h5l2 2h5v10H2zM2 6h12" />
    </svg>
  );
}
