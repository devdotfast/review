import {
  type WhiteboardCanvasRange,
  type WhiteboardCommitSummary,
} from "@dev.fast/whiteboard-protocol";
import {
  type CSSProperties,
  type ComponentType,
  type ReactElement,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  type SoftwareMapTopologyDiff,
  diffSoftwareMaps,
} from "../../src/software-map-topology-diff";
import { AgentSelectionProvider, useAgentSelection } from "./agent-selection";
import { observeAgentTextSelection } from "./agent-text-selection";
import {
  AuthoringActivityBadge,
  WhiteboardSurfaceLabel,
} from "./authoring-activity";
import { BugReportControl } from "./bug-report-dialog";
import {
  WhiteboardDebugSettingsProvider,
  type WhiteboardNodeTint,
  useWhiteboardDebugSettings,
} from "./debug-settings";
import { DiffLayoutControl } from "./diff-layout-control";
import { WhiteboardDiffView } from "./DiffView";
import { useWhiteboardSession } from "./host/whiteboard-session";
import { DiscordIcon, MarkerUnderline, SettingsSlidersIcon } from "./icons";
import { ShareControl } from "./share-control";
import { useRightPanelResize } from "./side-panel-resizer";
import { selectActiveSoftwareMapModel } from "./software-map-selection";
import type {
  NormalizedSoftwareElement,
  NormalizedSoftwareModel,
} from "./software-map/model";
import { SoftwareMapTopologyUnavailable } from "./software-map/software-map-absence";
import { SoftwareMap } from "./software-map/SoftwareMap";
import { useTutorial } from "./tutorial-context";
import { TutorialExperienceProvider } from "./tutorial-experience";
import { captureClientError, captureUiEvent } from "./ui-telemetry";
import { useTooltip } from "./use-tooltip";
import { useTraceList } from "./use-trace-list";
import { useWhiteboardTabTelemetry } from "./use-whiteboard-tab-telemetry";
import { WhiteboardPanelHost } from "./whiteboard-components";
import {
  WhiteboardProvider,
  type WhiteboardSubmissionOutcome,
  useWhiteboard,
} from "./whiteboard-context";
import { WhiteboardCornerAction } from "./whiteboard-corner-action";
import { useWhiteboardDiffFiles } from "./whiteboard-diff-files-context";
import { WhiteboardDiffFilesProvider } from "./whiteboard-diff-files-context";
import { WhiteboardDocumentBoundary } from "./whiteboard-document-boundary";
import { reportWhiteboardDocumentRenderError } from "./whiteboard-document-error-report";
import { WhiteboardUnavailable } from "./whiteboard-empty-state";
import {
  type WhiteboardFindHost,
  WhiteboardFindProvider,
  useWhiteboardFindRegistration,
} from "./whiteboard-find";
import { useWhiteboardLenses } from "./whiteboard-lenses";
import {
  WhiteboardPanelProvider,
  useSuppressPanelMotionOnCanvasResume,
  useWhiteboardPanel,
  useWhiteboardPanelStore,
} from "./whiteboard-panel";
import { WhiteboardRootsProvider } from "./whiteboard-root-context";
import { WhiteboardToc } from "./whiteboard-toc";
import {
  type WhiteboardView,
  normalizeWhiteboardView,
  shouldCloseSidePeekForWhiteboardView,
  whiteboardViewLabel,
} from "./whiteboard-view-route";
import {
  WhiteboardViewStateProvider,
  useWhiteboardViewStateSync,
} from "./whiteboard-view-state";
import { WhiteboardCommitsView } from "./WhiteboardCommitsView";
import {
  type TraceSelection,
  WhiteboardTraceView,
} from "./WhiteboardTraceView";

const DEFAULT_SIDE_PEEK_WIDTH = 560;

const MIN_SIDE_PEEK_WIDTH = 360;

const MAX_SIDE_PEEK_WIDTH = 920;

const MIN_DOCUMENT_WIDTH = 560;

