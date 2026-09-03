import { createContext, useContext } from "react";

export type TutorialChapterState = "active" | "complete" | "upcoming";

export interface TutorialSectionContextValue {
  /** Chapter state keyed by the document section title. */
  chapterStates: ReadonlyMap<string, TutorialChapterState>;
}

const TutorialSectionContext =
  createContext<TutorialSectionContextValue | null>(null);

export const TutorialSectionProvider = TutorialSectionContext.Provider;

/**
 * The tutorial chapter state of a document section. Outside the tutorial (no
 * provider) every section gets null.
 */
export interface TutorialSection {
  state: TutorialChapterState | null;
}

export function useTutorialSection(title: string): TutorialSection {
  const value = useContext(TutorialSectionContext);
  return { state: value?.chapterStates.get(title) ?? null };
}
