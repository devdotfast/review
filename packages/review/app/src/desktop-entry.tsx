import type {
  ReviewCanvasContent,
  ReviewCanvasHandle,
} from "@dev.fast/review-protocol";
import { createRoot } from "react-dom/client";

import { ApiCanvas } from "./api-canvas";
import { type ReviewFindHost, createReviewFindHost } from "./review-find";
import { ReviewHome } from "./review-home-view";
import { ReviewContainerProvider } from "./review-root-context";
import { SettingsPage } from "./settings-page";
import { WelcomePage } from "./welcome-page";

import "./styles.css";
import "./whiteboard.css";

export { clearPersistedReviewViewState as clearReviewViewState } from "./review-view-state";

function ReviewCanvas({
  content,
  findHost,
}: {
  content: ReviewCanvasContent;
  findHost: ReviewFindHost;
}) {
  if (content.kind === "api")
    return (
      <div data-review-api="" className="review-api-canvas">
        <ApiCanvas
          key={content.sessionId}
          content={content}
          findHost={findHost}
        />
      </div>
    );

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
        setupActions={content.setupActions}
        onClose={content.close}
        onboarding={content.onboarding}
        onOpenTutorial={content.openTutorial}
      />
    );
  }

  if (content.kind === "settings") {
    return <SettingsPage settings={content.settings} />;
  }

  if (content.kind === "error") {
    return (
      <CanvasShell title="Review unavailable">
        <p>{content.message}</p>
      </CanvasShell>
    );
  }

  return null;
}

function Home({
  content,
}: {
  content: Extract<ReviewCanvasContent, { kind: "home" }>;
}) {
  const deleteReview = content.deleteReview;
  const dismissReview = content.dismissReview;
  const restoreReview = content.restoreReview;

  return (
    <ReviewHome
      reviews={content.reviews}
      onOpen={(review) => content.openReview(review.sessionId)}
      onDelete={
        deleteReview ? (review) => deleteReview(review.sessionId) : undefined
      }
      onDismiss={
        dismissReview ? (review) => dismissReview(review.sessionId) : undefined
      }
      onRestore={
        restoreReview ? (review) => restoreReview(review.sessionId) : undefined
      }
      setup={content.setup}
      install={content.install}
      setupActions={content.setupActions}
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

    resetSessionDiagnostics(container);

    if (content.kind === "api") {
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
        <ReviewCanvas content={content} findHost={findHost} />
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
      return content.kind === "api" && findHost.showFind(seed);
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
  delete container.dataset.reviewDiffSummaryRequestCount;
  delete container.dataset.reviewDiffSummaryReadyCount;
  delete container.dataset.reviewDiffSummaryStartedAfterMount;
  delete container.dataset.reviewDiffSummaryIncludePatch;
}
