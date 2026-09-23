import {
  type ReactNode,
  type RefObject,
  createContext,
  useContext,
} from "react";

export interface WhiteboardRoots {
  appRef: RefObject<HTMLDivElement | null>;
  shellRef: RefObject<HTMLElement | null>;
  scrollRegionRef: RefObject<HTMLElement | null>;
  articleRef: RefObject<HTMLElement | null>;
}

const WhiteboardRootsContext = createContext<WhiteboardRoots | null>(null);

const WhiteboardContainerContext = createContext<HTMLElement | null>(null);

export function WhiteboardRootsProvider({
  roots,
  children,
}: {
  roots: WhiteboardRoots;
  children: ReactNode;
}) {
  return (
    <WhiteboardRootsContext.Provider value={roots}>
      {children}
    </WhiteboardRootsContext.Provider>
  );
}

export function useWhiteboardRoots(): WhiteboardRoots | null {
  return useContext(WhiteboardRootsContext);
}

export function WhiteboardContainerProvider({
  container,
  children,
}: {
  container: HTMLElement;
  children: ReactNode;
}) {
  return (
    <WhiteboardContainerContext.Provider value={container}>
      {children}
    </WhiteboardContainerContext.Provider>
  );
}

export function useWhiteboardContainer(): HTMLElement | null {
  return useContext(WhiteboardContainerContext);
}
