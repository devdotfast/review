import type { TutorialStepId } from "@dev.fast/review-protocol";
import {
  type CSSProperties,
  type ReactElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useReview } from "./review-context";
import {
  REVIEW_INTERACTION_EVENT,
  reviewInteractionDetail,
} from "./review-interaction-event";
import { useTutorial } from "./tutorial-context";
import {
  TUTORIAL_CHAPTERS,
  type TutorialChapterId,
  type TutorialStepDefinition,
  availableTutorialSteps,
  tutorialChapter,
} from "./tutorial-plan";

interface TutorialTargetLayout {
  stepId: TutorialStepId;
  left: number;
  top: number;
  width: number;
  height: number;
  chapterLeft: number;
  chapterTop: number;
  chapterWidth: number;
  chapterHeight: number;
  guideLeft: number;
  guideTop: number;
}

type DiagramTourKind = "sequence" | "database" | "other";

const GUIDE_WIDTH = 292;
const GUIDE_HEIGHT_ESTIMATE = 224;
const GUIDE_GAP = 14;
const EDGE_GAP = 16;

export function TutorialExperience(): ReactElement | null {
  const tutorial = useTutorial();
  const review = useReview();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const revealedChapterRef = useRef<TutorialChapterId | null>(null);
  const [targetLayout, setTargetLayout] = useState<TutorialTargetLayout | null>(
    null,
  );
  const [diagramTourKind, setDiagramTourKind] =
    useState<DiagramTourKind | null>(null);
  const steps = useMemo(
    () => availableTutorialSteps(review.softwareMapEnabled),
    [review.softwareMapEnabled],
  );
  const checkedKey = tutorial?.content.progress.checked.join("\u0000") ?? "";
  const checked = useMemo(
    () => new Set(tutorial?.content.progress.checked ?? []),
    [checkedKey],
  );
  const activeStep = steps.find((step) => !checked.has(step.id)) ?? null;
  const activeChapterId: TutorialChapterId = activeStep?.chapter ?? "finish";
  const dismissed = tutorial?.content.progress.dismissed ?? true;
  const completed = activeStep === null;
  const activeIndex = activeStep
    ? steps.findIndex((step) => step.id === activeStep.id)
    : steps.length;
  const threadCount = review.allCommentThreads().length;
  const guideHidden = dismissed || diagramTourKind !== null;

  const completeStep = useCallback(
    (step: TutorialStepDefinition) => {
      if (!tutorial || checked.has(step.id)) return;
      tutorial.setStep(step.id, true);
    },
    [checked, tutorial],
  );

  useEffect(() => {
    if (
      dismissed ||
      !activeStep ||
      activeStep.completion !== "comment" ||
      threadCount === 0
    ) {
      return;
    }
    completeStep(activeStep);
  }, [activeStep, completeStep, dismissed, threadCount]);

  useLayoutEffect(() => {
    const root = hostRef.current?.closest<HTMLElement>(
      ".review-document-shell",
    );
    const canvasRoot =
      root?.closest<HTMLElement>(".review-canvas-root") ?? root?.parentElement;
    if (!canvasRoot) return;
    const update = () => {
      const overlay = canvasRoot.querySelector(".diagram-tour-overlay");
      setDiagramTourKind(
        !overlay
          ? null
          : overlay.querySelector(".database-lens")
            ? "database"
            : overlay.querySelector(".sequence-diagram")
              ? "sequence"
              : "other",
      );
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(canvasRoot, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (dismissed || !activeStep) {
      return;
    }
    const expectedStep =
      diagramTourKind === "sequence"
        ? "openSequence"
        : diagramTourKind === "database"
          ? "openDatabase"
          : null;
    if (activeStep.id === expectedStep) completeStep(activeStep);
  }, [activeStep, completeStep, diagramTourKind, dismissed]);

  useEffect(() => {
    const root = hostRef.current?.closest<HTMLElement>(
      ".review-document-shell",
    );
    if (!root || dismissed || !activeStep) return;
    const onClick = (event: Event) => {
      if (activeStep.completion !== "click") return;
      const clicked = event.target;
      if (!(clicked instanceof Element)) return;
      if (clicked.closest(activeStep.targetSelector)) completeStep(activeStep);
    };
    const onReviewInteraction = (event: Event) => {
      const detail = reviewInteractionDetail(event);
      if (!detail) return;
      if (
        (activeStep.completion === "inline-hover" &&
          detail.kind === "inline-hover") ||
        (activeStep.completion === "inline-navigation" &&
          detail.kind === "inline-navigation")
      ) {
        completeStep(activeStep);
      }
    };
    root.addEventListener("click", onClick, true);
    root.addEventListener(REVIEW_INTERACTION_EVENT, onReviewInteraction);
    return () => {
      root.removeEventListener("click", onClick, true);
      root.removeEventListener(REVIEW_INTERACTION_EVENT, onReviewInteraction);
    };
  }, [activeStep, completeStep, dismissed]);

  useLayoutEffect(() => {
    const root = hostRef.current?.closest<HTMLElement>(
      ".review-document-shell",
    );
    if (!root || dismissed) {
      revealedChapterRef.current = null;
      return;
    }
    const activeTitle = tutorialChapter(activeChapterId).title;
    const availableByChapter = new Map<TutorialChapterId, TutorialStepId[]>();
    for (const step of steps) {
      const values = availableByChapter.get(step.chapter) ?? [];
      values.push(step.id);
      availableByChapter.set(step.chapter, values);
    }
    const sections = [
      ...root.querySelectorAll<HTMLElement>("[data-review-section]"),
    ];
    for (const section of sections) {
      const title = section.dataset.reviewSection;
      const chapter = TUTORIAL_CHAPTERS.find(
        (candidate) => candidate.title === title,
      );
      if (!chapter) continue;
      const chapterSteps = availableByChapter.get(chapter.id) ?? [];
      const chapterComplete =
        chapter.id === "finish"
          ? completed
          : chapterSteps.every((id) => checked.has(id));
      section.dataset.tutorialChapterState =
        chapter.id === activeChapterId
          ? "active"
          : chapterComplete
            ? "complete"
            : "upcoming";
      const toggle = section.querySelector<HTMLButtonElement>(
        ".review-section-toggle",
      );
      const shouldExpand = title === activeTitle;
      const expanded = toggle?.getAttribute("aria-expanded") === "true";
      if (toggle && shouldExpand !== expanded) toggle.click();
    }
    if (revealedChapterRef.current !== activeChapterId) {
      const activeSection = sections.find(
        (section) => section.dataset.reviewSection === activeTitle,
      );
      activeSection?.scrollIntoView({ block: "start", behavior: "smooth" });
      revealedChapterRef.current = activeChapterId;
    }
    return () => {
      for (const section of sections) {
        delete section.dataset.tutorialChapterState;
      }
    };
  }, [activeChapterId, checked, completed, dismissed, steps]);

  useLayoutEffect(() => {
    const root = hostRef.current?.closest<HTMLElement>(
      ".review-document-shell",
    );
    if (!root || guideHidden || !activeStep) {
      setTargetLayout(null);
      return;
    }
    let target: HTMLElement | null = null;
    let targetResizeObserver: ResizeObserver | null = null;
    let frame = 0;
    let revealedTarget = false;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const nextTarget = root.querySelector<HTMLElement>(
          activeStep.targetSelector,
        );
        if (nextTarget !== target) {
          targetResizeObserver?.disconnect();
          target = nextTarget;
          if (target && typeof ResizeObserver !== "undefined") {
            targetResizeObserver = new ResizeObserver(update);
            targetResizeObserver.observe(target);
          }
        }
        if (!target) {
          setTargetLayout(null);
          return;
        }
        const rootRect = root.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const viewRect = root
          .querySelector<HTMLElement>(".review-view-region")
          ?.getBoundingClientRect();
        const guideHeight =
          hostRef.current
            ?.querySelector<HTMLElement>(".tutorial-guide")
            ?.getBoundingClientRect().height || GUIDE_HEIGHT_ESTIMATE;
        const chapterRect = root
          .querySelector<HTMLElement>('[data-tutorial-chapter-state="active"]')
          ?.getBoundingClientRect();
        if (
          targetRect.width <= 0 ||
          targetRect.height <= 0 ||
          targetRect.bottom <= rootRect.top ||
          targetRect.top >= rootRect.bottom
        ) {
          if (
            !revealedTarget &&
            targetRect.width > 0 &&
            targetRect.height > 0
          ) {
            revealedTarget = true;
            target.scrollIntoView({ block: "center", behavior: "smooth" });
          }
          setTargetLayout(null);
          return;
        }
        const left = targetRect.left - rootRect.left;
        const top = targetRect.top - rootRect.top;
        const width = targetRect.width;
        const height = targetRect.height;
        const rightSpace = rootRect.width - (left + width);
        const belowSpace = rootRect.height - (top + height);
        const guideMinTop = clamp(
          (viewRect?.top ?? rootRect.top) - rootRect.top + EDGE_GAP,
          EDGE_GAP,
          Math.max(EDGE_GAP, rootRect.height - EDGE_GAP),
        );
        const guideBottom = clamp(
          (viewRect?.bottom ?? rootRect.bottom) - rootRect.top - EDGE_GAP,
          guideMinTop,
          Math.max(guideMinTop, rootRect.height - EDGE_GAP),
        );
        const guideMaxTop = Math.max(guideMinTop, guideBottom - guideHeight);
        let guideLeft: number;
        let guideTop: number;
        if (rightSpace >= GUIDE_WIDTH + GUIDE_GAP + EDGE_GAP) {
          guideLeft = left + width + GUIDE_GAP;
          guideTop = clamp(top, guideMinTop, guideMaxTop);
        } else if (belowSpace >= GUIDE_HEIGHT_ESTIMATE + GUIDE_GAP) {
          guideLeft = clamp(
            left,
            EDGE_GAP,
            rootRect.width - GUIDE_WIDTH - EDGE_GAP,
          );
          guideTop = clamp(top + height + GUIDE_GAP, guideMinTop, guideMaxTop);
        } else {
          guideLeft = rootRect.width - GUIDE_WIDTH - EDGE_GAP;
          guideTop = guideMinTop;
        }
        setTargetLayout({
          stepId: activeStep.id,
          left,
          top,
          width,
          height,
          chapterLeft: chapterRect ? chapterRect.left - rootRect.left : 0,
          chapterTop: chapterRect ? chapterRect.top - rootRect.top : 0,
          chapterWidth: chapterRect?.width ?? 0,
          chapterHeight: chapterRect?.height ?? 0,
          guideLeft,
          guideTop,
        });
      });
    };
    const mutationObserver = new MutationObserver(update);
    mutationObserver.observe(root, {
      attributes: true,
      attributeFilter: ["aria-expanded", "aria-pressed", "class", "hidden"],
      childList: true,
      subtree: true,
    });
    const rootResizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    rootResizeObserver?.observe(root);
    root.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    update();
    return () => {
      cancelAnimationFrame(frame);
      mutationObserver.disconnect();
      rootResizeObserver?.disconnect();
      targetResizeObserver?.disconnect();
      root.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [activeStep, guideHidden]);

  const goBack = useCallback(() => {
    if (!tutorial || activeIndex <= 0) return;
    const previous = steps[activeIndex - 1]!;
    if (activeStep?.chapter === "finish") {
      tutorial.setStep(previous.id, false);
      return;
    }
    if (activeStep && previous.chapter !== activeStep.chapter) {
      for (const step of steps) {
        if (step.chapter === previous.chapter) tutorial.setStep(step.id, false);
      }
      return;
    }
    tutorial.setStep(previous.id, false);
  }, [activeIndex, activeStep, steps, tutorial]);

  const finishTour = useCallback(() => {
    if (!tutorial || activeStep?.completion !== "finish") return;
    completeStep(activeStep);
    tutorial.close();
  }, [activeStep, completeStep, tutorial]);

  if (!tutorial) return null;
  const activeTargetLayout =
    targetLayout?.stepId === activeStep?.id ? targetLayout : null;
  const guideStyle = activeTargetLayout
    ? ({
        "--tutorial-guide-left": `${activeTargetLayout.guideLeft}px`,
        "--tutorial-guide-top": `${activeTargetLayout.guideTop}px`,
      } as CSSProperties)
    : undefined;
  const spotlightStyle = activeTargetLayout
    ? ({
        left: activeTargetLayout.left - 5,
        top: activeTargetLayout.top - 5,
        width: activeTargetLayout.width + 10,
        height: activeTargetLayout.height + 10,
      } as CSSProperties)
    : undefined;

  return (
    <div
      ref={hostRef}
      className="tutorial-experience"
      data-tutorial-active-step={activeStep?.id ?? "complete"}
      style={guideStyle}
    >
      {!guideHidden && activeTargetLayout ? (
        <>
          <svg className="tutorial-scrim" aria-hidden="true">
            <defs>
              <mask id="tutorial-scrim-mask" maskUnits="userSpaceOnUse">
                <rect width="100%" height="100%" fill="white" />
                <rect
                  x={activeTargetLayout.chapterLeft - 8}
                  y={activeTargetLayout.chapterTop - 8}
                  width={activeTargetLayout.chapterWidth + 16}
                  height={activeTargetLayout.chapterHeight + 16}
                  rx="10"
                  fill="black"
                />
                <rect
                  x={activeTargetLayout.left - 5}
                  y={activeTargetLayout.top - 5}
                  width={activeTargetLayout.width + 10}
                  height={activeTargetLayout.height + 10}
                  rx="9"
                  fill="black"
                />
              </mask>
            </defs>
            <rect
              width="100%"
              height="100%"
              fill="var(--tutorial-scrim)"
              mask="url(#tutorial-scrim-mask)"
            />
          </svg>
          <div
            className="tutorial-spotlight"
            style={spotlightStyle}
            aria-hidden="true"
          />
        </>
      ) : null}
      {!guideHidden ? (
        <TutorialGuide
          activeStep={activeStep}
          activeIndex={activeIndex}
          totalSteps={steps.length}
          targetFound={activeTargetLayout !== null}
          onBack={goBack}
          onDismiss={tutorial.dismiss}
          onFinish={finishTour}
          onClose={tutorial.close}
        />
      ) : null}
    </div>
  );
}

function TutorialGuide({
  activeStep,
  activeIndex,
  totalSteps,
  targetFound,
  onBack,
  onDismiss,
  onFinish,
  onClose,
}: {
  activeStep: TutorialStepDefinition | null;
  activeIndex: number;
  totalSteps: number;
  targetFound: boolean;
  onBack(): void;
  onDismiss(): void;
  onFinish(): void;
  onClose(): void;
}): ReactElement {
  const chapter = tutorialChapter(activeStep?.chapter ?? "finish");
  const chapterIndex = TUTORIAL_CHAPTERS.findIndex(
    (candidate) => candidate.id === chapter.id,
  );
  const fallback = activeStep
    ? tutorialFallbackAction(activeStep, targetFound)
    : tutorialViewAction("review", "Return to the tour");
  return (
    <aside className="tutorial-guide" aria-label="Tutorial guide">
      <header>
        <span>
          Chapter {chapterIndex + 1} of {TUTORIAL_CHAPTERS.length}
        </span>
        <button type="button" onClick={onDismiss} aria-label="Hide tutorial">
          ×
        </button>
      </header>
      <div className="tutorial-guide-progress" aria-hidden="true">
        <span
          style={{
            width: `${Math.round((activeIndex / Math.max(1, totalSteps)) * 100)}%`,
          }}
        />
      </div>
      <div className="tutorial-guide-copy" aria-live="polite">
        <p>{chapter.title}</p>
        <h2>{activeStep?.title ?? "Tour complete"}</h2>
        <p>
          {activeStep?.instruction ??
            "You have walked through the core Review experience."}
        </p>
        {fallback ? (
          <button
            type="button"
            className="tutorial-guide-primary"
            onClick={fallback.run}
          >
            {fallback.label}
          </button>
        ) : null}
      </div>
      <footer>
        <button type="button" onClick={onBack} disabled={activeIndex <= 0}>
          Back
        </button>
        {activeStep?.completion === "finish" ? (
          <button type="button" onClick={onFinish}>
            Finish tour
          </button>
        ) : activeStep ? (
          <button type="button" onClick={onDismiss}>
            Skip tour
          </button>
        ) : (
          <button type="button" onClick={onClose}>
            Close tutorial
          </button>
        )}
      </footer>
    </aside>
  );
}

function tutorialFallbackAction(
  step: TutorialStepDefinition,
  targetFound: boolean,
): { label: string; run(): void } | null {
  if (targetFound) return null;
  if (step.id === "openDiff") {
    return tutorialViewAction("commits", "Open Commits");
  }
  if (
    step.chapter === "welcome" ||
    step.chapter === "comments" ||
    step.chapter === "diagrams" ||
    step.chapter === "finish"
  ) {
    return tutorialViewAction("review", "Return to the tour");
  }
  return null;
}

function tutorialViewAction(
  view: "review" | "commits",
  label: string,
): { label: string; run(): void } {
  return {
    label,
    run: () => {
      const ariaLabel = view === "review" ? "Review" : "Commits";
      document
        .querySelector<HTMLButtonElement>(
          `.review-segment[aria-label="${ariaLabel}"]`,
        )
        ?.click();
    },
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

export function TutorialToolbarAction(): ReactElement | null {
  const tutorial = useTutorial();
  if (!tutorial || !tutorial.content.progress.dismissed) return null;
  return (
    <button
      type="button"
      className="tutorial-toolbar-action review-corner-submit"
      onClick={tutorial.reopen}
    >
      Resume Tutorial
    </button>
  );
}
