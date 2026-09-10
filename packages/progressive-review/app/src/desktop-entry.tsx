import type {
  ReviewCanvasContent,
  ReviewCanvasDiagnostic,
  ReviewCanvasHandle,
  ReviewDocumentLoad,
  ReviewSoftwareMapLoad,
} from "@dev.fast/review-protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import {
  App,
  type ReviewDocumentAppState,
  type ReviewSoftwareMapAppState,
} from "./App";
import { codePeekDiagnostics } from "./code-peek-resolution";
import {
  type ReviewSession,
  ReviewSessionProvider,
  createReviewSession,
  useReviewSession,
} from "./host/review-session";
import { hydratePublishedSoftwareMap } from "./hydrate-published-software-map";
import { ReviewCanvasLoading } from "./review-canvas-loading";
import { prepareReviewDocument } from "./review-document-prepare";
import { type ReviewFindHost, createReviewFindHost } from "./review-find";
import { ReviewHome } from "./review-home-view";
import {
  ReviewContainerProvider,
  useReviewContainer,
} from "./review-root-context";
import { SettingsPage } from "./settings-page";
import { TutorialProvider } from "./tutorial-context";
import { captureClientError } from "./ui-telemetry";
import { WelcomePage } from "./welcome-page";

import "./styles.css";

export { clearPersistedReviewViewState as clearReviewViewState } from "./review-view-state";

function DesktopReviewApp({
  documentBundle,
  softwareMapBundle,
  softwareMapEnabled,
  purpose = "display",
  range,
  commits,
  tutorial,
  findHost,
}: {
  documentBundle: Promise<ReviewDocumentLoad>;
  softwareMapBundle: Promise<ReviewSoftwareMapLoad | null>;
  softwareMapEnabled: boolean;
  purpose?: "display" | "validation";
  range: Extract<ReviewCanvasContent, { kind: "session" }>["range"];
  commits: Extract<ReviewCanvasContent, { kind: "session" }>["commits"];
  tutorial?: Extract<ReviewCanvasContent, { kind: "session" }>["tutorial"];
  findHost: ReviewFindHost;
}) {
  const session = useReviewSession();
  // Render boundaries report during commit, before our readiness effect.
  // Keep their failure authoritative for this pair of validation artifacts.
  const settlementSession = useMemo(() => {
    if (purpose === "display") return session;
    let failed = false;
    return {
      ...session,
      signalReady: () => {
        if (!failed) session.signalReady();
      },
      reportDiagnostic: (diagnostic: ReviewCanvasDiagnostic) => {
        if (diagnostic.level === "error") failed = true;
        session.reportDiagnostic(diagnostic);
      },
    };
  }, [session, purpose, documentBundle, softwareMapBundle]);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const container = useReviewContainer();
  const reportedDocumentBundle = useRef<Promise<ReviewDocumentLoad> | null>(
    null,
  );
  const reportedSoftwareMapBundle =
    useRef<Promise<ReviewSoftwareMapLoad | null> | null>(null);
  const documentState = useSettledLoad(
    documentBundle,
    async (load): Promise<ReviewDocumentAppState> => {
      if (load.state !== "ready") return load;
      const document = await prepareReviewDocument(load, sessionRef.current);
      if (purpose === "validation") {
        for (const anchor of document.anchors.values()) {
          if (anchor.peek && !anchor.peek.resolution)
            throw new Error(
              `Review document code peek ${anchor.id} could not be resolved.`,
            );
        }
      }
      return { state: "ready", document };
    },
    session,
    purpose === "display",
  );
  const softwareMapState = useSettledLoad(
    softwareMapBundle,
    (load): ReviewSoftwareMapAppState => {
      if (load === null) return { state: "absent" };
      if (load.state !== "ready") return load;
      return {
        state: "ready",
        softwareMap: hydratePublishedSoftwareMap(load),
      };
    },
    session,
    purpose === "display",
  );

  useEffect(() => {
    if (
      documentState.state === "loading" ||
      softwareMapState.state === "loading"
    ) {
      return;
    }
    // The display host opens a usable recovery shell before diagnostics.
    // Validation instead reports every unusable artifact before success.
    if (purpose === "display") settlementSession.signalReady();
    if (
      reportedDocumentBundle.current !== documentBundle &&
      reportLoadFailure(settlementSession, "document", documentState, purpose)
    ) {
      reportedDocumentBundle.current = documentBundle;
    }
    if (
      reportedSoftwareMapBundle.current !== softwareMapBundle &&
      reportLoadFailure(
        settlementSession,
        "software-map",
        softwareMapState,
        purpose,
      )
    ) {
      reportedSoftwareMapBundle.current = softwareMapBundle;
    }
    if (
      purpose === "validation" &&
      documentState.state === "ready" &&
      (softwareMapState.state === "ready" ||
        softwareMapState.state === "absent")
    ) {
      settlementSession.signalReady();
    }
  }, [
    documentBundle,
    documentState,
    softwareMapBundle,
    softwareMapState,
    purpose,
    settlementSession,
  ]);

  useEffect(() => {
    if (!container) return;
    const { authoredCodePeekRequestCount } = codePeekDiagnostics;
    if (authoredCodePeekRequestCount === 0) return;
    container.dataset.reviewAuthoredCodePeekRequestCount = String(
      authoredCodePeekRequestCount,
    );
  }, [container, documentState]);

  return (
    <div className="review-session-content">
      <ReviewSessionProvider session={settlementSession}>
        <TutorialProvider tutorial={tutorial}>
          <App
            documentState={documentState}
            softwareMapState={softwareMapState}
            softwareMapEnabled={softwareMapEnabled}
            range={range}
            commits={commits}
            findHost={findHost}
          />
        </TutorialProvider>
      </ReviewSessionProvider>
    </div>
  );
}

