// @vitest-environment jsdom

import { readFileSync } from "node:fs";

import type { ReviewCanvasTutorialBridge } from "@dev.fast/review-protocol";
import { type ReactElement, act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReviewSessionProvider } from "./host/review-session";
import { ReviewSection } from "./review-components";
import { testReviewSession } from "./review-session-test-utils";
import { TutorialProvider } from "./tutorial-context";
import { TutorialExperienceProvider } from "./tutorial-experience";

const reviewState = vi.hoisted(() => ({
  softwareMapEnabled: false,
  threads: [] as unknown[],
}));
vi.mock("./review-context", () => ({
  useReview: () => ({
    softwareMapEnabled: reviewState.softwareMapEnabled,
    allCommentThreads: () => reviewState.threads,
  }),
}));

const CHAPTER_TITLES = [
  "Welcome",
  "Commits and diffs",
  "Comments are threads",
  "Interactive Diagrams",
  "Get help",
];

const session = testReviewSession();
let root: ReturnType<typeof createRoot> | null = null;
let canvasRoot: HTMLElement;

beforeEach(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  reviewState.softwareMapEnabled = false;
  reviewState.threads = [];
  window.localStorage.clear();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn<() => void>(),
  });
  canvasRoot = document.createElement("div");
  canvasRoot.className = "review-canvas-root";
  document.body.append(canvasRoot);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  vi.restoreAllMocks();
});

function Shell({
  activeView = "review",
}: {
  activeView?: "review" | "commits";
}): ReactElement {
  const shellRef = useRef<HTMLElement | null>(null);
  const regionRef = useRef<HTMLElement | null>(null);
  return (
    <main ref={shellRef} className="review-document-shell">
      <TutorialExperienceProvider
        shellRef={shellRef}
        scrollRegionRef={regionRef}
      >
        <button type="button" className="review-segment" aria-label="Commits">
          Commits
        </button>
        <button
          type="button"
          className="tutorial-view-button"
          data-tutorial-view="commits"
        >
          Explore the sample commits
        </button>
        <section ref={regionRef} className="review-view-region">
          <div
            className="review-document-view"
            hidden={activeView !== "review"}
          >
            {CHAPTER_TITLES.map((title) => (
              <ReviewSection key={title} title={title}>
                <h2>{title}</h2>
                {title === "Welcome" ? (
                  <div className="tutorial-keymap-picker" />
                ) : (
                  <p>{title} body</p>
                )}
              </ReviewSection>
            ))}
          </div>
          {activeView === "commits" ? (
            <button type="button" className="review-commit-open">
              Open diff
            </button>
          ) : null}
        </section>
      </TutorialExperienceProvider>
    </main>
  );
}

function render(
  tutorial: ReviewCanvasTutorialBridge,
  props: { activeView?: "review" | "commits" } = {},
) {
  root = createRoot(canvasRoot);
  act(() => {
    root?.render(
      <ReviewSessionProvider session={session}>
        <TutorialProvider tutorial={tutorial}>
          <Shell {...props} />
        </TutorialProvider>
      </ReviewSessionProvider>,
    );
  });
}

function section(title: string): HTMLElement {
  const element = canvasRoot.querySelector<HTMLElement>(
    `[data-review-section="${title}"]`,
  );
  if (!element) throw new Error(`Missing section ${title}`);
  return element;
}

function card(): HTMLElement | null {
  return canvasRoot.querySelector(".tutorial-guide");
}

