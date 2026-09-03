import type { ReviewDiffFileWire } from "@dev.fast/review-protocol";
import { parseReviewDiffFilesResponse } from "@dev.fast/review-protocol";
import {
  type ReactNode,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { useReviewSession } from "./host/review-session";
import { useReviewContainer } from "./review-root-context";

export type ReviewDiffFilesState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "loaded"; files: ReviewDiffFileWire[] };

const ReviewDiffFilesContext = createContext<ReviewDiffFilesState>({
  status: "loading",
});

interface ReviewDiffFilesSnapshot {
  documentKey: string;
  state: ReviewDiffFilesState;
}

const LOADING_REVIEW_DIFF_FILES_STATE: ReviewDiffFilesState = {
  status: "loading",
};

export function ReviewDiffFilesProvider({
  documentKey,
  children,
}: {
  documentKey: string;
  children: ReactNode;
}) {
  const session = useReviewSession();
  const reviewFetch = session.fetch;
  const diffView = session.bridge.diffView;
  const container = useReviewContainer();
  const [snapshot, setSnapshot] = useState<ReviewDiffFilesSnapshot>(() => ({
    documentKey,
    state: LOADING_REVIEW_DIFF_FILES_STATE,
  }));
  const state =
    snapshot.documentKey === documentKey
      ? snapshot.state
      : LOADING_REVIEW_DIFF_FILES_STATE;

  useEffect(() => {
    const controller = new AbortController();
    setSnapshot((current) =>
      current.documentKey === documentKey && current.state.status === "loading"
        ? current
        : {
            documentKey,
            state: LOADING_REVIEW_DIFF_FILES_STATE,
          },
    );
    recordDiffSummaryRequest(container);
    const request = diffView.files
      ? diffView.files().then((files) => [...files])
      : reviewFetch("/diff-files", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ includePatch: false }),
          signal: controller.signal,
        }).then(async (response) => {
          const result = parseReviewDiffFilesResponse(await response.json());
          if (!response.ok || !result.ok) {
            throw new Error(
              result.ok ? "Unable to load diff files." : result.error,
            );
          }
          return result.files;
        });
    request
      .then((files) => {
        if (controller.signal.aborted) return;
        setSnapshot({
          documentKey,
          state: { status: "loaded", files },
        });
        recordDiffSummaryReady(container);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setSnapshot({
          documentKey,
          state: {
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          },
        });
      });
    return () => controller.abort();
  }, [container, diffView, documentKey, reviewFetch]);

  const value = useMemo(() => state, [state]);
  return (
    <ReviewDiffFilesContext.Provider value={value}>
      {children}
    </ReviewDiffFilesContext.Provider>
  );
}

export function useReviewDiffFiles(): ReviewDiffFilesState {
  return useContext(ReviewDiffFilesContext);
}

function recordDiffSummaryRequest(container: HTMLElement | null): void {
  if (!container) return;
  const current = Number(container.dataset.reviewDiffSummaryRequestCount ?? 0);
  container.dataset.reviewDiffSummaryRequestCount = String(current + 1);
  container.dataset.reviewDiffSummaryStartedAfterMount = String(
    Boolean(container.querySelector(".review-app")),
  );
  container.dataset.reviewDiffSummaryIncludePatch = "false";
}

function recordDiffSummaryReady(container: HTMLElement | null): void {
  if (!container) return;
  const current = Number(container.dataset.reviewDiffSummaryReadyCount ?? 0);
  container.dataset.reviewDiffSummaryReadyCount = String(current + 1);
}
