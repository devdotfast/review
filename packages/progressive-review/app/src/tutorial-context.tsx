import type {
  ReviewCanvasTutorialBridge,
  TutorialStepId,
} from "@dev.fast/review-protocol";
import { type ReactNode, createContext, useCallback, useContext } from "react";

const TutorialContext = createContext<ReviewCanvasTutorialBridge | null>(null);

export function TutorialProvider({
  tutorial,
  children,
}: {
  tutorial?: ReviewCanvasTutorialBridge;
  children: ReactNode;
}) {
  return (
    <TutorialContext.Provider value={tutorial ?? null}>
      {children}
    </TutorialContext.Provider>
  );
}

export function useTutorial(): ReviewCanvasTutorialBridge | null {
  return useContext(TutorialContext);
}

export function useCompleteTutorialStep(
  step: TutorialStepId,
): (() => void) | undefined {
  const tutorial = useTutorial();
  const checked = tutorial?.content.progress.checked.includes(step) === true;
  const complete = useCallback(() => {
    if (!checked) tutorial?.setStep(step, true);
  }, [checked, step, tutorial]);
  return tutorial ? complete : undefined;
}
