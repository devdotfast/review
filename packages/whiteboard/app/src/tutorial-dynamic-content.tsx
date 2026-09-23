import type { ReactElement, ReactNode } from "react";

import type { WhiteboardComponentProps } from "../../src/whiteboard-document-data";
import { useTutorial } from "./tutorial-context";
import {
  tutorialFeatureVisible,
  tutorialViewVisible,
} from "./tutorial-render-visibility";
import { useWhiteboardActions } from "./whiteboard-context";

type TutorialViewButtonProps =
  WhiteboardComponentProps<"TutorialViewButton"> & {
    children?: ReactNode;
  };

export function TutorialFeature({
  children,
}: WhiteboardComponentProps<"TutorialFeature"> & {
  children?: ReactNode;
}): ReactElement | null {
  const tutorial = useTutorial();
  const { softwareMapEnabled } = useWhiteboardActions();

  if (
    !tutorialFeatureVisible({ tutorial: tutorial !== null, softwareMapEnabled })
  )
    return null;

  return <>{children}</>;
}

export function TutorialViewButton({
  view,
  children,
}: WhiteboardComponentProps<"TutorialViewButton"> & {
  children?: ReactNode;
}): ReactElement | null {
  const tutorial = useTutorial();
  const { softwareMapEnabled } = useWhiteboardActions();

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
      onClick={() => openWhiteboardView(view)}
    >
      {children}
      <span aria-hidden="true">→</span>
    </button>
  );
}

function openWhiteboardView(view: TutorialViewButtonProps["view"]): void {
  const ariaLabel = view === "map" ? "Map (Experimental)" : viewLabel(view);
  document
    .querySelector<HTMLButtonElement>(
      `.whiteboard-segment[aria-label="${ariaLabel}"]`,
    )
    ?.click();
}

function viewLabel(view: TutorialViewButtonProps["view"]): string {
  return view.charAt(0).toUpperCase() + view.slice(1);
}
