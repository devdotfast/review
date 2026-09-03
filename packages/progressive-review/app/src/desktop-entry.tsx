import type {
  ReviewAuthoringTarget,
  ReviewCanvasContent,
  ReviewCanvasHandle,
  ReviewDescriptor,
  ReviewDesktopGlobalEvent,
  ReviewListError,
} from "@dev.fast/review-protocol";
import { parseReviewListResponse } from "@dev.fast/review-protocol";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import type { LiveReviewPage } from "../../src/live-review-types";
import type {
  ReviewStateEvent,
  ReviewStateSnapshot,
} from "../../src/server/review-state-service";
import { App, type PublishedSoftwareMap } from "./App";
import { LiveCommentThreadsProvider } from "./comments-context";
import {
  type ReviewSession,
  ReviewSessionProvider,
  createReviewSession,
  useReviewSession,
} from "./host/review-session";
import {
  LiveReviewAuthoringTargetContext,
  createLiveReviewDocument,
} from "./live-review-renderer";
import { ReviewCanvasLoading } from "./review-canvas-loading";
import { reviewDefinitionDiagnostics } from "./review-definition-runtime";
import { type ReviewFindHost, createReviewFindHost } from "./review-find";
import { ReviewHome, ReviewMigrationWarning } from "./review-home-view";
import {
  ReviewContainerProvider,
  useReviewContainer,
} from "./review-root-context";
import { SettingsPage } from "./settings-page";
import { TutorialProvider } from "./tutorial-context";
import { captureClientError, captureUiEvent } from "./ui-telemetry";
import { WelcomePage } from "./welcome-page";

import "./styles.css";

export { clearPersistedReviewViewState as clearReviewViewState } from "./review-view-state";

