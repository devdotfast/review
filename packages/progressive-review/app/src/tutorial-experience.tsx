import {
  type ReactElement,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { TutorialIcon } from "./icons";
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
import {
  type TutorialChapterState,
  TutorialSectionProvider,
} from "./tutorial-section-context";

type DiagramTourKind = "sequence" | "database" | "other";

interface TutorialExperienceState {
  activeStep: TutorialStepDefinition | null;
  activeIndex: number;
  steps: readonly TutorialStepDefinition[];
  totalSteps: number;
  hidden: boolean;
  /** A comment composer has focus: the guide folds to its header. */
  composing: boolean;
  onBack(): void;
  onNext(): void;
  onDismiss(): void;
  onFinish(): void;
  onClose(): void;
}

const COMPOSER_SELECTOR =
  ".comment-form-container, .review-widget.compact-comment-thread, .thread-compose";

/**
 * Drives the tutorial for the document shell it wraps. The guide card sits in
 * the bottom right corner of the shell in every view; hidden, it shrinks to a
 * small floating button there. The step's target carries
 * `data-tutorial-target` for its highlight. Nothing measures the target, so
 * typing and scrolling never move the card.
 */
export function TutorialExperienceProvider({
  shellRef,
  scrollRegionRef,
  children,
}: {
  shellRef: RefObject<HTMLElement | null>;
  /** The scrolling view region; target rings for its content live inside
      it so they scroll with the content. */
  scrollRegionRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}): ReactElement {
  const tutorial = useTutorial();
  const review = useReview();
  const revealedChapterRef = useRef<TutorialChapterId | null>(null);
  // The shell ref belongs to an ancestor, so it attaches after this
  // provider's layout effects. Read it once mounted and key effects on it.
  const [shell, setShell] = useState<HTMLElement | null>(null);
  const [region, setRegion] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setShell(shellRef.current);
    setRegion(scrollRegionRef?.current ?? null);
  }, [scrollRegionRef, shellRef]);
  const [targets, setTargets] = useState<readonly HTMLElement[]>([]);
  const [composing, setComposing] = useState(false);
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
  const hidden = !tutorial || dismissed || diagramTourKind !== null;

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
    const root = shell;
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
  }, [shell]);

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
    const root = shell;
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
  }, [activeStep, completeStep, dismissed, shell]);

  // Fold the guide while a comment composer has focus, so it never covers
  // the text the reader is writing.
  useEffect(() => {
    const root = shell;
    if (!root || hidden) return;
    const update = () => {
      const active = document.activeElement;
      setComposing(
        active instanceof Element && active.closest(COMPOSER_SELECTOR) !== null,
      );
    };
    root.addEventListener("focusin", update);
    root.addEventListener("focusout", update);
    update();
    return () => {
      root.removeEventListener("focusin", update);
      root.removeEventListener("focusout", update);
    };
  }, [hidden, shell]);

  // Bring a newly active chapter into view once. The section itself expands
  // through the section context; nothing collapses the other chapters.
  useLayoutEffect(() => {
    const root = shell;
    if (!root || hidden) {
      revealedChapterRef.current = null;
      return;
    }
    if (revealedChapterRef.current === activeChapterId) return;
    revealedChapterRef.current = activeChapterId;
    const activeTitle = tutorialChapter(activeChapterId).title;
    [...root.querySelectorAll<HTMLElement>("[data-review-section]")]
      .find((section) => section.dataset.reviewSection === activeTitle)
      ?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [activeChapterId, hidden, shell]);

  // Mark the active step's target. DOM changes coalesce into one query per
  // frame; no geometry is measured and state changes only when the answer does.
  useLayoutEffect(() => {
    const root = shell;
    if (!root || hidden || !activeStep) {
      setTargets([]);
      return;
    }
    // A step can name several targets (a toolbar tab and a prose button that
    // open the same view); every match is marked.
    let targets: HTMLElement[] = [];
    let revealed = false;
    let scheduledFrame: number | null = null;
    const apply = () => {
      let next = [
        ...root.querySelectorAll<HTMLElement>(activeStep.targetSelector),
      ];
      // A line-marking step points at one code block: the first visible match.
      if (activeStep.lineMatcher) {
        const first = next.find(
          (candidate) => candidate.closest("[hidden]") === null,
        );
        next = first ? [first] : [];
      }
      for (const target of targets) {
        if (!next.includes(target)) delete target.dataset.tutorialTarget;
      }
      for (const target of next) target.dataset.tutorialTarget = activeStep.id;
      targets = next;
      const visible = targets.filter(
        (target) => target.closest("[hidden]") === null,
      );
      setTargets((current) =>
        current.length === visible.length &&
        current.every((target, index) => target === visible[index])
          ? current
          : visible,
      );
      if (activeStep.lineMatcher && visible[0]) {
        markTutorialLine(root, visible[0], activeStep.lineMatcher);
      }
      // Bring an off-screen target into view once per step. This is the only
      // measurement the tutorial makes, and it happens on a step change, not
      // on scroll.
      const first = visible[0];
      if (first && !revealed) {
        revealed = true;
        const view = (
          root.querySelector(".review-view-region") ?? root
        ).getBoundingClientRect();
        const rect = first.getBoundingClientRect();
        if (rect.bottom > view.bottom || rect.top < view.top) {
          first.scrollIntoView({ block: "center", behavior: "smooth" });
        }
      }
    };
    const scheduleApply = () => {
      if (scheduledFrame !== null) return;
      scheduledFrame = requestAnimationFrame(() => {
        scheduledFrame = null;
        apply();
      });
    };
    const observer = new MutationObserver(scheduleApply);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["hidden"],
      childList: true,
      subtree: true,
    });
    apply();
    return () => {
      observer.disconnect();
      if (scheduledFrame !== null) cancelAnimationFrame(scheduledFrame);
      for (const target of targets) delete target.dataset.tutorialTarget;
      clearTutorialLine(root);
    };
  }, [activeStep, hidden, shell]);

  const rings = useTargetRings(targets, shell, region);

  // Back reopens the previous step only, so crossing a chapter boundary
  // lands on that chapter's last step rather than its first.
  const goBack = useCallback(() => {
    if (!tutorial || activeIndex <= 0) return;
    tutorial.setStep(steps[activeIndex - 1]!.id, false);
  }, [activeIndex, steps, tutorial]);

  const goNext = useCallback(() => {
    if (!tutorial || !activeStep || activeStep.completion === "finish") return;
    tutorial.setStep(activeStep.id, true);
  }, [activeStep, tutorial]);

  const finishTour = useCallback(() => {
    if (!tutorial || activeStep?.completion !== "finish") return;
    completeStep(activeStep);
    tutorial.close();
  }, [activeStep, completeStep, tutorial]);

  const experience: TutorialExperienceState | null = tutorial
    ? {
        activeStep,
        activeIndex,
        steps,
        totalSteps: steps.length,
        hidden,
        composing,
        onBack: goBack,
        onNext: goNext,
        onDismiss: tutorial.dismiss,
        onFinish: finishTour,
        onClose: tutorial.close,
      }
    : null;

  const sectionValue = useMemo(() => {
    const chapterStates = new Map<string, TutorialChapterState>();
    if (!tutorial || dismissed) return { chapterStates };
    for (const chapter of TUTORIAL_CHAPTERS) {
      const chapterSteps = steps.filter((step) => step.chapter === chapter.id);
      const chapterComplete =
        chapter.id === "finish"
          ? completed
          : chapterSteps.every((step) => checked.has(step.id));
      chapterStates.set(
        chapter.title,
        chapter.id === activeChapterId
          ? "active"
          : chapterComplete
            ? "complete"
            : "upcoming",
      );
    }
    return { chapterStates };
  }, [activeChapterId, checked, completed, dismissed, steps, tutorial]);

  return (
    <TutorialSectionProvider value={sectionValue}>
      {children}
      {region && rings.some((ring) => ring.host === "region")
        ? createPortal(
            <div className="tutorial-target-layer" aria-hidden="true">
              {rings
                .filter((ring) => ring.host === "region")
                .map((ring) => (
                  <TutorialTargetRing key={ring.key} ring={ring} />
                ))}
            </div>,
            region,
          )
        : null}
      {tutorial && diagramTourKind === null ? (
        <div className="tutorial-experience">
          {rings
            .filter((ring) => ring.host === "shell")
            .map((ring) => (
              <TutorialTargetRing key={ring.key} ring={ring} />
            ))}
          {dismissed ? (
            <button
              type="button"
              className="tutorial-guide-pill"
              aria-label="Show tutorial"
              title="Show tutorial"
              onClick={tutorial.reopen}
            >
              <TutorialIcon />
            </button>
          ) : (
            <TutorialGuide experience={experience} />
          )}
        </div>
      ) : null}
    </TutorialSectionProvider>
  );
}