describe("TutorialExperience", () => {
  it("shows one guide card in the shell corner and marks the target", () => {
    const tutorial = tutorialBridge([]);
    render(tutorial);

    expect(card()?.textContent).toContain("Choose your keybindings");
    expect(canvasRoot.querySelectorAll(".tutorial-guide")).toHaveLength(1);
    expect(card()?.parentElement?.className).toBe("tutorial-experience");
    expect(card()?.parentElement?.parentElement?.className).toBe(
      "review-document-shell",
    );
    expect(section("Welcome").dataset.tutorialChapterState).toBe("active");
    expect(section("Commits and diffs").dataset.tutorialChapterState).toBe(
      "upcoming",
    );
    expect(
      canvasRoot
        .querySelector(".tutorial-keymap-picker")
        ?.getAttribute("data-tutorial-target"),
    ).toBe("chooseKeymap");
    expect(canvasRoot.querySelector(".tutorial-scrim")).toBeNull();
    expect(canvasRoot.querySelector(".tutorial-spotlight")).toBeNull();
  });

  it("draws target rings in a layer inside the scroll region", () => {
    const tutorial = tutorialBridge([]);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    try {
      render(tutorial);
    } finally {
      vi.unstubAllGlobals();
    }

    const layer = canvasRoot.querySelector(
      ".review-view-region > .tutorial-target-layer",
    );
    expect(layer?.querySelectorAll(".tutorial-target-ring")).toHaveLength(1);
    expect(
      canvasRoot.querySelectorAll(".tutorial-experience .tutorial-target-ring"),
    ).toHaveLength(0);
  });

  it("draws a toolbar target's ring in the shell overlay", () => {
    const tutorial = tutorialBridge([
      "chooseKeymap",
      "showHover",
      "gotoDefinition",
      "openPeek",
    ]);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
    try {
      render(tutorial);
    } finally {
      vi.unstubAllGlobals();
    }

    // The Commits tab sits outside the region; the prose button inside it.
    expect(
      canvasRoot.querySelectorAll(".tutorial-experience .tutorial-target-ring"),
    ).toHaveLength(2);
    expect(
      canvasRoot.querySelector(".review-view-region > .tutorial-target-layer"),
    ).toBeNull();
  });

  it("expands the active chapter without collapsing the others", () => {
    const tutorial = tutorialBridge([]);
    render(tutorial);
    const toggle = (title: string) =>
      section(title).querySelector<HTMLButtonElement>(
        ".review-section-toggle",
      )!;
    act(() => toggle("Comments are threads").click());
    expect(toggle("Comments are threads").getAttribute("aria-expanded")).toBe(
      "false",
    );
    act(() => toggle("Welcome").click());
    expect(toggle("Welcome").getAttribute("aria-expanded")).toBe("false");

    act(() => {
      root?.render(
        <ReviewSessionProvider session={session}>
          <TutorialProvider
            tutorial={tutorialBridge([
              "chooseKeymap",
              "showHover",
              "gotoDefinition",
              "openPeek",
              "openCommits",
              "openDiff",
            ])}
          >
            <Shell />
          </TutorialProvider>
        </ReviewSessionProvider>,
      );
    });

    expect(toggle("Comments are threads").getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(toggle("Welcome").getAttribute("aria-expanded")).toBe("false");
    expect(section("Welcome").dataset.tutorialChapterState).toBe("complete");
    expect(card()?.textContent).toContain("Start a thread");
  });

  it("completes a button step from the real target click", () => {
    const tutorial = tutorialBridge([
      "chooseKeymap",
      "showHover",
      "gotoDefinition",
      "openPeek",
    ]);
    render(tutorial);

    const commits = canvasRoot.querySelector<HTMLButtonElement>(
      '.review-segment[aria-label="Commits"]',
    )!;
    expect(card()?.textContent).toContain("Inspect the commits");
    expect(commits.dataset.tutorialTarget).toBe("openCommits");
    expect(
      canvasRoot.querySelector<HTMLElement>(".tutorial-view-button")?.dataset
        .tutorialTarget,
    ).toBe("openCommits");
    act(() => commits.click());
    expect(tutorial.setStep).toHaveBeenCalledWith("openCommits", true);
  });

  it("keeps the guide in a non-document view and marks its target", () => {
    const tutorial = tutorialBridge([
      "chooseKeymap",
      "showHover",
      "gotoDefinition",
      "openPeek",
      "openCommits",
    ]);
    render(tutorial, { activeView: "commits" });

    expect(card()?.textContent).toContain("Open a focused diff");
    expect(
      canvasRoot.querySelector<HTMLElement>(".review-commit-open")?.dataset
        .tutorialTarget,
    ).toBe("openDiff");
  });

  it("places the guide without a scrim, spotlight, or measured position", () => {
    const css = readFileSync("app/src/styles.css", "utf8");

    expect(css).not.toContain(".tutorial-scrim");
    expect(css).not.toContain(".tutorial-spotlight");
    expect(css).not.toContain("--tutorial-guide-top");
    expect(css).toContain("[data-tutorial-target]");
    expect(css).toContain(`.view-line[data-tutorial-line],
  [data-tutorial-target]
    .margin-view-overlays
    > div[data-tutorial-line]
    > .comment-range-glyph.comment-diff-added::before {
    animation: none;
  }`);
  });

  it("coalesces target discovery after several DOM mutations", async () => {
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.fn<(callback: FrameRequestCallback) => number>(
      (callback) => {
        frames.push(callback);
        return frames.length;
      },
    );
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    try {
      render(tutorialBridge([]));
      frames.length = 0;
      requestFrame.mockClear();

      const firstTarget = document.createElement("div");
      firstTarget.className = "tutorial-keymap-picker";
      await act(async () => {
        section("Welcome").append(firstTarget);
        await Promise.resolve();
      });

      const secondTarget = document.createElement("div");
      secondTarget.className = "tutorial-keymap-picker";
      await act(async () => {
        section("Welcome").append(secondTarget);
        await Promise.resolve();
      });

      expect(requestFrame).toHaveBeenCalledOnce();
      act(() => frames[0]?.(0));
      expect(firstTarget.dataset.tutorialTarget).toBe("chooseKeymap");
      expect(secondTarget.dataset.tutorialTarget).toBe("chooseKeymap");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("gets out of the way and completes the sequence step when its real tour opens", async () => {
    const tutorial = tutorialBridge([
      "chooseKeymap",
      "showHover",
      "gotoDefinition",
      "openPeek",
      "openCommits",
      "openDiff",
      "leaveComment",
    ]);
    render(tutorial);

    expect(card()?.textContent).toContain("Walk the sequence");
    const diagramTour = document.createElement("div");
    diagramTour.className = "diagram-tour-overlay";
    const sequence = document.createElement("div");
    sequence.className = "sequence-diagram";
    diagramTour.append(sequence);
    await act(async () => {
      canvasRoot.append(diagramTour);
      await Promise.resolve();
    });

    expect(card()).toBeNull();
    expect(tutorial.setStep).toHaveBeenCalledWith("openSequence", true);
  });

  it("completes the database stop from the real database Tour", async () => {
    const tutorial = tutorialBridge([
      "chooseKeymap",
      "showHover",
      "gotoDefinition",
      "openPeek",
      "openCommits",
      "openDiff",
      "leaveComment",
      "openSequence",
    ]);
    render(tutorial);

    expect(card()?.textContent).toContain("Inspect the database flow");
    const diagramTour = document.createElement("div");
    diagramTour.className = "diagram-tour-overlay";
    const database = document.createElement("div");
    database.className = "database-lens";
    diagramTour.append(database);
    await act(async () => {
      canvasRoot.append(diagramTour);
      await Promise.resolve();
    });

    expect(card()).toBeNull();
    expect(tutorial.setStep).toHaveBeenCalledWith("openDatabase", true);
  });

  it("completes the comment step once a thread exists", () => {
    const tutorial = tutorialBridge([
      "chooseKeymap",
      "showHover",
      "gotoDefinition",
      "openPeek",
      "openCommits",
      "openDiff",
    ]);
    reviewState.threads = [{}];
    render(tutorial);

    expect(tutorial.setStep).toHaveBeenCalledWith("leaveComment", true);
  });

  it("forces the tour forward with Next", () => {
    const tutorial = tutorialBridge([]);
    render(tutorial);

    const next = [...canvasRoot.querySelectorAll("button")].find(
      (button) => button.textContent === "Next",
    );
    expect(next).toBeDefined();
    act(() => next?.click());
    expect(tutorial.setStep).toHaveBeenCalledWith("chooseKeymap", true);
    expect(tutorial.dismiss).not.toHaveBeenCalled();
  });

  it("folds to its header while a comment composer has focus", () => {
    const tutorial = tutorialBridge([]);
    render(tutorial);
    const composer = document.createElement("form");
    composer.className = "thread-compose";
    const input = document.createElement("textarea");
    composer.append(input);
    section("Welcome").append(composer);

    act(() => input.focus());
    expect(card()?.classList.contains("tutorial-guide--folded")).toBe(true);
    act(() => input.blur());
    expect(card()?.classList.contains("tutorial-guide--folded")).toBe(false);
  });

  it("steps back to the previous chapter's last step and numbers sub-steps", () => {
    const tutorial = tutorialBridge([
      "chooseKeymap",
      "showHover",
      "gotoDefinition",
      "openPeek",
    ]);
    render(tutorial);

    expect(card()?.querySelector("header span")?.textContent).toBe(
      "Chapter 2.1 of 5",
    );
    const back = [...canvasRoot.querySelectorAll("button")].find(
      (button) => button.textContent === "Back",
    );
    act(() => back?.click());
    expect(tutorial.setStep).toHaveBeenCalledTimes(1);
    expect(tutorial.setStep).toHaveBeenCalledWith("openPeek", false);
  });

  it("scrolls an off-screen step target into view once", () => {
    const tutorial = tutorialBridge([]);
    const scrolled = vi.fn<() => void>();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrolled,
    });
    const offScreen = { top: 2000, bottom: 2040 } as DOMRect;
    const viewRect = { top: 0, bottom: 800 } as DOMRect;
    const original = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () {
      return this.classList.contains("tutorial-keymap-picker")
        ? offScreen
        : viewRect;
    };
    try {
      render(tutorial);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original;
    }

    const targetScrolls = scrolled.mock.contexts.filter((element) =>
      (element as HTMLElement).classList.contains("tutorial-keymap-picker"),
    );
    expect(targetScrolls).toHaveLength(1);
  });

  it("marks the first declaration line and its gutter row on the comment step", async () => {
    const tutorial = tutorialBridge([
      "chooseKeymap",
      "showHover",
      "gotoDefinition",
      "openPeek",
      "openCommits",
      "openDiff",
    ]);
    render(tutorial);
    const editor = document.createElement("div");
    editor.className = "review-inline-editor";
    const lines = document.createElement("div");
    lines.className = "view-lines";
    const margins = document.createElement("div");
    margins.className = "margin-view-overlays";
    const rows = [
      'import\u00a0type\u00a0{\u00a0CheckoutItem\u00a0}\u00a0from\u00a0"../orders/order.js";',
      "",
      "export\u00a0class\u00a0InventoryService\u00a0{",
      "\u00a0\u00a0reserve(_items:\u00a0readonly\u00a0CheckoutItem[]):\u00a0void\u00a0{}",
      "\u00a0\u00a0reserve(items:\u00a0readonly\u00a0CheckoutItem[]):\u00a0void\u00a0{",
      "\u00a0\u00a0\u00a0\u00a0const\u00a0unavailable\u00a0=\u00a0items.find((item)\u00a0=>\u00a0item.quantity\u00a0<\u00a01);",
    ];
    // Reverse DOM order: Monaco does not keep rows in line order.
    for (const [index, text] of [...rows.entries()].reverse()) {
      const line = document.createElement("div");
      line.className = "view-line";
      line.style.top = `${index * 18}px`;
      line.textContent = text;
      lines.append(line);
      const margin = document.createElement("div");
      margin.style.top = `${index * 18}px`;
      margins.append(margin);
    }
    editor.append(margins, lines);
    await act(async () => {
      section("Comments are threads")
        .querySelector(".review-section-body")
        ?.append(editor);
      await Promise.resolve();
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    });

    const marked = [
      ...editor.querySelectorAll<HTMLElement>("[data-tutorial-line]"),
    ];
    expect(marked).toHaveLength(2);
    expect(marked.map((element) => element.style.top)).toEqual([
      "72px",
      "72px",
    ]);
    expect(
      marked.find((element) => element.classList.contains("view-line"))
        ?.textContent,
    ).toContain("reserve(items");
  });

  it("finishes from the final Get help stop", () => {
    const tutorial = tutorialBridge([
      "chooseKeymap",
      "showHover",
      "gotoDefinition",
      "openPeek",
      "openCommits",
      "openDiff",
      "leaveComment",
      "openSequence",
      "openDatabase",
    ]);
    render(tutorial);

    expect(card()?.textContent).toContain("Know where to get help");
    const finish = [...canvasRoot.querySelectorAll("button")].find(
      (button) => button.textContent === "Finish tour",
    );
    act(() => finish?.click());

    expect(tutorial.setStep).toHaveBeenCalledWith("getHelp", true);
    expect(tutorial.close).toHaveBeenCalledOnce();
  });

  it("renders no card or chapter state when dismissed", () => {
    render(tutorialBridge([], true));

    expect(card()).toBeNull();
    expect(section("Welcome").dataset.tutorialChapterState).toBeUndefined();
    expect(canvasRoot.querySelector("[data-tutorial-target]")).toBeNull();
  });

  it("shrinks to a floating Tutorial button when hidden", () => {
    const tutorial = tutorialBridge([], true);
    render(tutorial);

    const pill = canvasRoot.querySelector<HTMLButtonElement>(
      ".tutorial-experience > .tutorial-guide-pill",
    );
    expect(pill?.getAttribute("aria-label")).toBe("Show tutorial");
    expect(pill?.querySelector(".ui-icon--tutorial")).not.toBeNull();
    expect(card()).toBeNull();
    act(() => pill?.click());
    expect(tutorial.reopen).toHaveBeenCalledOnce();
  });
});

function tutorialBridge(
  checked: ReviewCanvasTutorialBridge["content"]["progress"]["checked"],
  dismissed = false,
) {
  const setStep = vi.fn<ReviewCanvasTutorialBridge["setStep"]>();
  return {
    content: {
      reviewUuid: "tutorial-review",
      progress: { version: 1, checked, dismissed },
      keymap: "none",
    },
    setStep,
    dismiss: vi.fn<ReviewCanvasTutorialBridge["dismiss"]>(),
    reopen: vi.fn<ReviewCanvasTutorialBridge["reopen"]>(),
    selectKeymap: vi.fn<ReviewCanvasTutorialBridge["selectKeymap"]>(
      async () => {},
    ),
    close: vi.fn<ReviewCanvasTutorialBridge["close"]>(),
  } satisfies ReviewCanvasTutorialBridge;
}
