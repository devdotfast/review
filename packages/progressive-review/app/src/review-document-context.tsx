import { type ReactNode, createContext, useContext } from "react";

import type { ReadyReviewDocumentEntry } from "./review-document";

const ActiveReviewDocumentContext =
  createContext<ReadyReviewDocumentEntry | null>(null);

export function ActiveReviewDocumentProvider({
  document,
  children,
}: {
  document: ReadyReviewDocumentEntry;
  children: ReactNode;
}) {
  return (
    <ActiveReviewDocumentContext.Provider value={document}>
      {children}
    </ActiveReviewDocumentContext.Provider>
  );
}

export function useActiveReviewDocument(): ReadyReviewDocumentEntry {
  const document = useContext(ActiveReviewDocumentContext);
  if (!document) {
    throw new Error(
      "useActiveReviewDocument must be used within ActiveReviewDocumentProvider",
    );
  }
  return document;
}
