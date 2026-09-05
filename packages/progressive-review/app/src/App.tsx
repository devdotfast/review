import {
  type JsonValue,
  type ReviewCanvasRange,
  type ReviewCommitSummary,
  isJsonObject,
  jsonArray,
} from "@dev.fast/review-protocol";
import {
  type CSSProperties,
  type ComponentType,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { AnchorRef } from "../../src/authoring";
import {
  type SoftwareMapTopologyDiff,
  diffSoftwareMaps,
} from "../../src/software-map-topology-diff";
import { BugReportControl } from "./bug-report-dialog";
import {
  ReviewDebugSettingsProvider,
  type ReviewNodeTint,
  useReviewDebugSettings,
} from "./debug-settings";
import { ReviewDiffView } from "./DiffView";
import {
  type SelectionTarget,
  observeDocumentSelection,
  selectionCommentTarget,
} from "./document-selection";
import { useReviewSession } from "./host/review-session";
import {
  CommentIcon,
  SettingsSlidersIcon,
  TerminalIcon,
  ThreadsIcon,
} from "./icons";
import { RepairReview } from "./republish-review";
import { ReviewPanelHost } from "./review-components";
import {
  ReviewProvider,
  type ReviewSubmissionOutcome,
  commentDraftTargetForSurface,
  isGlobalCommentDraft,
  openThreadsWithDraftCleanup,
  useReview,
} from "./review-context";
import { ReviewCornerAction } from "./review-corner-action";
import {
  ReviewDiffFilesProvider,
  useReviewDiffFiles,
} from "./review-diff-files-context";
import { ReviewDocumentBoundary } from "./review-document-boundary";
import { reportReviewDocumentRenderError } from "./review-document-error-report";
import { ReviewDocumentContent } from "./review-document-surface";
import type { ReadyReviewDocumentEntry } from "./review-documents-runtime";
import {
  type ReviewFindHost,
  ReviewFindProvider,
  useReviewFindRegistration,
} from "./review-find";
import { ReviewHistoryControl } from "./review-history-control";
import { useReviewInitialData } from "./review-initial-data-context";
import {
  ReviewPanelProvider,
  useReviewPanel,
  useReviewPanelStore,
  useSuppressPanelMotionOnCanvasResume,
} from "./review-panel";
import { ReviewRootsProvider } from "./review-root-context";
import { targetQuote } from "./review-threads";
import { ReviewToc } from "./review-toc";
import {
  type ReviewView,
  normalizeReviewView,
  reviewViewLabel,
  shouldCloseSidePeekForReviewView,
} from "./review-view-route";
import {
  ReviewViewStateProvider,
  useReviewViewStateSync,
} from "./review-view-state";
import { ReviewCommitsView } from "./ReviewCommitsView";
import { ReviewTraceView, type TraceSelection } from "./ReviewTraceView";
import { useRightPanelResize } from "./side-panel-resizer";
import { selectActiveSoftwareMapModel } from "./software-map-selection";
import type {
  NormalizedSoftwareElement,
  NormalizedSoftwareModel,
} from "./software-map/model";
import { SoftwareMapTopologyUnavailable } from "./software-map/software-map-absence";
import { SoftwareMap } from "./software-map/SoftwareMap";
import { ThreadAnnotations } from "./thread-annotations";
import { ThreadDraftCard } from "./thread-card";
import { ThreadTargetModelProvider } from "./thread-target-model";
import { TutorialExperienceProvider } from "./tutorial-experience";
import { captureClientError, captureUiEvent } from "./ui-telemetry";
import { useReviewTabTelemetry } from "./use-review-tab-telemetry";

const DEFAULT_SIDE_PEEK_WIDTH = 560;
const MIN_SIDE_PEEK_WIDTH = 360;
const MAX_SIDE_PEEK_WIDTH = 920;
const MIN_DOCUMENT_WIDTH = 560;
const EMPTY_ANCHORS = new Map<string, AnchorRef>();
const EMPTY_ANCHOR_CONTENTS = new Map<string, string>();

export function App({
  notice,
  documentState,
  softwareMapState,
  softwareMapEnabled,
  range,
  commits,
  findHost,
}: {
  notice?: ReactNode;
  documentState: ReviewDocumentAppState;
  softwareMapState: ReviewSoftwareMapAppState;
  softwareMapEnabled: boolean;
  range: ReviewCanvasRange;
  commits: readonly ReviewCommitSummary[];
  findHost?: ReviewFindHost;
}): ReactElement {
  useWindowErrorTelemetry();
  return (
    <ReviewDocumentApp
      notice={notice}
      documentState={documentState}
      softwareMapState={softwareMapState}
      softwareMapEnabled={softwareMapEnabled}
      range={range}
      commits={commits}
      findHost={findHost}
    />
  );
}

export interface PublishedSoftwareMap {
  head: NormalizedSoftwareModel;
  base: NormalizedSoftwareModel;
}

export type ReviewDocumentAppState =
  | { state: "loading" }
  | { state: "ready"; document: ReadyReviewDocumentEntry }
  | {
      state: "needs-republish";
      reviewUuid: string;
      mapStale: boolean;
      recovery?: boolean;
    }
  | { state: "unavailable"; message: string; currentReviewUuid?: string };

export type ReviewSoftwareMapAppState =
  | { state: "loading" }
  | { state: "ready"; softwareMap: PublishedSoftwareMap }
  | { state: "absent" }
  | { state: "needs-republish"; reviewUuid: string; recovery?: boolean }
  | { state: "unavailable"; message: string; currentReviewUuid?: string };

function ReviewDocumentApp({
  notice,
  documentState,
  softwareMapState,
  softwareMapEnabled,
  range,
  commits,
  findHost,
}: {
  notice?: ReactNode;
  documentState: ReviewDocumentAppState;
  softwareMapState: ReviewSoftwareMapAppState;
  softwareMapEnabled: boolean;
  range: ReviewCanvasRange;
  commits: readonly ReviewCommitSummary[];
  findHost?: ReviewFindHost;
}): ReactElement {
  const session = useReviewSession();
  const document =
    documentState.state === "ready" ? documentState.document : null;
  const documentRoute = document?.routePath ?? session.config.routePath ?? "/";
  const documentFile = document?.filePath ?? documentRoute;
  const diffDocumentKey = [documentRoute, documentFile].join("\0");
  return (
    <ReviewDiffFilesProvider documentKey={diffDocumentKey}>
      <ReviewLayout
        notice={notice}
        documentState={documentState}
        softwareMapState={softwareMapState}
        softwareMapEnabled={softwareMapEnabled}
        range={range}
        commits={commits}
        findHost={findHost}
      />
    </ReviewDiffFilesProvider>
  );
}

function useWindowErrorTelemetry(): void {
  const session = useReviewSession();
  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      captureClientError(session, "window", event.error);
    };
    window.addEventListener("error", handleError);
    return () => window.removeEventListener("error", handleError);
  }, [session]);
}

