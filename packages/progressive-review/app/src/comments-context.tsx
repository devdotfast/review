import type {
  ReviewCommentThreadRecord,
  ReviewCommentStoreBridge,
  ReviewCommentStoreSnapshot,
} from "@dev.fast/review-protocol";
import {
  type ReactNode,
  createContext,
  useContext,
  useMemo,
  useSyncExternalStore,
} from "react";

import { useReviewSession } from "./host/review-session";

const LiveCommentThreadsContext = createContext<ReadonlyMap<
  string,
  ReviewCommentThreadRecord
> | null>(null);

export function LiveCommentThreadsProvider({
  threads,
  children,
}: {
  threads: ReadonlyMap<string, ReviewCommentThreadRecord>;
  children: ReactNode;
}) {
  return (
    <LiveCommentThreadsContext.Provider value={threads}>
      {children}
    </LiveCommentThreadsContext.Provider>
  );
}

export function useCommentsStore(): ReviewCommentStoreBridge {
  return useReviewSession().bridge.comments;
}

export function useComments(): [
  ReviewCommentStoreBridge,
  ReviewCommentStoreSnapshot,
] {
  const store = useCommentsStore();
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const liveThreads = useContext(LiveCommentThreadsContext);
  const liveSnapshot = useMemo(
    () =>
      liveThreads ? { ...snapshot, commentThreads: liveThreads } : snapshot,
    [liveThreads, snapshot],
  );
  return [store, liveSnapshot];
}
