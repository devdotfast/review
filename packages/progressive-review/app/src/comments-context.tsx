import type {
  ReviewCommentStoreBridge,
  ReviewCommentStoreSnapshot,
} from "@dev.fast/review-protocol";
import { useSyncExternalStore } from "react";

import { useReviewSession } from "./host/review-session";

export function useComments(): [
  ReviewCommentStoreBridge,
  ReviewCommentStoreSnapshot,
] {
  const store = useReviewSession().bridge.comments;
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  return [store, snapshot];
}
