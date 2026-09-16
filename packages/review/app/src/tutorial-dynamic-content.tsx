import type { ReactElement, ReactNode } from "react";

import type { ReviewComponentProps } from "../../src/review-document-data";
import { useReviewActions } from "./review-context";
import { useTutorial } from "./tutorial-context";
import {
  tutorialFeatureVisible,
  tutorialViewVisible,
} from "./tutorial-render-visibility";

type TutorialViewButtonProps = ReviewComponentProps<"TutorialViewButton"> & {
  children?: ReactNode;
};

export function TutorialFeature({
  children,
}: ReviewComponentProps<"TutorialFeature"> & {
  children?: ReactNode;
}): ReactElement | null {
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
}: ReviewComponentProps<"TutorialViewButton"> & {
  children?: ReactNode;
}): ReactElement | null {
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