/** The guide card: chapter, step, instruction, and tour controls. */
function TutorialGuide({
  experience,
}: {
  experience: TutorialExperienceState | null;
}): ReactElement | null {
  if (!experience || experience.hidden) return null;
  const { activeStep, activeIndex, totalSteps } = experience;
  const chapter = tutorialChapter(activeStep?.chapter ?? "finish");
  const chapterIndex = TUTORIAL_CHAPTERS.findIndex(
    (candidate) => candidate.id === chapter.id,
  );
  // "3.2" reads as chapter 3, step 2 within that chapter.
  const stepInChapter = activeStep
    ? experience.steps
        .filter((step) => step.chapter === activeStep.chapter)
        .findIndex((step) => step.id === activeStep.id) + 1
    : 0;
  const chapterLabel = stepInChapter
    ? `${chapterIndex + 1}.${stepInChapter}`
    : `${chapterIndex + 1}`;
  return (
    <aside
      className={
        experience.composing
          ? "tutorial-guide tutorial-guide--folded"
          : "tutorial-guide"
      }
      aria-label="Tutorial guide"
      data-tutorial-step={activeStep?.id ?? "complete"}
    >
      <header>
        <span>
          Chapter {chapterLabel} of {TUTORIAL_CHAPTERS.length}
        </span>
        <button
          type="button"
          onClick={experience.onDismiss}
          aria-label="Hide tutorial"
        >
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
      <div className="tutorial-guide-copy">
        <p>{chapter.title}</p>
        <h2>{activeStep?.title ?? "Tour complete"}</h2>
        <p>
          {activeStep?.instruction ??
            "You have walked through the core Review experience."}
        </p>
      </div>
      <footer>
        <button
          type="button"
          onClick={experience.onBack}
          disabled={activeIndex <= 0}
        >
          Back
        </button>
        {activeStep?.completion === "finish" ? (
          <button type="button" onClick={experience.onFinish}>
            Finish tour
          </button>
        ) : activeStep ? (
          <button type="button" onClick={experience.onNext}>
            Next
          </button>
        ) : (
          <button type="button" onClick={experience.onClose}>
            Close tutorial
          </button>
        )}
      </footer>
    </aside>
  );
}