export function App({
  documentState,
  softwareMapState,
  softwareMapEnabled,
  range,
  commits,
  findHost,
}: {
  documentState: WhiteboardDocumentAppState;
  softwareMapState: WhiteboardSoftwareMapAppState;
  softwareMapEnabled: boolean;
  range: WhiteboardCanvasRange;
  commits: readonly WhiteboardCommitSummary[];
  findHost?: WhiteboardFindHost;
}): ReactElement {
  useWindowErrorTelemetry();
  const resolved = useResolvedWhiteboardDocument(documentState);

  return (
    <WhiteboardDiffFilesProvider documentKey={resolved.diffDocumentKey}>
      <WhiteboardLayout
        resolved={resolved}
        documentState={documentState}
        softwareMapState={softwareMapState}
        softwareMapEnabled={softwareMapEnabled}
        range={range}
        commits={commits}
        findHost={findHost}
      />
    </WhiteboardDiffFilesProvider>
  );
}

export interface PublishedSoftwareMap {
  head: NormalizedSoftwareModel | null;
  base: NormalizedSoftwareModel | null;
}

export interface RenderedWhiteboardDocument {
  render: ComponentType;
  key: string;
  routePath: string;
  filePath: string;
  anchors: ReadonlyMap<
    string,
    import("../../src/whiteboard-document-data").DocumentAnchor
  >;
  documentSoftwareModels: NormalizedSoftwareModel[];
  tocEntries?: import("./whiteboard-document-headings").WhiteboardTocEntry[];
  /** True while the document has no blocks at all, as right after creation. */
  empty?: boolean;
}

export type WhiteboardDocumentAppState =
  | { state: "loading" }
  | {
      state: "ready";
      document: RenderedWhiteboardDocument;
    }
  | {
      state: "unavailable";
      message: string;
      currentWhiteboardUuid?: string;
      /** The failure the loader raised, when the message came from one. */
      cause?: Error;
    };

export type WhiteboardSoftwareMapAppState =
  | { state: "loading" }
  | { state: "ready"; softwareMap: PublishedSoftwareMap }
  | { state: "absent" }
  | {
      state: "unavailable";
      message: string;
      currentWhiteboardUuid?: string;
      cause?: Error;
    };

interface ResolvedWhiteboardDocument {
  document: RenderedWhiteboardDocument | null;
  routePath: string;
  filePath: string;
  /** Identity of what the panes render: content hash, or the load state. */
  revision: string;
  diffDocumentKey: string;
}

function useResolvedWhiteboardDocument(
  documentState: WhiteboardDocumentAppState,
): ResolvedWhiteboardDocument {
  const session = useWhiteboardSession();

  return useMemo(() => {
    const document =
      documentState.state === "ready" ? documentState.document : null;

    const routePath = document?.routePath ?? "/";
    const filePath = document?.filePath ?? routePath;

    return {
      document,
      routePath,
      filePath,
      revision: document?.key ?? `${documentState.state}:${routePath}`,
      diffDocumentKey: [routePath, filePath].join("\0"),
    };
  }, [documentState, session]);
}

function useWindowErrorTelemetry(): void {
  const session = useWhiteboardSession();
  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      captureClientError(session, "window", event.error);
    };

    window.addEventListener("error", handleError);

    return () => window.removeEventListener("error", handleError);
  }, [session]);
}