type ReviewLoadFallback =
  | { state: "loading" }
  | { state: "unavailable"; message: string; cause: Error };

const reviewLoadLoading: ReviewLoadFallback = { state: "loading" };

/**
 * Settles one canvas bundle into its app state. A load that rejects becomes
 * the unavailable state carrying its cause, so nothing has to re-derive the
 * failure from a ref afterwards.
 */
function useSettledLoad<TLoad, TState>(
  bundle: Promise<TLoad>,
  settle: (load: TLoad) => TState | Promise<TState>,
  session: ReviewSession,
  preservePrevious: boolean,
): TState | ReviewLoadFallback {
  const settleRef = useRef(settle);
  settleRef.current = settle;
  const [settledLoad, setSettledLoad] = useState<{
    bundle: Promise<TLoad>;
    session: ReviewSession;
    value: TState | ReviewLoadFallback;
  }>(() => ({ bundle, session, value: reviewLoadLoading }));
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const load = await bundle;
        if (cancelled) return;
        const settled = await settleRef.current(load);
        if (!cancelled) setSettledLoad({ bundle, session, value: settled });
      } catch (error) {
        if (cancelled) return;
        const cause = error instanceof Error ? error : new Error(String(error));
        setSettledLoad({
          bundle,
          session,
          value: { state: "unavailable", message: cause.message, cause },
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bundle, session]);
  // Keep the visible editor mounted during live updates. Validation must
  // settle the requested bundle before its previous state can imply readiness.
  return settledLoad.session === session &&
    (preservePrevious || settledLoad.bundle === bundle)
    ? settledLoad.value
    : reviewLoadLoading;
}

function reportLoadFailure(
  session: ReviewSession,
  source: "document" | "software-map",
  state: ReviewDocumentAppState | ReviewSoftwareMapAppState,
  purpose: "display" | "validation",
): boolean {
  if (
    purpose === "validation" &&
    (state.state === "needs-republish" ||
      (state.state === "unavailable" && state.currentReviewUuid))
  ) {
    session.reportDiagnostic({
      level: "error",
      source: "loader",
      message:
        state.state === "unavailable"
          ? state.message
          : `The ${source} needs repair before publication.`,
    });
    return true;
  }
  if (state.state !== "unavailable" || state.currentReviewUuid) return false;
  const cause = state.cause ?? new Error(state.message);
  captureClientError(session, source, cause);
  const diagnostic: ReviewCanvasDiagnostic = {
    level: "error",
    source: "loader",
    message: cause.message,
  };
  if (cause.stack) diagnostic.stack = cause.stack;
  session.reportDiagnostic(diagnostic);
  return true;
}

function ReviewCanvas({
  content,
  findHost,
}: {
  content: ReviewCanvasContent;
  findHost: ReviewFindHost;
}) {
  if (content.kind === "session") {
    return (
      <DesktopReviewApp
        key={content.bridge.config.sessionId}
        documentBundle={content.document}
        softwareMapBundle={content.softwareMap}
        softwareMapEnabled={content.softwareMapEnabled}
        purpose={content.purpose}
        range={content.range}
        commits={content.commits}
        tutorial={content.tutorial}
        findHost={findHost}
      />
    );
  }
  if (content.kind === "home") return <Home content={content} />;
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
        <p>{content.message}</p>
      </CanvasShell>
    );
  }
  return <ReviewCanvasLoading page />;
}

function Home({
  content,
}: {
  content: Extract<ReviewCanvasContent, { kind: "home" }>;
}) {
  const deleteReview = content.deleteReview;
  const dismissReview = content.dismissReview;
  const restoreReview = content.restoreReview;
  const openSourceTree = content.openSourceTree;
  return (
    <ReviewHome
      reviews={content.reviews}
      reviewErrors={content.reviewErrors}
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
      onboarding={content.onboarding}
      onOpenTutorial={content.openTutorial}
    />
  );
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
  codePeekDiagnostics.authoredCodePeekRequestCount = 0;
  delete container.dataset.reviewAuthoredCodePeekRequestCount;
  delete container.dataset.reviewDiffSummaryRequestCount;
  delete container.dataset.reviewDiffSummaryReadyCount;
  delete container.dataset.reviewDiffSummaryStartedAfterMount;
  delete container.dataset.reviewDiffSummaryIncludePatch;
}
