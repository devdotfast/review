import type {
  ReviewCommentDraftThreadMap,
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

const LiveCommentThreadsContext = createContext<{
  threads: ReadonlyMap<string, ReviewCommentThreadRecord>;
  drafts: ReviewCommentDraftThreadMap;
} | null>(null);

export function LiveCommentThreadsProvider({
  threads,
  drafts,
  children,
}: {
  threads: ReadonlyMap<string, ReviewCommentThreadRecord>;
  drafts: ReviewCommentDraftThreadMap;
  children: ReactNode;
}) {
  return (
    <LiveCommentThreadsContext.Provider value={{ threads, drafts }}>
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
  const liveState = useContext(LiveCommentThreadsContext);
  const liveSnapshot = useMemo(() => {
    if (!liveState) return snapshot;
    const localComments = new Map(
      [...snapshot.localComments].filter(
        ([, comment]) => comment.clientStatus === "submitting",
      ),
    );
    for (const [threadId, draft] of Object.entries(liveState.drafts)) {
      localComments.set(threadId, { clientStatus: "draft", ...draft });
    }
    return {
      ...snapshot,
      commentThreads: liveState.threads,
      localComments,
      pendingCommentCount: [...localComments.values()].filter(
        ({ clientStatus }) => clientStatus === "draft",
      ).length,
    };
  }, [liveState, snapshot]);
  return [store, liveSnapshot];
}
