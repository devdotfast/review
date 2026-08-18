import {
  type ReactNode,
  type RefObject,
  createContext,
  useContext,
} from "react";

export interface ReviewRoots {
  appRef: RefObject<HTMLDivElement | null>;
  shellRef: RefObject<HTMLElement | null>;
  scrollRegionRef: RefObject<HTMLElement | null>;
  articleRef: RefObject<HTMLElement | null>;
}

const ReviewRootsContext = createContext<ReviewRoots | null>(null);
const ReviewContainerContext = createContext<HTMLElement | null>(null);

export function ReviewRootsProvider({
  roots,
  children,
}: {
  roots: ReviewRoots;
  children: ReactNode;
}) {
  return (
    <ReviewRootsContext.Provider value={roots}>
      {children}
    </ReviewRootsContext.Provider>
  );
}

export function useReviewRoots(): ReviewRoots | null {
  return useContext(ReviewRootsContext);
}

export function ReviewContainerProvider({
  container,
  children,
}: {
  container: HTMLElement;
  children: ReactNode;
}) {
  return (
    <ReviewContainerContext.Provider value={container}>
      {children}
    </ReviewContainerContext.Provider>
  );
}

export function useReviewContainer(): HTMLElement | null {
  return useContext(ReviewContainerContext);
}