function ReviewLayout({
  notice,
  documentState,
  softwareMapState,
  softwareMapEnabled,
  range,
  commits,
  findHost,
}: {
  notice?: ReactNode;
  documentState: ReviewDocumentAppState;
  softwareMapState: ReviewSoftwareMapAppState;
  softwareMapEnabled: boolean;
  range: ReviewCanvasRange;
  commits: readonly ReviewCommitSummary[];
  findHost?: ReviewFindHost;
}): ReactElement {
  const session = useReviewSession();
  const document =
    documentState.state === "ready" ? documentState.document : null;
  const softwareMap =
    softwareMapState.state === "ready" ? softwareMapState.softwareMap : null;
  const documentRoute = document?.routePath ?? session.config.routePath ?? "/";
  const documentRevision =
    document?.contentHash ?? `${documentState.state}:${documentRoute}`;
  const articleRef = useRef<HTMLElement | null>(null);
  const appRef = useRef<HTMLDivElement | null>(null);
  const shellRef = useRef<HTMLElement | null>(null);
  const scrollRegionRef = useRef<HTMLElement | null>(null);
  const [traceSelection, setTraceSelection] = useState<
    TraceSelection | undefined
  >(undefined);
  const roots = useMemo(
    () => ({ appRef, shellRef, scrollRegionRef, articleRef }),
    [],
  );
  return (
    <ReviewRootsProvider roots={roots}>
      <ReviewFindProvider
        articleRef={articleRef}
        scrollRegionRef={scrollRegionRef}
        documentKey={documentRevision}
        host={findHost}
      >
        <ThreadTargetModelProvider
          anchors={document?.anchors ?? EMPTY_ANCHORS}
          anchorContents={document?.anchorContents ?? EMPTY_ANCHOR_CONTENTS}
          documentRoute={documentRoute}
        >
          <ReviewDebugSettingsProvider>
            <ReviewProvider
              key={documentRoute}
              documentRoute={documentRoute}
              softwareMapEnabled={softwareMapEnabled}
              openTraceSession={setTraceSelection}
            >
              <ReviewPanelProvider detailRevision={documentRevision}>
                <ReviewLayoutContent
                  notice={notice}
                  appRef={appRef}
                  shellRef={shellRef}
                  scrollRegionRef={scrollRegionRef}
                  articleRef={articleRef}
                  documentState={documentState}
                  documentRevision={documentRevision}
                  softwareModels={[
                    ...(softwareMap ? [softwareMap.head] : []),
                    ...(document?.documentSoftwareModels ?? []),
                  ]}
                  softwareMapState={softwareMapState}
                  repoSoftwareMap={softwareMap?.head ?? null}
                  baseSoftwareMap={softwareMap?.base ?? null}
                  softwareMapTopologyDiff={
                    softwareMap
                      ? diffSoftwareMaps(softwareMap.base, softwareMap.head)
                      : null
                  }
                  softwareMapEnabled={softwareMapEnabled}
                  range={range}
                  commits={commits}
                  traceSelection={traceSelection}
                />
              </ReviewPanelProvider>
            </ReviewProvider>
          </ReviewDebugSettingsProvider>
        </ThreadTargetModelProvider>
      </ReviewFindProvider>
    </ReviewRootsProvider>
  );
}