function WhiteboardLayout({
  resolved,
  documentState,
  softwareMapState,
  softwareMapEnabled,
  range,
  commits,
  findHost,
}: {
  resolved: ResolvedWhiteboardDocument;
  documentState: WhiteboardDocumentAppState;
  softwareMapState: WhiteboardSoftwareMapAppState;
  softwareMapEnabled: boolean;
  range: WhiteboardCanvasRange;
  commits: readonly WhiteboardCommitSummary[];
  findHost?: WhiteboardFindHost;
}): ReactElement {
  const {
    document,
    routePath: documentRoute,
    revision: documentRevision,
  } = resolved;

  const softwareMap =
    softwareMapState.state === "ready" ? softwareMapState.softwareMap : null;

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
    <WhiteboardRootsProvider roots={roots}>
      <WhiteboardFindProvider
        articleRef={articleRef}
        scrollRegionRef={scrollRegionRef}
        documentKey={documentRevision}
        host={findHost}
      >
        <WhiteboardDebugSettingsProvider>
          <WhiteboardProvider
            key={documentRoute}
            documentRoute={documentRoute}
            softwareMapEnabled={softwareMapEnabled}
            openTraceSession={setTraceSelection}
          >
            <AgentSelectionProvider revision={documentRevision}>
              <WhiteboardPanelProvider detailRevision={documentRevision}>
                <WhiteboardLayoutContent
                  appRef={appRef}
                  shellRef={shellRef}
                  scrollRegionRef={scrollRegionRef}
                  articleRef={articleRef}
                  documentState={documentState}
                  documentRevision={documentRevision}
                  softwareModels={[
                    ...(softwareMap?.head ? [softwareMap.head] : []),
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
              </WhiteboardPanelProvider>
            </AgentSelectionProvider>
          </WhiteboardProvider>
        </WhiteboardDebugSettingsProvider>
      </WhiteboardFindProvider>
    </WhiteboardRootsProvider>
  );
}

function WhiteboardLayoutContent({
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
  appRef: RefObject<HTMLDivElement | null>;
  shellRef: RefObject<HTMLElement | null>;
  scrollRegionRef: RefObject<HTMLElement | null>;
  articleRef: RefObject<HTMLElement | null>;
  documentState: WhiteboardDocumentAppState;
  documentRevision: string;
  softwareModels: NormalizedSoftwareModel[];
  softwareMapState: WhiteboardSoftwareMapAppState;
  repoSoftwareMap: NormalizedSoftwareModel | null;
  baseSoftwareMap: NormalizedSoftwareModel | null;
  softwareMapTopologyDiff: SoftwareMapTopologyDiff | null;
  softwareMapEnabled: boolean;
  range: WhiteboardCanvasRange;
  commits: readonly WhiteboardCommitSummary[];
  traceSelection?: TraceSelection;
}): ReactElement {
  const session = useWhiteboardSession();
  const whiteboard = useWhiteboard();
  // The scratchpad is a document and nothing else: no source tree to browse,
  // nothing to share, nothing to dismiss.
  const scratchpad = session.review?.kind === "scratchpad";
  const discordTooltip = useTooltip("Join our Discord community");
  const sourceTreeTooltip = useTooltip("Open full read-only source");
  const panelStore = useWhiteboardPanelStore();
  useSuppressPanelMotionOnCanvasResume(appRef);
  const activePanel = useWhiteboardPanel((state) => state.active);
  const panelMotion = useWhiteboardPanel((state) => state.motion);

  const closeForDocumentChange = useWhiteboardPanel(
    (state) => state.closeForDocumentChange,
  );

  const debugSettings = useWhiteboardDebugSettings();

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

  const viewStateSync = useWhiteboardViewStateSync({
    scrollRegionRef,
    panelStore,
  });
  const hasChangeRange = range.baseCommit !== range.headCommit;

  const [activeView, setActiveView] = useState<WhiteboardView>(() =>
    normalizeWhiteboardView(
      viewStateSync.initialActiveView ?? "review",
      softwareMapEnabled,
      hasChangeRange,
    ),
  );

  // A fresh pinned review opens on the diff: the document is still empty
  // while the agent writes it, and the change is the thing there is to read.
  // Decided once, when the first document arrives, and only when no view is
  // remembered for this review. Not persisted: the reader has chosen nothing.
  const defaultViewDecided = useRef(false);

  useEffect(() => {
    if (defaultViewDecided.current || documentState.state !== "ready") return;
    defaultViewDecided.current = true;

    if (
      viewStateSync.initialActiveView === undefined &&
      hasChangeRange &&
      documentState.document.empty
    ) {
      setActiveView("diff");
    }
  }, [documentState, hasChangeRange, viewStateSync.initialActiveView]);

  const [diffScope, setDiffScope] = useState<WhiteboardCommitSummary | null>(
    null,
  );
  const selectForAgent = useAgentSelection();
  useEffect(() => {
    selectForAgent(null);
  }, [activeView, diffScope, selectForAgent]);
  useEffect(() => {
    const article = articleRef.current;

    if (activeView !== "review" || !article) return;

    return observeAgentTextSelection(article, selectForAgent);
  }, [activeView, documentRevision, articleRef, selectForAgent]);

  const whiteboardFind = useWhiteboardFindRegistration();
  useEffect(() => {
    whiteboardFind?.setWhiteboardActive(activeView === "review");
  }, [activeView, whiteboardFind]);

  const storedList = useTraceList();
  const diffFiles = useWhiteboardDiffFiles();

  // The scratchpad has no repository of its own, so no traces to show.
  const hasTraceSessions =
    !scratchpad &&
    ((session.review?.traces.size ?? 0) > 0 ||
      storedList.status !== "loaded" ||
      storedList.sessions.length > 0);

  const filesTabFileCount = diffScope
    ? diffScope.fileCount
    : diffFiles.status === "loaded"
      ? diffFiles.files.length
      : null;

  const whiteboardViews: readonly WhiteboardView[] = [
    "review",
    ...(hasChangeRange ? (["commits", "diff"] as const) : []),
    ...(softwareMapEnabled ? (["map"] as const) : []),
    ...(hasTraceSessions ? (["trace"] as const) : []),
  ];

  const lenses = useWhiteboardLenses();
  useEffect(() => {
    if (lenses?.active) {
      setDiffScope(null);
      setActiveView("diff");
    }
  }, [lenses?.active]);

  const whiteboardViewsRef = useRef(whiteboardViews);
  whiteboardViewsRef.current = whiteboardViews;

  const applyWhiteboardView = (view: WhiteboardView) => {
    const normalizedView = normalizeWhiteboardView(
      view,
      softwareMapEnabled,
      hasChangeRange,
      hasTraceSessions !== false,
    );

    if (normalizedView !== "diff") setDiffScope(null);

    if (shouldCloseSidePeekForWhiteboardView(normalizedView)) {
      closeForDocumentChange();
    }

    setActiveView(normalizedView);
    viewStateSync.persistActiveView(normalizedView);
  };

  useEffect(() => {
    if (
      normalizeWhiteboardView(
        activeView,
        softwareMapEnabled,
        hasChangeRange,
        hasTraceSessions !== false,
      ) !== activeView
    ) {
      applyWhiteboardView("review");
    }
  }, [activeView, hasChangeRange, hasTraceSessions, softwareMapEnabled]);
  useWhiteboardTabTelemetry(activeView);
  useEffect(() => {
    if (traceSelection) {
      applyWhiteboardView("trace");
    }
  }, [traceSelection]);

  useEffect(() => {
    if (!softwareMapEnabled || !whiteboard.softwareMapFocusRequest) return;
    applyWhiteboardView("map");
  }, [whiteboard.softwareMapFocusRequest, softwareMapEnabled]);
  const applyWhiteboardViewRef = useRef(applyWhiteboardView);
  applyWhiteboardViewRef.current = applyWhiteboardView;

  const tutorial = useTutorial() !== null;

  const tocEntries =
    documentState.state === "ready"
      ? (documentState.document.tocEntries ?? [])
      : [];

  // Subscribe before the canvas signals ready so a reveal immediately after
  // mounting cannot outrun the listener.
  useLayoutEffect(() => {
    return session.surface.subscribe((event) => {
      if (
        event.event === "showWhiteboardView" &&
        whiteboardViewsRef.current.includes(event.view)
      ) {
        applyWhiteboardViewRef.current(event.view);
      }
    });
  }, [session.surface]);

  const activeSoftwareMapSource = useMemo(
    () =>
      selectActiveSoftwareMapModel({
        softwareModels,
        focusElementPath: whiteboard.softwareMapFocusRequest?.elementPath,
      }),
    [whiteboard.softwareMapFocusRequest?.elementPath, softwareModels],
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

  // SAFETY: `--side-peek-width` is a CSS custom property, which React forwards
  // to style.setProperty; the CSSProperties typings only omit custom names.
  const appStyle = rightPanelOpen
    ? ({
        "--side-peek-width": `${sidePeekResize.width}px`,
      } as CSSProperties)
    : undefined;

  const appClassName = [
    "whiteboard-app",
    `whiteboard-app--theme-${debugSettings.theme}`,
    `whiteboard-app--tint-${debugSettings.nodeTint}`,
    rightPanelOpen ? "whiteboard-app--peek-open" : null,
    sidePeekResize.isResizing ? "whiteboard-app--resizing" : null,
    panelMotion === "restored" ? "whiteboard-app--restored-panel" : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div ref={appRef} className={appClassName} style={appStyle}>
      <main
        ref={shellRef}
        className={
          whiteboard.historicalRevision
            ? "whiteboard-document-shell whiteboard-document-shell--historical"
            : "whiteboard-document-shell"
        }
      >
        <TutorialExperienceProvider
          shellRef={shellRef}
          scrollRegionRef={scrollRegionRef}
        >
          <header className="whiteboard-topbar">
            <div className="whiteboard-topbar-left">
              <div
                className="whiteboard-segmented"
                role="group"
                aria-label="Session views"
              >
                {whiteboardViews.map((view) => (
                  <button
                    key={view}
                    type="button"
                    aria-label={
                      view === "map"
                        ? "Map (Experimental)"
                        : whiteboardViewLabel(view)
                    }
                    aria-pressed={activeView === view}
                    title={view === "map" ? "Map (Experimental)" : undefined}
                    className={
                      activeView === view
                        ? "whiteboard-segment whiteboard-segment--active"
                        : "whiteboard-segment"
                    }
                    onClick={() => applyWhiteboardView(view)}
                  >
                    {view === "review" ? (
                      <WhiteboardSurfaceLabel
                        label={scratchpad ? "Scratchpad" : "Whiteboard"}
                        hasContent={
                          documentState.state === "ready" &&
                          documentState.document.empty === false
                        }
                        active={activeView === "review"}
                      />
                    ) : (
                      <span>{whiteboardViewLabel(view)}</span>
                    )}
                    {view === "diff" && filesTabFileCount !== null && (
                      <span className="whiteboard-segment-count">
                        {filesTabFileCount}
                      </span>
                    )}
                    {view === "commits" && (
                      <span className="whiteboard-segment-count">
                        {commits.length}
                      </span>
                    )}
                    <MarkerUnderline />
                  </button>
                ))}
              </div>
            </div>
            <div className="whiteboard-topbar-actions">
              <div className="whiteboard-topbar-context">
                {!scratchpad && (
                  <button
                    type="button"
                    className="whiteboard-open-source-tree"
                    ref={sourceTreeTooltip}
                    onClick={() => {
                      captureUiEvent(session, "source_tree_opened", {
                        via: "topbar",
                      });
                      session.surface.post({
                        name: "openSourceTree",
                        args: {},
                      });
                    }}
                  >
                    Source tree ↗
                  </button>
                )}
                <AuthoringActivityBadge
                  onLocate={(view) => applyWhiteboardView(view)}
                />
              </div>
              {!scratchpad && <ShareControl />}
              <button
                type="button"
                className="whiteboard-topbar-icon-button"
                ref={discordTooltip}
                aria-label="Join our Discord community"
                onClick={() =>
                  session.surface.post({ name: "joinDiscord", args: {} })
                }
              >
                <DiscordIcon />
              </button>
              <BugReportControl />
              <WhiteboardBatonChip outcome={whiteboard.submissionOutcome} />
              <DiffLayoutControl />
              {!scratchpad &&
                !whiteboard.historicalRevision &&
                !whiteboard.submissionOutcome && (
                  <div className="topbar-actions-divider" />
                )}
              {!scratchpad &&
              !whiteboard.historicalRevision &&
              !whiteboard.submissionOutcome ? (
                <WhiteboardCornerAction />
              ) : null}
            </div>
          </header>
          {whiteboard.historicalRevision ? (
            <div className="whiteboard-history-banner" role="status">
              <span>You are viewing an older version of this session.</span>
              <button
                type="button"
                onClick={() =>
                  void session.surface.post({
                    name: "openWhiteboardRevision",
                    args: {},
                  })
                }
              >
                Back to latest
              </button>
            </div>
          ) : null}
          {activeView === "review" && documentState.state === "ready" && (
            <WhiteboardToc entries={tocEntries} />
          )}
          <section
            ref={scrollRegionRef}
            className={`whiteboard-view-region whiteboard-view-region--${activeView}`}
          >
            <div
              className="whiteboard-document-view"
              hidden={activeView !== "review"}
            >
              {documentState.state === "ready" ? (
                <>
                  <article
                    ref={articleRef}
                    className="whiteboard-document"
                    data-kind={scratchpad ? "scratchpad" : undefined}
                  >
                    <WhiteboardDocumentBoundary
                      key={documentRevision}
                      session={session}
                      revision={documentRevision}
                      onError={(_revision, error) =>
                        reportWhiteboardDocumentRenderError(session, error)
                      }
                    >
                      <WhiteboardViewStateProvider
                        tourRestore={viewStateSync.tourRestore}
                        persistOverlayTour={viewStateSync.persistOverlayTour}
                      >
                        <documentState.document.render />
                      </WhiteboardViewStateProvider>
                    </WhiteboardDocumentBoundary>
                  </article>
                </>
              ) : (
                <WhiteboardDocumentLoadState state={documentState} />
              )}
            </div>
            {softwareMapEnabled && activeView === "map" && (
              <div className="whiteboard-map-view">
                <div className="whiteboard-map-canvas-shell">
                  {softwareMapState.state === "ready" ||
                  softwareMapState.state === "absent" ? (
                    <>
                      <SoftwareMapTopologyUnavailable
                        repoSoftwareMap={repoSoftwareMap}
                        baseSoftwareMap={baseSoftwareMap}
                        baseRef={whiteboard.resolvedBaseRef ?? undefined}
                        headRef={whiteboard.resolvedHeadRef ?? undefined}
                      />
                      <SoftwareMap
                        model={activeSoftwareMap ?? undefined}
                        pinnedData={
                          activeSoftwareMapSource
                            ? session.softwareMapData?.(activeSoftwareMapSource)
                            : undefined
                        }
                        focusRequest={whiteboard.softwareMapFocusRequest}
                        height="100%"
                        showChrome={false}
                        showFloatingActions={!activePanel}
                      />
                      <MapSettingsControl />
                    </>
                  ) : (
                    <WhiteboardSoftwareMapLoadState state={softwareMapState} />
                  )}
                </div>
              </div>
            )}
            {activeView === "commits" && (
              <WhiteboardCommitsView
                commits={commits}
                range={range}
                onOpenDiff={(commit, via) => {
                  setDiffScope(commit);
                  captureUiEvent(session, "commit_diff_opened", { via });
                  applyWhiteboardView("diff");
                }}
              />
            )}
            <div
              aria-hidden={activeView !== "diff" || diffScope !== null}
              className={
                activeView === "diff" && diffScope === null
                  ? "whiteboard-diff-view"
                  : "whiteboard-diff-view whiteboard-diff-view--preloaded"
              }
            >
              <WhiteboardDiffView />
            </div>
            {activeView === "diff" && diffScope !== null && (
              <div className="whiteboard-diff-view whiteboard-diff-view--scoped">
                <CommitDiffScopeBar
                  commit={diffScope}
                  onBack={() => {
                    setDiffScope(null);
                    applyWhiteboardView("commits");
                  }}
                />
                <WhiteboardDiffView scope={{ commit: diffScope.commit }} />
              </div>
            )}
            {activeView === "trace" && (
              <WhiteboardTraceView
                initialSelection={traceSelection}
                storedList={storedList}
              />
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
      <div className="whiteboard-detail-host">
        <WhiteboardPanelHost />
      </div>
    </div>
  );
}

function WhiteboardDocumentLoadState({
  state,
}: {
  state: Exclude<WhiteboardDocumentAppState, { state: "ready" }>;
}): ReactElement | null {
  switch (state.state) {
    case "loading":
      return null;
    case "unavailable":
      return (
        <WhiteboardUnavailable
          title="Session unavailable"
          message={state.message}
          action={
            state.currentWhiteboardUuid ? (
              <OpenCurrentWhiteboard sessionId={state.currentWhiteboardUuid} />
            ) : null
          }
        />
      );
    default: {
      const unhandled: never = state;
      throw new Error(
        `Unhandled review document state ${JSON.stringify(unhandled)}.`,
      );
    }
  }
}

function WhiteboardSoftwareMapLoadState({
  state,
}: {
  state: Exclude<
    WhiteboardSoftwareMapAppState,
    { state: "ready" } | { state: "absent" }
  >;
}): ReactElement | null {
  switch (state.state) {
    case "loading":
      return null;
    case "unavailable":
      return (
        <WhiteboardUnavailable
          message={`Software map unavailable: ${state.message}`}
          action={
            state.currentWhiteboardUuid ? (
              <OpenCurrentWhiteboard sessionId={state.currentWhiteboardUuid} />
            ) : null
          }
        />
      );
    default: {
      // A new software-map state has to choose here: the map chrome renders
      // for ready and absent (an absent map still shows document-authored
      // models), everything else is a load state.
      const unhandled: never = state;
      throw new Error(
        `Unhandled software map state ${JSON.stringify(unhandled)}.`,
      );
    }
  }
}

function OpenCurrentWhiteboard({
  sessionId,
}: {
  sessionId: string;
}): ReactElement {
  const session = useWhiteboardSession();

  return (
    <button
      type="button"
      onClick={() =>
        void session.surface.post({
          name: "openWhiteboard",
          args: { sessionId, active: true },
        })
      }
    >
      Open current whiteboard
    </button>
  );
}

function CommitDiffScopeBar({
  commit,
  onBack,
}: {
  commit: WhiteboardCommitSummary;
  onBack: () => void;
}) {
  return (
    <div className="whiteboard-diff-scope-bar">
      <div className="whiteboard-diff-scope-summary">
        <span className="whiteboard-diff-scope-label">Viewing</span>
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
function WhiteboardBatonChip({
  outcome,
}: {
  outcome: WhiteboardSubmissionOutcome | null;
}): ReactElement | null {
  const tooltip = useTooltip<HTMLSpanElement>(
    outcome === "changes-requested"
      ? "Changes requested"
      : outcome === "approved"
        ? "Approved"
        : "Dismissed",
  );

  if (!outcome) return null;

  const label =
    outcome === "changes-requested"
      ? "changes requested"
      : outcome === "approved"
        ? "approved"
        : "dismissed";

  return (
    <span
      ref={tooltip}
      className={`whiteboard-baton-chip whiteboard-baton-chip--${outcome}`}
    >
      {outcome === "approved" && (
        <svg
          className="whiteboard-baton-glyph"
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
          className="whiteboard-baton-glyph"
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
  } = useWhiteboardDebugSettings();

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
            className="whiteboard-debug-theme whiteboard-debug-theme--triple"
            role="group"
            aria-label="Node tint"
          >
            <span className="whiteboard-debug-group-label">Map node tint</span>
            {(["none", "slate", "mineral"] as const).map((option) => (
              <button
                key={option}
                type="button"
                className={
                  nodeTint === option
                    ? "whiteboard-debug-theme-option whiteboard-debug-theme-option--active"
                    : "whiteboard-debug-theme-option"
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
    <label className="whiteboard-debug-switch">
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

function nodeTintLabel(tint: WhiteboardNodeTint) {
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