function DesktopReviewApp({
  reviewUuid,
  softwareMapBundle,
  softwareMapEnabled,
  range,
  commits,
  reviewErrors,
  tutorial,
  findHost,
}: {
  reviewUuid: string;
  softwareMapBundle: Promise<unknown | null>;
  softwareMapEnabled: boolean;
  range: Extract<ReviewCanvasContent, { kind: "session" }>["range"];
  commits: Extract<ReviewCanvasContent, { kind: "session" }>["commits"];
  reviewErrors: Extract<
    ReviewCanvasContent,
    { kind: "session" }
  >["reviewErrors"];
  tutorial?: Extract<ReviewCanvasContent, { kind: "session" }>["tutorial"];
  findHost: ReviewFindHost;
}) {
  const session = useReviewSession();
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const container = useReviewContainer();
  const queryClient = useQueryClient();
  const stateKey = useMemo(
    () => ["review-state", reviewUuid] as const,
    [reviewUuid],
  );
  const stateQuery = useQuery({
    queryKey: stateKey,
    queryFn: async ({ signal }) => {
      const response = await session.fetchUrl(
        new URL(
          `/live-reviews/${encodeURIComponent(reviewUuid)}/state`,
          session.config.serverUrl,
        ),
        { signal },
      );
      const payload = (await response.json()) as {
        ok?: boolean;
        state?: ReviewStateSnapshot;
        error?: string;
      };
      if (!response.ok || payload.ok !== true || !payload.state) {
        throw new Error(
          payload.error ?? `Review state returned ${response.status}.`,
        );
      }
      return payload.state;
    },
    staleTime: Infinity,
  });
  const state = stateQuery.data;
  const document = useMemo(
    () => (state ? createLiveReviewDocument(state.page) : null),
    [state],
  );
  const reviewThreads = useMemo(
    () => new Map(Object.entries(state?.threads ?? {})),
    [state?.threads],
  );
  const reviewDrafts = state?.drafts ?? {};
  const [softwareMap, setSoftwareMap] = useState<PublishedSoftwareMap | null>(
    null,
  );
  const [softwareMapLoaded, setSoftwareMapLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const authoringTarget = state?.authoringTarget ?? null;

  const reportLoadError = (loadError: unknown) => {
    captureClientError(sessionRef.current, "document", loadError);
    const message =
      loadError instanceof Error ? loadError.message : String(loadError);
    sessionRef.current.reportDiagnostic({
      level: "error",
      source: "loader",
      message,
      ...(loadError instanceof Error && loadError.stack
        ? { stack: loadError.stack }
        : {}),
    });
    setError(message);
  };

  useEffect(() => {
    const url = new URL(
      `/live-reviews/${encodeURIComponent(reviewUuid)}/state/events`,
      session.config.serverUrl,
    );
    if (session.config.token) {
      url.searchParams.set("token", session.config.token);
    }
    const events = new EventSource(url);
    events.onmessage = (event) => {
      try {
        const update = JSON.parse(event.data) as ReviewStateEvent;
        queryClient.setQueryData<ReviewStateSnapshot>(stateKey, (current) =>
          current ? applyReviewStateEvent(current, update) : current,
        );
      } catch {
        // A reconnect reads a fresh authoritative snapshot.
      }
    };
    return () => events.close();
  }, [queryClient, reviewUuid, session, stateKey]);

  useEffect(() => {
    if (stateQuery.error) reportLoadError(stateQuery.error);
  }, [stateQuery.error]);

  useEffect(() => {
    let cancelled = false;
    void softwareMapBundle.then(
      (softwareMapValue) => {
        if (cancelled) return;
        setSoftwareMap(softwareMapValue as PublishedSoftwareMap | null);
        setSoftwareMapLoaded(true);
      },
      (loadError) => {
        if (cancelled) return;
        reportLoadError(loadError);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [softwareMapBundle]);

  useEffect(() => {
    if (document && softwareMapLoaded && !error) session.signalReady();
  }, [document, softwareMapLoaded, error, session]);

  useEffect(() => {
    if (!container) return;
    const { authoredCodePeekRequestCount, authoredCodePeekDiffRequestCount } =
      reviewDefinitionDiagnostics;
    if (authoredCodePeekRequestCount === 0) return;
    container.dataset.reviewAuthoredCodePeekRequestCount = String(
      authoredCodePeekRequestCount,
    );
    container.dataset.reviewAuthoredCodePeekDiffRequestCount = String(
      authoredCodePeekDiffRequestCount,
    );
  }, [container, document, error]);

  if (error) {
    return (
      <CanvasShell title="Review unavailable">
        <p>{error}</p>
      </CanvasShell>
    );
  }
  if (!document || !softwareMapLoaded) {
    return <ReviewCanvasLoading page note="Still loading this review…" />;
  }
  return (
    <div className="review-session-content">
      <ReviewMigrationWarning errors={reviewErrors} />
      <LiveReviewAuthoringTargetContext.Provider value={authoringTarget}>
        <TutorialProvider tutorial={tutorial}>
          <LiveCommentThreadsProvider
            threads={reviewThreads}
            drafts={reviewDrafts}
          >
            <App
              document={document}
              softwareMap={softwareMap}
              softwareMapEnabled={softwareMapEnabled}
              range={range}
              commits={commits}
              findHost={findHost}
            />
          </LiveCommentThreadsProvider>
        </TutorialProvider>
      </LiveReviewAuthoringTargetContext.Provider>
    </div>
  );
}

function ReviewCanvas({
  content,
  findHost,
}: {
  content: ReviewCanvasContent;
  findHost: ReviewFindHost;
}) {
  if (content.kind === "session") {
    return <QuerySessionCanvas content={content} findHost={findHost} />;
  }
  if (content.kind === "home") return <QueryHomeCanvas content={content} />;
  if (content.kind === "source") {
    if (content.error) {
      return (
        <div className="review-source-empty">
          <p>Worktree unavailable</p>
          <p className="review-source-empty-hint">{content.error}</p>
        </div>
      );
    }
    return (
      <div className="review-source-empty">
        <p>Select a file in the source tree</p>
        <p className="review-source-empty-hint">⌘B toggles the tree</p>
      </div>
    );
  }
  if (content.kind === "welcome") {
    return (
      <WelcomePage
        install={content.install}
        onClose={content.close}
        onboarding={content.onboarding}
        onOpenTutorial={content.openTutorial}
      />
    );
  }
  if (content.kind === "settings") {
    return <SettingsPage settings={content.settings} />;
  }
  if (content.kind === "completed") {
    return (
      <CanvasShell title="Review completed">
        <p>{content.reviewPath ?? "The review was submitted successfully."}</p>
        <p>
          <button
            type="button"
            className="review-shell-primary"
            onClick={content.showHome}
          >
            Back to Home
          </button>
        </p>
      </CanvasShell>
    );
  }
  if (content.kind === "error") {
    return (
      <CanvasShell title="Review unavailable">
        <ReviewMigrationWarning errors={content.reviewErrors ?? []} />
        <p>{content.message}</p>
      </CanvasShell>
    );
  }
  return <ReviewCanvasLoading page note="Preparing the selected review…" />;
}

function QuerySessionCanvas({
  content,
  findHost,
}: {
  content: Extract<ReviewCanvasContent, { kind: "session" }>;
  findHost: ReviewFindHost;
}) {
  const client = useMemo(() => new QueryClient(), []);
  return (
    <QueryClientProvider client={client}>
      <DesktopReviewApp
        key={content.bridge.config.sessionId}
        reviewUuid={content.reviewUuid}
        softwareMapBundle={content.softwareMap}
        softwareMapEnabled={content.softwareMapEnabled}
        range={content.range}
        commits={content.commits}
        reviewErrors={content.reviewErrors}
        tutorial={content.tutorial}
        findHost={findHost}
      />
    </QueryClientProvider>
  );
}

function applyReviewStateEvent(
  current: ReviewStateSnapshot,
  event: ReviewStateEvent,
): ReviewStateSnapshot {
  if (event.type === "state.snapshot") return event.state;
  if (event.type === "authoring-target.changed") {
    return { ...current, authoringTarget: event.target };
  }
  if (event.type === "threads.committed") {
    const threads = { ...current.threads };
    const drafts = { ...current.drafts };
    for (const thread of event.commit.upsertedThreads) {
      threads[thread.threadId] = thread;
    }
    for (const threadId of event.commit.deletedThreadIds) {
      delete threads[threadId];
    }
    for (const { threadId, draft } of event.commit.upsertedDrafts) {
      drafts[threadId] = draft;
    }
    for (const threadId of event.commit.deletedDraftThreadIds) {
      delete drafts[threadId];
    }
    return { ...current, threads, drafts };
  }
  if (event.type === "review.committed") return current;
  const nodes = { ...current.page.nodes };
  for (const node of event.upsertedNodes) nodes[node.id] = node;
  for (const nodeId of event.deletedNodeIds) delete nodes[nodeId];
  const elements = { ...current.page.projection.elements };
  for (const [elementId, element] of Object.entries(
    event.projection.upsertedElements,
  )) {
    elements[elementId] = element;
  }
  for (const elementId of event.projection.deletedElementIds) {
    delete elements[elementId];
  }
  return {
    ...current,
    page: {
      ...current.page,
      nodes,
      version: event.version,
      updatedAt: event.updatedAt,
      projection: { root: event.projection.root, elements },
    },
  };
}

function QueryHomeCanvas({
  content,
}: {
  content: Extract<ReviewCanvasContent, { kind: "home" }>;
}) {
  const client = useMemo(() => new QueryClient(), []);
  return (
    <QueryClientProvider client={client}>
      <Home content={content} />
    </QueryClientProvider>
  );
}

function Home({
  content,
}: {
  content: Extract<ReviewCanvasContent, { kind: "home" }>;
}) {
  const queryClient = useQueryClient();
  const catalogQuery = useQuery({
    queryKey: ["review-catalog"],
    queryFn: async ({ signal }) => {
      const response = await fetch(
        new URL("/reviews?limit=100", content.serverUrl),
        {
          headers: { "x-review-token": content.token },
          signal,
        },
      );
      if (!response.ok) {
        throw new Error(`Review list returned ${response.status}.`);
      }
      return parseReviewListResponse(await response.json());
    },
    // SSE patches are the fast path, but they are intentionally disposable.
    // A laptop sleep, renderer suspension, or connection race can miss one;
    // reconcile from the authoritative SQLite-backed snapshot whenever the
    // user returns to the app instead of treating the cached catalog as fresh
    // forever.
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
  });
  useEffect(() => {
    const url = new URL("/events", content.serverUrl);
    url.searchParams.set("token", content.token);
    const events = new EventSource(url);
    events.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as ReviewDesktopGlobalEvent;
        if (event.event === "preferences-changed") {
          void queryClient.invalidateQueries({ queryKey: ["review-catalog"] });
          return;
        }
        queryClient.setQueryData<ReviewCatalog>(["review-catalog"], (current) =>
          current ? applyCatalogEvent(current, event) : current,
        );
      } catch {
        // Reconnecting refetches the authoritative catalog below.
      }
    };
    events.onopen = () => {
      void queryClient.invalidateQueries({ queryKey: ["review-catalog"] });
    };
    return () => events.close();
  }, [content.serverUrl, content.token, queryClient]);
  if (catalogQuery.error) {
    return (
      <CanvasShell title="Review unavailable">
        <p>{catalogQuery.error.message}</p>
      </CanvasShell>
    );
  }
  if (!catalogQuery.data) {
    return <ReviewCanvasLoading page note="Loading reviews…" />;
  }
  const deleteReview = content.deleteReview;
  const dismissReview = content.dismissReview;
  const restoreReview = content.restoreReview;
  const openSourceTree = content.openSourceTree;
  return (
    <ReviewHome
      reviews={catalogQuery.data.reviews.filter(
        (review) => review.status !== "draft",
      )}
      reviewErrors={catalogQuery.data.errors}
      onOpen={(review) => content.openReview(review.uuid)}
      onDelete={
        deleteReview ? (review) => deleteReview(review.uuid) : undefined
      }
      onDismiss={
        dismissReview ? (review) => dismissReview(review.uuid) : undefined
      }
      onRestore={
        restoreReview ? (review) => restoreReview(review.uuid) : undefined
      }
      onOpenSourceTree={
        openSourceTree ? (review) => openSourceTree(review.uuid) : undefined
      }
      setup={content.setup}
      install={content.install}
      onboarding={
        content.onboarding
          ? {
              ...content.onboarding,
              published: catalogQuery.data.reviews.some(
                (review) => review.status !== "draft",
              ),
            }
          : undefined
      }
      onOpenTutorial={content.openTutorial}
    />
  );
}

interface ReviewCatalog {
  reviews: ReviewDescriptor[];
  errors: ReviewListError[];
}

function applyCatalogEvent(
  current: ReviewCatalog,
  event: ReviewDesktopGlobalEvent,
): ReviewCatalog {
  if (event.event === "session-registered" && event.review) {
    return {
      ...current,
      reviews: [
        event.review,
        ...current.reviews.filter(
          (review) => review.uuid !== event.review!.uuid,
        ),
      ],
    };
  }
  if (event.event === "review-deleted") {
    return {
      ...current,
      reviews: current.reviews.filter((review) => review.uuid !== event.uuid),
    };
  }
  if (event.event === "review-threads-committed") {
    return patchCatalogReview(current, event.uuid, {
      commentCount: event.commentCount,
    });
  }
  if (event.event === "review-status-changed") {
    return patchCatalogReview(current, event.uuid, { status: event.status });
  }
  if (event.event === "review-attention-changed") {
    return patchCatalogReview(current, event.uuid, {
      viewedAt: event.viewedAt,
      dismissedAt: event.dismissedAt,
      reapsAt: event.reapsAt,
    });
  }
  return current;
}

function patchCatalogReview(
  current: ReviewCatalog,
  uuid: string,
  patch: Partial<ReviewDescriptor>,
): ReviewCatalog {
  return {
    ...current,
    reviews: current.reviews.map((review) =>
      review.uuid === uuid ? { ...review, ...patch } : review,
    ),
  };
}

function CanvasShell({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <main className="review-canvas-shell">
      <div className="review-shell-brand">/dev/fast Review</div>
      <h1>{title}</h1>
      {children}
    </main>
  );
}

// The canvas shares the workbench DOM, so outside a session (which carries its
// own theme bridge) the workbench root is the theme authority.
function workbenchColorTheme(container: HTMLElement): "dark" | "light" {
  const workbench = container.ownerDocument.querySelector(".monaco-workbench");
  if (!workbench) return "dark";
  return workbench.classList.contains("vs-dark") ||
    workbench.classList.contains("hc-black")
    ? "dark"
    : "light";
}

export function mountReviewCanvas(
  container: HTMLElement,
  initialContent: ReviewCanvasContent,
): ReviewCanvasHandle {
  let content = initialContent;
  let session: ReviewSession | null = null;
  let disposed = false;
  let themeSubscription: { dispose(): void } | null = null;
  const findHost = createReviewFindHost();
  container.classList.add("review-canvas-root");
  // The canvas stylesheet is compiled inside @scope (.review-canvas-root),
  // where the scope root itself is only matched by :scope — a theme class on
  // the container would never match the light token block. The theme class
  // must live on an in-scope descendant, so all content renders inside this
  // host element.
  const themeHost = container.ownerDocument.createElement("div");
  themeHost.className = "review-theme-host";
  container.appendChild(themeHost);
  const root = createRoot(themeHost);

  const applyTheme = (theme: "dark" | "light") => {
    container.dataset.reviewTheme = theme;
    themeHost.classList.toggle("review-app--theme-light", theme === "light");
  };

  const render = () => {
    themeSubscription?.dispose();
    themeSubscription = null;
    if (content.kind === "session") {
      resetSessionDiagnostics(container);
      if (session?.bridge !== content.bridge) {
        session = createReviewSession(content.bridge);
      }
    } else {
      session = null;
    }
    if (content.kind === "session") {
      applyTheme(content.bridge.currentTheme());
      themeSubscription = content.bridge.onDidChangeTheme(applyTheme);
    } else {
      applyTheme(workbenchColorTheme(container));
      const workbench =
        container.ownerDocument.querySelector(".monaco-workbench");
      if (workbench) {
        const observer = new MutationObserver(() => {
          applyTheme(workbenchColorTheme(container));
        });
        observer.observe(workbench, {
          attributes: true,
          attributeFilter: ["class"],
        });
        themeSubscription = { dispose: () => observer.disconnect() };
      }
    }
    root.render(
      <ReviewContainerProvider container={container}>
        {session ? (
          <ReviewSessionProvider session={session}>
            <ReviewCanvas content={content} findHost={findHost} />
          </ReviewSessionProvider>
        ) : (
          <ReviewCanvas content={content} findHost={findHost} />
        )}
      </ReviewContainerProvider>,
    );
  };
  render();

  return {
    update(next) {
      if (disposed) return;
      content = next;
      render();
    },
    focus() {
      container.focus();
    },
    showFind(seed) {
      return content.kind === "session" && findHost.showFind(seed);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      themeSubscription?.dispose();
      themeSubscription = null;
      root.unmount();
      themeHost.remove();
      container.classList.remove("review-canvas-root");
    },
  };
}

function resetSessionDiagnostics(container: HTMLElement): void {
  reviewDefinitionDiagnostics.authoredCodePeekRequestCount = 0;
  reviewDefinitionDiagnostics.authoredCodePeekDiffRequestCount = 0;
  delete container.dataset.reviewAuthoredCodePeekRequestCount;
  delete container.dataset.reviewAuthoredCodePeekDiffRequestCount;
  delete container.dataset.reviewDiffSummaryRequestCount;
  delete container.dataset.reviewDiffSummaryReadyCount;
  delete container.dataset.reviewDiffSummaryStartedAfterMount;
  delete container.dataset.reviewDiffSummaryIncludePatch;
}