interface TutorialRingBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface TutorialRing {
  key: string;
  /** Where the ring is drawn: inside the scroll region (moves with the
      content) or in the shell overlay (toolbar targets). */
  host: "region" | "shell";
  /** Inline targets (links) get one wash box per line, no outline. */
  inline: boolean;
  radius: number;
  boxes: TutorialRingBox[];
}

const RING_GAP = 4;

/**
 * Measures the marked targets and describes a ring for each. Measurement
 * happens on a target change, on a target or content resize, and on a
 * window resize — never on scroll. Rings for content inside the scroll
 * region are placed in the region's own coordinate space, so they travel
 * with the content and never lag.
 */
function useTargetRings(
  targets: readonly HTMLElement[],
  shell: HTMLElement | null,
  region: HTMLElement | null,
): TutorialRing[] {
  const [rings, setRings] = useState<TutorialRing[]>([]);
  useLayoutEffect(() => {
    if (!shell || targets.length === 0) {
      setRings([]);
      return;
    }
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const shellRect = shell.getBoundingClientRect();
        const regionRect = region?.getBoundingClientRect();
        setRings(
          targets.map((target, index) => {
            const inRegion = region !== null && region.contains(target);
            const originLeft =
              inRegion && regionRect
                ? regionRect.left - region.scrollLeft
                : shellRect.left;
            const originTop =
              inRegion && regionRect
                ? regionRect.top - region.scrollTop
                : shellRect.top;
            const inline = target instanceof HTMLAnchorElement;
            const rects = inline
              ? [...target.getClientRects()]
              : [target.getBoundingClientRect()];
            const radius = parseFloat(getComputedStyle(target).borderRadius);
            return {
              key: `${index}:${target.dataset.tutorialTarget ?? ""}`,
              host: inRegion ? "region" : "shell",
              inline,
              radius: (Number.isFinite(radius) ? radius : 4) + RING_GAP,
              boxes: (rects.length ? rects : [target.getBoundingClientRect()])
                // A wrapped link reports an empty rect at the break.
                .filter((rect, _, all) => all.length === 1 || rect.width > 0)
                .map((rect) => ({
                  left: rect.left - originLeft,
                  top: rect.top - originTop,
                  width: rect.width,
                  height: rect.height,
                })),
            };
          }),
        );
      });
    };
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    for (const target of targets) resizeObserver?.observe(target);
    // Content above a target can grow (an editor mounts, a composer opens)
    // without the target itself resizing, so watch the region's content too.
    if (region) {
      for (const child of region.querySelectorAll(
        ":scope > *, :scope > .review-document-view > *",
      )) {
        resizeObserver?.observe(child);
      }
    }
    window.addEventListener("resize", measure);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [region, shell, targets]);
  return rings;
}

