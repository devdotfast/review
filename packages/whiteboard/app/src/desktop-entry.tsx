import type {
  WhiteboardCanvasContent,
  WhiteboardCanvasHandle,
} from "@dev.fast/whiteboard-protocol";
import { createRoot } from "react-dom/client";

import { ApiCanvas } from "./api-canvas";
import { SettingsPage } from "./settings-page";
import { WelcomePage } from "./welcome-page";
import {
  type WhiteboardFindHost,
  createWhiteboardFindHost,
} from "./whiteboard-find";
import { WhiteboardHome } from "./whiteboard-home-view";
import { WhiteboardContainerProvider } from "./whiteboard-root-context";

import "./styles.css";
import "./whiteboard.css";

export { clearPersistedWhiteboardViewState as clearWhiteboardViewState } from "./whiteboard-view-state";

function WhiteboardCanvas({
  content,
  findHost,
}: {
  content: WhiteboardCanvasContent;
  findHost: WhiteboardFindHost;
}) {
  if (content.kind === "api")
    return (
      <div data-whiteboard-api="" className="whiteboard-api-canvas">
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
        <div className="whiteboard-source-empty">
          <p>Worktree unavailable</p>
          <p className="whiteboard-source-empty-hint">{content.error}</p>
        </div>
      );
    }

    return (
      <div className="whiteboard-source-empty">
        <p>Select a file in the source tree</p>
        <p className="whiteboard-source-empty-hint">⌘B toggles the tree</p>
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
      <CanvasShell title="Session unavailable">
        <p>{content.message}</p>
      </CanvasShell>
    );
  }

  return null;
}

function Home({
  content,
}: {
  content: Extract<WhiteboardCanvasContent, { kind: "home" }>;
}) {
  const deleteWhiteboard = content.deleteWhiteboard;
  const dismissWhiteboard = content.dismissWhiteboard;
  const restoreWhiteboard = content.restoreWhiteboard;

  return (
    <WhiteboardHome
      whiteboards={content.whiteboards}
      onOpen={(whiteboard) => content.openWhiteboard(whiteboard.sessionId)}
      onDelete={
        deleteWhiteboard
          ? (whiteboard) => deleteWhiteboard(whiteboard.sessionId)
          : undefined
      }
      onDismiss={
        dismissWhiteboard
          ? (whiteboard) => dismissWhiteboard(whiteboard.sessionId)
          : undefined
      }
      onRestore={
        restoreWhiteboard
          ? (whiteboard) => restoreWhiteboard(whiteboard.sessionId)
          : undefined
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
    <main className="whiteboard-canvas-shell">
      <div className="whiteboard-shell-brand">/dev/fast Whiteboard</div>
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

export function mountWhiteboardCanvas(
  container: HTMLElement,
  initialContent: WhiteboardCanvasContent,
): WhiteboardCanvasHandle {
  let content = initialContent;

  let disposed = false;
  let themeSubscription: { dispose(): void } | null = null;
  const findHost = createWhiteboardFindHost();
  container.classList.add("whiteboard-canvas-root");
  // The canvas stylesheet is compiled inside @scope (.review-canvas-root),
  // where the scope root itself is only matched by :scope — a theme class on
  // the container would never match the light token block. The theme class
  // must live on an in-scope descendant, so all content renders inside this
  // host element.
  const themeHost = container.ownerDocument.createElement("div");
  themeHost.className = "whiteboard-theme-host";
  container.appendChild(themeHost);
  const root = createRoot(themeHost);

  const applyTheme = (theme: "dark" | "light") => {
    container.dataset.whiteboardTheme = theme;
    themeHost.classList.toggle(
      "whiteboard-app--theme-light",
      theme === "light",
    );
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
      <WhiteboardContainerProvider container={container}>
        <WhiteboardCanvas content={content} findHost={findHost} />
      </WhiteboardContainerProvider>,
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
      container.classList.remove("whiteboard-canvas-root");
    },
  };
}

function resetSessionDiagnostics(container: HTMLElement): void {
  delete container.dataset.whiteboardDiffSummaryRequestCount;
  delete container.dataset.whiteboardDiffSummaryReadyCount;
  delete container.dataset.whiteboardDiffSummaryStartedAfterMount;
  delete container.dataset.whiteboardDiffSummaryIncludePatch;
}
