// @vitest-environment jsdom

import { readFileSync } from "node:fs";

import type { ReviewCanvasTutorialBridge } from "@dev.fast/review-protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TutorialProvider } from "./tutorial-context";
import {
  TutorialExperience,
  TutorialToolbarAction,
} from "./tutorial-experience";

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

class FakeResizeObserver {
  observe() {}
  disconnect() {}
  unobserve() {}
}

let root: ReturnType<typeof createRoot> | null = null;

beforeEach(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  reviewState.softwareMapEnabled = false;
  reviewState.threads = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn<() => void>(),
  });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.replaceChildren();
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("TutorialExperience", () => {
  it("shows one active instruction and progressively discloses chapters", () => {
    const { app, mount, sections } = tutorialSurface();
    const tutorial = tutorialBridge([]);
    root = createRoot(mount);
    act(() => {
      root?.render(
        <TutorialProvider tutorial={tutorial}>
          <TutorialExperience />
        </TutorialProvider>,
      );
    });

    expect(app.querySelector(".tutorial-guide")?.textContent).toContain(
      "Choose your keybindings",
    );
    expect(app.querySelectorAll(".tutorial-guide-copy h2")).toHaveLength(1);
    expect(
      app
        .querySelector(".tutorial-scrim mask rect:nth-of-type(2)")
        ?.getAttribute("width"),
    ).toBe("666");
    expect(app.querySelector(".tutorial-spotlight")).not.toBeNull();
    expect(sections.get("Welcome")?.toggle.ariaExpanded).toBe("true");
    expect(sections.get("Commits and diffs")?.toggle.ariaExpanded).toBe(
      "false",
    );
    expect(sections.get("Comments are threads")?.toggle.ariaExpanded).toBe(
      "false",
    );
    expect(sections.get("Interactive Diagrams")?.toggle.ariaExpanded).toBe(
      "false",
    );
  });

  it("completes a button step from the real target click", () => {
    const { mount, commits } = tutorialSurface();
    const tutorial = tutorialBridge([
      "chooseKeymap",
      "showHover",
      "gotoDefinition",
      "openPeek",
    ]);
    root = createRoot(mount);
    act(() => {
      root?.render(
        <TutorialProvider tutorial={tutorial}>
          <TutorialExperience />
        </TutorialProvider>,
      );
    });

    expect(
      mount.parentElement?.querySelector(".tutorial-guide")?.textContent,
    ).toContain("Inspect the commits");
    expect(
      mount.parentElement
        ?.querySelector<HTMLElement>(".tutorial-experience")
        ?.style.getPropertyValue("--tutorial-guide-top"),
    ).toBe("80px");
    act(() => commits.click());
    expect(tutorial.setStep).toHaveBeenCalledWith("openCommits", true);
  });

  it("uses no animated target ring", () => {
    const css = readFileSync("app/src/styles.css", "utf8");

    expect(css).not.toContain(".tutorial-spotlight::after");
    expect(css).not.toContain("tutorial-target-pulse");
    expect(css).toMatch(
      /\.tutorial-experience\s*{[^}]*z-index:\s*calc\(var\(--review-debug-layer\) \+ 1\);/s,
    );
  });

  it("gets out of the way and completes the sequence step when its real tour opens", async () => {
    const { canvasRoot, mount } = tutorialSurface();
    const tutorial = tutorialBridge([
      "chooseKeymap",
      "showHover",
      "gotoDefinition",
      "openPeek",
      "openCommits",
      "openDiff",
      "leaveComment",
    ]);
    root = createRoot(mount);
    act(() => {
      root?.render(
        <TutorialProvider tutorial={tutorial}>
          <TutorialExperience />
        </TutorialProvider>,
      );
    });

    expect(canvasRoot.querySelector(".tutorial-guide")?.textContent).toContain(
      "Walk the sequence",
    );
    const diagramTour = document.createElement("div");
    diagramTour.className = "diagram-tour-overlay";
    const sequence = document.createElement("div");
    sequence.className = "sequence-diagram";
    diagramTour.append(sequence);
    await act(async () => {
      canvasRoot.append(diagramTour);
      await Promise.resolve();
    });

    expect(canvasRoot.querySelector(".tutorial-guide")).toBeNull();
    expect(tutorial.setStep).toHaveBeenCalledWith("openSequence", true);
  });

  it("completes the database stop from the real database Tour", async () => {
    const { canvasRoot, mount } = tutorialSurface();
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
    root = createRoot(mount);
    act(() => {
      root?.render(
        <TutorialProvider tutorial={tutorial}>
          <TutorialExperience />
        </TutorialProvider>,
      );
    });

    expect(canvasRoot.querySelector(".tutorial-guide")?.textContent).toContain(
      "Inspect the database flow",
    );
    const diagramTour = document.createElement("div");
    diagramTour.className = "diagram-tour-overlay";
    const database = document.createElement("div");
    database.className = "database-lens";
    diagramTour.append(database);
    await act(async () => {
      canvasRoot.append(diagramTour);
      await Promise.resolve();
    });

    expect(canvasRoot.querySelector(".tutorial-guide")).toBeNull();
    expect(tutorial.setStep).toHaveBeenCalledWith("openDatabase", true);
  });

  it("finishes from the final Get help stop", () => {
    const { canvasRoot, mount } = tutorialSurface();
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
    root = createRoot(mount);
    act(() => {
      root?.render(
        <TutorialProvider tutorial={tutorial}>
          <TutorialExperience />
        </TutorialProvider>,
      );
    });

    expect(canvasRoot.querySelector(".tutorial-guide")?.textContent).toContain(
      "Know where to get help",
    );
    const finish = [...canvasRoot.querySelectorAll("button")].find(
      (button) => button.textContent === "Finish tour",
    );
    act(() => finish?.click());

    expect(tutorial.setStep).toHaveBeenCalledWith("getHelp", true);
    expect(tutorial.close).toHaveBeenCalledOnce();
  });

  it("renders the dismissed affordance as the primary Resume Tutorial action", () => {
    const mount = document.createElement("div");
    document.body.append(mount);
    const tutorial = tutorialBridge([], true);
    root = createRoot(mount);
    act(() => {
      root?.render(
        <TutorialProvider tutorial={tutorial}>
          <TutorialToolbarAction />
        </TutorialProvider>,
      );
    });

    const button = mount.querySelector("button");
    expect(button?.textContent).toBe("Resume Tutorial");
    expect(button?.classList.contains("review-corner-submit")).toBe(true);
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

function tutorialSurface(): {
  canvasRoot: HTMLElement;
  app: HTMLElement;
  mount: HTMLElement;
  commits: HTMLButtonElement;
  sections: Map<string, { section: HTMLElement; toggle: HTMLButtonElement }>;
} {
  const canvasRoot = document.createElement("div");
  canvasRoot.className = "review-canvas-root";
  const app = document.createElement("div");
  app.className = "review-app review-document-shell";
  app.getBoundingClientRect = () => rect(0, 0, 1200, 800);
  const commits = document.createElement("button");
  commits.className = "review-segment";
  commits.setAttribute("aria-label", "Commits");
  commits.getBoundingClientRect = () => rect(60, 12, 74, 28);
  app.append(commits);
  const viewRegion = document.createElement("section");
  viewRegion.className = "review-view-region";
  viewRegion.getBoundingClientRect = () => rect(0, 64, 1200, 736);
  app.append(viewRegion);
  const sections = new Map<
    string,
    { section: HTMLElement; toggle: HTMLButtonElement }
  >();
  for (const [index, title] of [
    "Welcome",
    "Commits and diffs",
    "Comments are threads",
    "Interactive Diagrams",
    "Get help",
  ].entries()) {
    const section = document.createElement("section");
    section.className = "review-section";
    section.dataset.reviewSection = title;
    section.getBoundingClientRect = () => rect(300, 96 + index * 120, 650, 104);
    const toggle = document.createElement("button");
    toggle.className = "review-section-toggle";
    toggle.ariaExpanded = "true";
    toggle.addEventListener("click", () => {
      toggle.ariaExpanded = toggle.ariaExpanded === "true" ? "false" : "true";
    });
    section.append(toggle);
    const body = document.createElement("div");
    body.className = "review-section-body";
    body.getBoundingClientRect = () => rect(320, 130 + index * 120, 610, 56);
    section.append(body);
    if (title === "Welcome") {
      const picker = document.createElement("div");
      picker.className = "tutorial-keymap-picker";
      picker.getBoundingClientRect = () => rect(320, 160, 280, 42);
      body.append(picker);
    }
    viewRegion.append(section);
    sections.set(title, { section, toggle });
  }
  const mount = document.createElement("div");
  viewRegion.append(mount);
  canvasRoot.append(app);
  document.body.append(canvasRoot);
  return { canvasRoot, app, mount, commits, sections };
}

function rect(
  left: number,
  top: number,
  width: number,
  height: number,
): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  };
}