function TutorialTargetRing({ ring }: { ring: TutorialRing }): ReactElement {
  return (
    <>
      {ring.boxes.map((box, index) => (
        <div
          key={index}
          className={
            ring.inline
              ? "tutorial-target-ring tutorial-target-ring--inline"
              : "tutorial-target-ring"
          }
          style={
            ring.inline
              ? {
                  left: box.left - 4,
                  top: box.top - 1,
                  width: box.width + 8,
                  height: box.height + 2,
                }
              : {
                  left: box.left - RING_GAP,
                  top: box.top - RING_GAP,
                  width: box.width + RING_GAP * 2,
                  height: box.height + RING_GAP * 2,
                  borderRadius: ring.radius,
                }
          }
        />
      ))}
    </>
  );
}

/**
 * Marks the first rendered code line whose text matches, plus the gutter
 * row at the same offset so its comment control can show. Monaco keeps rows
 * in visual order by their `top` style, not by DOM order.
 */
function markTutorialLine(
  root: HTMLElement,
  editor: HTMLElement,
  matcher: RegExp,
): void {
  clearTutorialLine(root);
  const rows = [...editor.querySelectorAll<HTMLElement>(".view-line")].sort(
    (left, right) => parseFloat(left.style.top) - parseFloat(right.style.top),
  );
  const row = rows.find((candidate) =>
    matcher.test(candidate.textContent ?? ""),
  );
  if (!row) return;
  row.dataset.tutorialLine = "";
  for (const margin of editor.querySelectorAll<HTMLElement>(
    ".margin-view-overlays > div",
  )) {
    if (margin.style.top === row.style.top) margin.dataset.tutorialLine = "";
  }
}

function clearTutorialLine(root: HTMLElement): void {
  for (const marked of root.querySelectorAll<HTMLElement>(
    "[data-tutorial-line]",
  )) {
    delete marked.dataset.tutorialLine;
  }
}
