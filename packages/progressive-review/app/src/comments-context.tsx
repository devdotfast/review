import type {
  ReviewCommentStoreBridge,
  ReviewCommentStoreSnapshot,
} from "@dev.fast/review-protocol";
import { useSyncExternalStore } from "react";

import { useReviewSession } from "./host/review-session";

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
  return [store, snapshot];
}