function ReviewLayoutContent({
  notice,
  appRef,
  shellRef,
  scrollRegionRef,
  articleRef,
  documentState,
  documentRevision,
  softwareModels,
  softwareMapState,
  repoSoftwareMap,
  baseSoftwareMap,
  softwareMapTopologyDiff,
  softwareMapEnabled,
  range,
  commits,
  traceSelection,
}: {
  notice?: ReactNode;
  appRef: RefObject<HTMLDivElement | null>;
  shellRef: RefObject<HTMLElement | null>;
  scrollRegionRef: RefObject<HTMLElement | null>;
  articleRef: RefObject<HTMLElement | null>;
  documentState: ReviewDocumentAppState;
  documentRevision: string;
  softwareModels: NormalizedSoftwareModel[];
  softwareMapState: ReviewSoftwareMapAppState;
  repoSoftwareMap: NormalizedSoftwareModel | null;
  baseSoftwareMap: NormalizedSoftwareModel | null;
  softwareMapTopologyDiff: SoftwareMapTopologyDiff | null;
  softwareMapEnabled: boolean;
  range: ReviewCanvasRange;
  commits: readonly ReviewCommitSummary[];
  traceSelection?: TraceSelection;
}): ReactElement {
  const session = useReviewSession();
  const review = useReview();
  const panelStore = useReviewPanelStore();
  useSuppressPanelMotionOnCanvasResume(appRef);
  const activePanel = useReviewPanel((state) => state.active);
  const panelMotion = useReviewPanel((state) => state.motion);
  const closeForDocumentChange = useReviewPanel(
    (state) => state.closeForDocumentChange,
  );
  const closeForAgentTerminal = useReviewPanel(
    (state) => state.closeForAgentTerminal,
  );
  const openThreads = useReviewPanel((state) => state.openThreads);
  const debugSettings = useReviewDebugSettings();
  const sidePeekResize = useRightPanelResize({
    stateKey: "side-peek-width",
    defaultWidth: DEFAULT_SIDE_PEEK_WIDTH,
    minWidth: MIN_SIDE_PEEK_WIDTH,
    maxWidth: MAX_SIDE_PEEK_WIDTH,
    minMainWidth: MIN_DOCUMENT_WIDTH,
    separatorWidth: 10,
    label: "Resize side peek",
    containerRef: appRef,
  });
  const viewStateSync = useReviewViewStateSync({ scrollRegionRef, panelStore });
  const hasChangeRange = range.baseCommit !== range.headCommit;
  const [activeView, setActiveView] = useState<ReviewView>(() =>
    normalizeReviewView(
      viewStateSync.initialActiveView ?? "review",
      softwareMapEnabled,
      hasChangeRange,
    ),
  );
  const [diffScope, setDiffScope] = useState<ReviewCommitSummary | null>(null);
  const reviewFind = useReviewFindRegistration();
  useEffect(() => {
    reviewFind?.setReviewActive(activeView === "review");
  }, [activeView, reviewFind]);
  const initialDiffStats = useReviewInitialData()?.diffStats;
  const [hasTraceSessions, setHasTraceSessions] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    session
      .fetch("/agent-traces", { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) return;
        const data: JsonValue = await res.json();
        const sessions =
          isJsonObject(data) && data.ok === true
            ? jsonArray(data.sessions)
            : undefined;
        if (sessions !== undefined && sessions.length > 0) {
          setHasTraceSessions(true);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [session]);
  const diffFiles = useReviewDiffFiles();
  const filesTabFileCount = diffScope
    ? diffScope.fileCount
    : diffFiles.status === "loaded"
      ? diffFiles.files.length
      : (initialDiffStats?.files?.length ?? null);
  const reviewViews: readonly ReviewView[] = [
    "review",
    ...(hasChangeRange ? (["commits", "diff"] as const) : []),
    ...(softwareMapEnabled ? (["map"] as const) : []),
    ...(hasTraceSessions ? (["trace"] as const) : []),
  ];
  const reviewViewsRef = useRef(reviewViews);
  reviewViewsRef.current = reviewViews;
  const applyReviewView = (view: ReviewView) => {
    const normalizedView = normalizeReviewView(
      view,
      softwareMapEnabled,
      hasChangeRange,
    );
    if (normalizedView !== "diff") setDiffScope(null);
    if (shouldCloseSidePeekForReviewView(normalizedView)) {
      closeForDocumentChange();
    }
    setActiveView(normalizedView);
    viewStateSync.persistActiveView(normalizedView);
  };
  useEffect(() => {
    if (
      normalizeReviewView(activeView, softwareMapEnabled, hasChangeRange) !==
      activeView
    ) {
      applyReviewView("review");
    }
  }, [activeView, hasChangeRange, softwareMapEnabled]);
  useReviewTabTelemetry(activeView);
  const threadCount = review.allCommentThreads().length;
  const askPanelOpen =
    activePanel?.kind === "threads" && activePanel.page.kind === "new-ask";
  /* An open review batch means the next thing you write most likely joins it,
     so every entry point says "Comment" rather than "Ask". */
  const askOrCommentLabel =
    review.pendingCommentCount > 0 ? "New comment" : "New ask";
  const threadsPanelOpen =
    activePanel?.kind === "threads" && activePanel.page.kind !== "new-ask";
  useEffect(
    () =>
      session.surface.subscribe((event) => {
        if (
          event.event === "agentTerminalOpening" &&
          event.sessionId === session.config.sessionId
        ) {
          closeForAgentTerminal();
        }
      }),
    [closeForAgentTerminal, session],
  );
  useEffect(() => {
    if (traceSelection) {
      applyReviewView("trace");
    }
  }, [traceSelection]);

  useEffect(() => {
    if (!softwareMapEnabled || !review.softwareMapFocusRequest) return;
    applyReviewView("map");
  }, [review.softwareMapFocusRequest, softwareMapEnabled]);
  const applyReviewViewRef = useRef(applyReviewView);
  applyReviewViewRef.current = applyReviewView;
  // Subscribe before the canvas signals ready so a reveal immediately after
  // mounting cannot outrun the listener.
  useLayoutEffect(() => {
    return session.surface.subscribe((event) => {
      if (
        event.event === "showReviewView" &&
        reviewViewsRef.current.includes(event.view)
      ) {
        applyReviewViewRef.current(event.view);
      }
    });
  }, [session.surface]);
  const activeSoftwareMapSource = useMemo(
    () =>
      selectActiveSoftwareMapModel({
        softwareModels,
        focusElementPath: review.softwareMapFocusRequest?.elementPath,
      }),
    [review.softwareMapFocusRequest?.elementPath, softwareModels],
  );
  const activeSoftwareMap = useMemo(
    () =>
      applySoftwareMapTopologyStatuses(
        activeSoftwareMapSource,
        softwareMapTopologyDiff,
      ),
    [activeSoftwareMapSource, softwareMapTopologyDiff],
  );
  const rightPanelOpen = activePanel !== null;
  const mapOverlayOpen = useMapOverlayOpen(appRef);
  // SAFETY: `--side-peek-width` is a CSS custom property, which React forwards
  // to style.setProperty; the CSSProperties typings only omit custom names.
  const appStyle = rightPanelOpen
    ? ({
        "--side-peek-width": `${sidePeekResize.width}px`,
      } as CSSProperties)
    : undefined;
  const appClassName = [
    "review-app",
    `review-app--theme-${debugSettings.theme}`,
    `review-app--tint-${debugSettings.nodeTint}`,
    rightPanelOpen ? "review-app--peek-open" : null,
    sidePeekResize.isResizing ? "review-app--resizing" : null,
    panelMotion === "restored" ? "review-app--restored-panel" : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div ref={appRef} className={appClassName} style={appStyle}>
      <main
        ref={shellRef}
        className={
          review.historicalRevision
            ? "review-document-shell review-document-shell--historical"
            : "review-document-shell"
        }
      >
        <TutorialExperienceProvider
          shellRef={shellRef}
          scrollRegionRef={scrollRegionRef}
        >
          <div className="review-navigation-header">
            <header className="review-topbar">
              <div className="review-topbar-left">
                <div
                  className="review-segmented"
                  role="group"
                  aria-label="Review views"
                >
                  {reviewViews.map((view) => (
                    <button
                      key={view}
                      type="button"
                      aria-label={
                        view === "map"
                          ? "Map (Experimental)"
                          : reviewViewLabel(view)
                      }
                      aria-pressed={activeView === view}
                      title={view === "map" ? "Map (Experimental)" : undefined}
                      className={
                        activeView === view
                          ? "review-segment review-segment--active"
                          : "review-segment"
                      }
                      onClick={() => applyReviewView(view)}
                    >
                      <span>{reviewViewLabel(view)}</span>
                      {view === "diff" && filesTabFileCount !== null && (
                        <span className="review-segment-count">
                          {filesTabFileCount}
                        </span>
                      )}
                      {view === "commits" && (
                        <span className="review-segment-count">
                          {commits.length}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="review-open-source-tree"
                  title="Open the read-only source tree"
                  onClick={() => {
                    captureUiEvent(session, "source_tree_opened", {
                      via: "topbar",
                    });
                    session.surface.post({ name: "openSourceTree", args: {} });
                  }}
                >
                  Open source tree ↗
                </button>
              </div>
              <div className="review-topbar-actions">
                <ReviewHistoryControl />
                <BugReportControl />
                <ReviewBatonChip outcome={review.submissionOutcome} />
                <div
                  className={
                    threadsPanelOpen || askPanelOpen
                      ? "topbar-threads-split topbar-threads-split--active"
                      : "topbar-threads-split"
                  }
                  role="group"
                  aria-label="Threads"
                >
                  <button
                    type="button"
                    className={
                      threadsPanelOpen
                        ? "topbar-threads-button topbar-threads-button--active"
                        : "topbar-threads-button"
                    }
                    onClick={() => {
                      captureUiEvent(session, "threads_opened", {
                        thread_count: threadCount,
                      });
                      session.surface.showThreads();
                      openThreadsWithDraftCleanup({
                        draftTarget: review.draftTarget,
                        closeCommentDraft: review.closeCommentDraft,
                        openThreads,
                      });
                    }}
                    aria-pressed={threadsPanelOpen}
                  >
                    <ThreadsIcon />
                    <span>Threads</span>
                    {threadCount > 0 && (
                      <span className="topbar-threads-count">
                        {threadCount}
                      </span>
                    )}
                  </button>
                  {!review.historicalRevision &&
                    review.submissionOutcome !== "approved" &&
                    review.submissionOutcome !== "dismissed" && (
                      <button
                        type="button"
                        className={
                          askPanelOpen
                            ? "topbar-new-ask-button topbar-new-ask-button--active"
                            : "topbar-new-ask-button"
                        }
                        aria-pressed={askPanelOpen}
                        aria-label={askOrCommentLabel}
                        title={askOrCommentLabel}
                        onClick={() => {
                          captureUiEvent(session, "new_ask_opened", {
                            via: "topbar",
                          });
                          session.surface.showThreads();
                          openThreads({ kind: "new-ask" });
                        }}
                      >
                        <TerminalIcon />
                      </button>
                    )}
                </div>
                {!review.historicalRevision && !review.submissionOutcome && (
                  <div className="topbar-actions-divider" />
                )}
                {!review.historicalRevision && !review.submissionOutcome ? (
                  <ReviewCornerAction />
                ) : null}
              </div>
            </header>
            {notice}
          </div>
          {review.historicalRevision ? (
            <div className="review-history-banner" role="status">
              <span>You are viewing an older version of this review.</span>
              <button
                type="button"
                onClick={() =>
                  void session.surface.post({
                    name: "openReviewRevision",
                    args: {},
                  })
                }
              >
                Back to latest
              </button>
            </div>
          ) : null}
          <section
            ref={scrollRegionRef}
            className={`review-view-region review-view-region--${activeView}`}
            data-review-scroll-owner={
              activeView === "review" ? "document" : undefined
            }
          >
            <div
              className="review-document-view"
              hidden={activeView !== "review"}
            >
              {documentState.state === "ready" ? (
                <>
                  <ReviewToc />
                  <ReviewDocumentSelectionSurface articleRef={articleRef}>
                    <ReviewDocumentBoundary
                      key={documentRevision}
                      session={session}
                      revision={documentRevision}
                      onError={(_revision, error) =>
                        reportReviewDocumentRenderError(session, error)
                      }
                    >
                      <ReviewViewStateProvider
                        tourRestore={viewStateSync.tourRestore}
                        persistOverlayTour={viewStateSync.persistOverlayTour}
                      >
                        <ReviewDocumentContent
                          body={documentState.document.body}
                        />
                      </ReviewViewStateProvider>
                    </ReviewDocumentBoundary>
                    <ThreadAnnotations
                      articleRef={articleRef}
                      onOpenInPanel={(thread) => {
                        session.surface.showThreads();
                        openThreads({
                          kind: "comment",
                          threadId: thread.threadId,
                        });
                      }}
                    />
                  </ReviewDocumentSelectionSurface>
                </>
              ) : (
                <ReviewDocumentLoadState state={documentState} />
              )}
            </div>
            {softwareMapEnabled && activeView === "map" && (
              <div className="review-map-view">
                <div className="review-map-canvas-shell">
                  {softwareMapState.state === "loading" ? (
                    <MapLoadState message="Loading software map…" />
                  ) : softwareMapState.state === "needs-republish" ? (
                    <RepairReview
                      reviewUuid={softwareMapState.reviewUuid}
                      mapStale
                    />
                  ) : softwareMapState.state === "unavailable" ? (
                    <MapLoadState
                      message={`Software map unavailable: ${softwareMapState.message}`}
                      currentReviewUuid={softwareMapState.currentReviewUuid}
                      alert
                    />
                  ) : (
                    <>
                      <SoftwareMapTopologyUnavailable
                        repoSoftwareMap={repoSoftwareMap}
                        baseSoftwareMap={baseSoftwareMap}
                        baseRef={review.resolvedBaseRef ?? undefined}
                        headRef={review.resolvedHeadRef ?? undefined}
                      />
                      <SoftwareMap
                        model={activeSoftwareMap ?? undefined}
                        focusRequest={review.softwareMapFocusRequest}
                        height="100%"
                        showChrome={false}
                        showFloatingActions={!activePanel}
                        registerTargets={false}
                      />
                      <MapSettingsControl />
                    </>
                  )}
                </div>
              </div>
            )}
            {activeView === "commits" && (
              <ReviewCommitsView
                commits={commits}
                range={range}
                onOpenDiff={(commit, via) => {
                  setDiffScope(commit);
                  captureUiEvent(session, "commit_diff_opened", { via });
                  applyReviewView("diff");
                }}
              />
            )}
            <div
              aria-hidden={activeView !== "diff" || diffScope !== null}
              className={
                activeView === "diff" && diffScope === null
                  ? "review-diff-view"
                  : "review-diff-view review-diff-view--preloaded"
              }
            >
              <ReviewDiffView />
            </div>
            {activeView === "diff" && diffScope !== null && (
              <div className="review-diff-view review-diff-view--scoped">
                <CommitDiffScopeBar
                  commit={diffScope}
                  onBack={() => {
                    setDiffScope(null);
                    applyReviewView("commits");
                  }}
                />
                <ReviewDiffView scope={{ commit: diffScope.commit }} />
              </div>
            )}
            {activeView === "trace" && (
              <ReviewTraceView initialSelection={traceSelection} />
            )}
          </section>
        </TutorialExperienceProvider>
      </main>
      {rightPanelOpen && (
        <div
          className="side-panel-resizer side-peek-resizer"
          {...sidePeekResize.separatorProps}
        />
      )}
      <div className="review-detail-host">
        <ReviewPanelHost />
      </div>
      {commentDraftTargetForSurface(review.draftTarget, "document") &&
        (isGlobalCommentDraft(review.draftTarget) ||
          activeView !== "review" ||
          mapOverlayOpen) && <FloatingDraftHost />}
    </div>
  );
}

function ReviewDocumentLoadState({
  state,
}: {
  state: Exclude<ReviewDocumentAppState, { state: "ready" }>;
}): ReactElement {
  if (state.state === "loading") {
    return (
      <div className="review-document-load-state" role="status">
        Still loading this review…
      </div>
    );
  }
  if (state.state === "needs-republish") {
    return (
      <RepairReview reviewUuid={state.reviewUuid} mapStale={state.mapStale} />
    );
  }
  return (
    <div className="review-document-load-state" role="alert">
      <h2>Review unavailable</h2>
      <p>{state.message}</p>
      {state.currentReviewUuid ? (
        <OpenCurrentReview reviewUuid={state.currentReviewUuid} />
      ) : null}
    </div>
  );
}

function MapLoadState({
  message,
  alert = false,
  currentReviewUuid,
}: {
  message: string;
  alert?: boolean;
  currentReviewUuid?: string;
}): ReactElement {
  return (
    <div
      className="review-document-load-state"
      role={alert ? "alert" : "status"}
    >
      {message}
      {currentReviewUuid ? (
        <OpenCurrentReview reviewUuid={currentReviewUuid} />
      ) : null}
    </div>
  );
}

function OpenCurrentReview({
  reviewUuid,
}: {
  reviewUuid: string;
}): ReactElement {
  const session = useReviewSession();
  return (
    <button
      type="button"
      onClick={() =>
        void session.surface.post({
          name: "openReview",
          args: { reviewUuid, active: true },
        })
      }
    >
      Open current review
    </button>
  );
}

function CommitDiffScopeBar({
  commit,
  onBack,
}: {
  commit: ReviewCommitSummary;
  onBack: () => void;
}) {
  return (
    <div className="review-diff-scope-bar">
      <div className="review-diff-scope-summary">
        <span className="review-diff-scope-label">Viewing</span>
        <code>{commit.commit.slice(0, 8)}</code>
      </div>
      <button type="button" onClick={onBack}>
        <span aria-hidden="true">←</span> Back to commits
      </button>
    </div>
  );
}

/**
 * Reports where the baton sits after the reader acts. It renders nothing while
 * the review is simply waiting: the corner action already says what to do, and
 * a standing "awaiting your review" chip was noise on every review.
 */
function ReviewBatonChip({
  outcome,
}: {
  outcome: ReviewSubmissionOutcome | null;
}): ReactElement | null {
  if (!outcome) return null;
  const label =
    outcome === "changes-requested"
      ? "agent is updating"
      : outcome === "approved"
        ? "approved"
        : "dismissed";
  return (
    <span className={`review-baton-chip review-baton-chip--${outcome}`}>
      {outcome === "changes-requested" && (
        <span className="review-baton-dot" aria-hidden="true" />
      )}
      {outcome === "approved" && (
        <svg
          className="review-baton-glyph"
          viewBox="0 0 12 12"
          width="12"
          height="12"
          aria-hidden="true"
        >
          <path d="m2 6.2 2.5 2.5L10 3.3" />
        </svg>
      )}
      {outcome === "dismissed" && (
        <svg
          className="review-baton-glyph"
          viewBox="0 0 16 16"
          width="12"
          height="12"
          aria-hidden="true"
        >
          <rect x="1.6" y="2.6" width="12.8" height="3.4" rx="1" />
          <path d="M3 6v6.2a1.2 1.2 0 0 0 1.2 1.2h7.6A1.2 1.2 0 0 0 13 12.2V6" />
        </svg>
      )}
      <span>{label}</span>
    </span>
  );
}

function useMapOverlayOpen(appRef: RefObject<HTMLDivElement | null>): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const app = appRef.current;
    if (!app) return;
    const update = () =>
      setOpen(Boolean(app.querySelector(".software-map-overlay")));
    update();
    const observer = new MutationObserver(update);
    observer.observe(app, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [appRef]);
  return open;
}

function FloatingDraftHost(): ReactElement | null {
  const review = useReview();
  const draftTarget = commentDraftTargetForSurface(
    review.draftTarget,
    "document",
  );
  if (!draftTarget) return null;
  const draftQuote = draftTarget.title ?? targetQuote(draftTarget.target);
  const submitDraft = (askAgent: boolean, body: string) => {
    const {
      draftSurface: _draftSurface,
      placement: _placement,
      title: _title,
      intent: _intent,
      messageId: _messageId,
      ...input
    } = draftTarget;
    if (askAgent) {
      void review.askAgent({
        ...input,
        messageId: draftTarget.messageId,
        body,
      });
      review.closeCommentDraft();
      return;
    }
    void review
      .saveComment({
        ...input,
        messageId: draftTarget.messageId,
        body,
      })
      .then(() => {
        review.closeCommentDraft();
      });
  };
  return (
    <div className="review-floating-draft">
      <ThreadDraftCard
        quote={draftQuote}
        variant="popover"
        intent={draftTarget.intent}
        onSubmitComment={(body) => submitDraft(false, body)}
        onAskAgent={(body) => submitDraft(true, body)}
        onCancel={() => review.closeCommentDraft()}
      />
    </div>
  );
}

/**
 * Map settings, floating over the map canvas. They used to sit behind a topbar
 * gear that held nothing else, which put map-only controls in front of readers
 * who never open the map.
 */
function MapSettingsControl(): ReactElement {
  const {
    showModifiedOnly,
    setShowModifiedOnly,
    showRemovedNodes,
    setShowRemovedNodes,
    nodeTint,
    setNodeTint,
  } = useReviewDebugSettings();
  const controlRef = useRef<HTMLDivElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const closeOnOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && controlRef.current?.contains(target))
        return;
      setIsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointerDown, true);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener(
        "pointerdown",
        closeOnOutsidePointerDown,
        true,
      );
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [isOpen]);

  return (
    <div
      ref={controlRef}
      className={
        isOpen
          ? "map-settings-control map-settings-control--open"
          : "map-settings-control"
      }
    >
      {isOpen && (
        <section className="map-settings-popover" aria-label="Map settings">
          <DebugSwitch
            label="Show modified nodes only"
            checked={showModifiedOnly}
            onChange={setShowModifiedOnly}
          />
          <DebugSwitch
            label="Show removed nodes"
            checked={showRemovedNodes}
            onChange={setShowRemovedNodes}
          />
          <div
            className="review-debug-theme review-debug-theme--triple"
            role="group"
            aria-label="Node tint"
          >
            <span className="review-debug-group-label">Map node tint</span>
            {(["none", "slate", "mineral"] as const).map((option) => (
              <button
                key={option}
                type="button"
                className={
                  nodeTint === option
                    ? "review-debug-theme-option review-debug-theme-option--active"
                    : "review-debug-theme-option"
                }
                aria-pressed={nodeTint === option}
                onClick={() => setNodeTint(option)}
              >
                {nodeTintLabel(option)}
              </button>
            ))}
          </div>
        </section>
      )}
      <button
        type="button"
        className={
          isOpen
            ? "map-settings-trigger map-settings-trigger--active"
            : "map-settings-trigger"
        }
        aria-label="Map settings"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((open) => !open)}
      >
        <SettingsSlidersIcon />
      </button>
    </div>
  );
}

function DebugSwitch({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}): ReactElement {
  return (
    <label className="review-debug-switch">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <i aria-hidden="true" />
    </label>
  );
}

function nodeTintLabel(tint: ReviewNodeTint) {
  if (tint === "none") return "None";
  return tint === "slate" ? "Slate" : "Mineral";
}

export function applySoftwareMapTopologyStatuses(
  model: NormalizedSoftwareModel | undefined,
  diff: SoftwareMapTopologyDiff | null,
): NormalizedSoftwareModel | undefined {
  if (!model || !diff) return model;
  const elements = model.elements.map((element): NormalizedSoftwareElement => {
    const topologyStatus = diff.elementStatusByPath[element.path];
    return topologyStatus
      ? { ...element, changeStatus: topologyStatus }
      : element;
  });
  return {
    ...model,
    elements,
    elementsByPath: new Map(elements.map((element) => [element.path, element])),
  };
}

function SelectionCommentButton({
  target,
  clearTarget,
}: {
  target: SelectionTarget | null;
  clearTarget: () => void;
}) {
  const review = useReview();
  if (!target || review.historicalRevision) return null;
  return (
    <div
      className="selection-action-buttons selection-action-buttons--anchored"
      style={{ left: target.x, top: target.y }}
    >
      <button
        type="button"
        className="selection-action-segment selection-comment-button"
        aria-label={
          review.pendingCommentCount > 0
            ? "Comment on selection"
            : "Ask about selection"
        }
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          review.openCommentDraft(selectionCommentTarget(target));
          clearTarget();
        }}
      >
        <CommentIcon />
        <span>{review.pendingCommentCount > 0 ? "Comment" : "Ask"}</span>
      </button>
    </div>
  );
}

function ReviewDocumentSelectionSurface({
  articleRef,
  children,
}: {
  articleRef: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const [selectionTarget, setSelectionTarget] =
    useState<SelectionTarget | null>(null);
  useEffect(() => {
    const article = articleRef.current;
    if (!article) return;
    return observeDocumentSelection(article, setSelectionTarget);
  }, [articleRef]);
  return (
    <article ref={articleRef} className="review-document">
      {children}
      <SelectionCommentButton
        target={selectionTarget}
        clearTarget={() => setSelectionTarget(null)}
      />
    </article>
  );
}
