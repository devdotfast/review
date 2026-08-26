import type { ReactElement } from "react";

import type {
  TutorialFeatureProps,
  TutorialViewButtonProps,
} from "../../src/authoring";
import { useReview } from "./review-context";
import { useTutorial } from "./tutorial-context";

export function TutorialFeature({
  feature,
  children,
}: TutorialFeatureProps): ReactElement | null {
  const tutorial = useTutorial();
  const review = useReview();
  if (!tutorial) return null;
  if (feature === "softwareMap" && !review.softwareMapEnabled) return null;
  return <>{children}</>;
}

export function TutorialViewButton({
  view,
  children,
}: TutorialViewButtonProps): ReactElement | null {
  const tutorial = useTutorial();
  const review = useReview();
  if (!tutorial) return null;
  if (view === "map" && !review.softwareMapEnabled) return null;
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
