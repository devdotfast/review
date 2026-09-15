import type { ReactElement } from "react";

import type {
  TutorialFeatureProps,
  TutorialViewButtonProps,
} from "../../src/authoring";
import { useReviewActions } from "./review-context";
import { useTutorial } from "./tutorial-context";
import {
  tutorialFeatureVisible,
  tutorialViewVisible,
} from "./tutorial-render-visibility";

export function TutorialFeature({
  children,
}: TutorialFeatureProps): ReactElement | null {
  const tutorial = useTutorial();
  const { softwareMapEnabled } = useReviewActions();

  if (
    !tutorialFeatureVisible({ tutorial: tutorial !== null, softwareMapEnabled })
  )
    return null;

  return <>{children}</>;
}

export function TutorialViewButton({
  view,
  children,
}: TutorialViewButtonProps): ReactElement | null {
  const tutorial = useTutorial();
  const { softwareMapEnabled } = useReviewActions();

  if (
    !tutorialViewVisible(
      { tutorial: tutorial !== null, softwareMapEnabled },
      view,
    )
  )
    return null;

  return (
    <button
      type="button"
      className="tutorial-view-button"
      data-tutorial-view={view}
      onClick={() => openReviewView(view)}
    >
      {children}
      <span aria-hidden="true">→</span>
    </button>
  );
}

function openReviewView(view: TutorialViewButtonProps["view"]): void {
  const ariaLabel = view === "map" ? "Map (Experimental)" : viewLabel(view);
  document
    .querySelector<HTMLButtonElement>(
      `.review-segment[aria-label="${ariaLabel}"]`,
    )
    ?.click();
}

function viewLabel(view: TutorialViewButtonProps["view"]): string {
  return view.charAt(0).toUpperCase() + view.slice(1);
}
