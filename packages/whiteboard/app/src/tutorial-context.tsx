import type { WhiteboardCanvasTutorialBridge } from "@dev.fast/whiteboard-protocol";
import { type ReactNode, createContext, useContext } from "react";

const TutorialContext = createContext<WhiteboardCanvasTutorialBridge | null>(
  null,
);

export function TutorialProvider({
  tutorial,
  children,
}: {
  tutorial?: WhiteboardCanvasTutorialBridge;
  children: ReactNode;
}) {
  return (
    <TutorialContext.Provider value={tutorial ?? null}>
      {children}
    </TutorialContext.Provider>
  );
}

export function useTutorial(): WhiteboardCanvasTutorialBridge | null {
  return useContext(TutorialContext);
}
