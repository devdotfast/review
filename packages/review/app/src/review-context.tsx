import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

import { useReviewSession } from "./host/review-session";
import { captureUiEvent } from "./ui-telemetry";

export type ReviewSubmissionOutcome =
  | "approved"
  | "changes-requested"
  | "dismissed";

export interface SoftwareMapFocusRequest {
  requestId: number;
  elementPath: string;
}

export interface ReviewActionsValue {
  softwareMapEnabled: boolean;
  dismissReview: () => Promise<void>;
  openSoftwareMapElement: (elementPath: string) => void;
  openTraceSession?: (input: {
    sessionId: string;
    trace?: string;
    eventIndex?: number;
  }) => void;
}

export interface ReviewStateValue {
  historicalRevision: string | null;
  resolvedBaseRef: string | null;
  resolvedHeadRef: string | null;
  softwareMapFocusRequest: SoftwareMapFocusRequest | null;
  submissionOutcome: ReviewSubmissionOutcome | null;
}

export type ReviewContextValue = ReviewActionsValue & ReviewStateValue;

const ReviewActionsContext = createContext<ReviewActionsValue | null>(null);

const ReviewStateContext = createContext<ReviewStateValue | null>(null);

export function ReviewProvider({
  documentRoute,
  softwareMapEnabled = false,
  openTraceSession,
  children,
}: {
  documentRoute?: string;
  softwareMapEnabled?: boolean;
  openTraceSession?: (input: {
    sessionId: string;
    trace?: string;
    eventIndex?: number;
  }) => void;
  children: ReactNode;
}) {
  const session = useReviewSession();
  const reviewFetch = session.fetch;
  const review = session.review!;

  const [softwareMapFocusRequest, setSoftwareMapFocusRequest] =
    useState<SoftwareMapFocusRequest | null>(null);

  // Set once the review has been dismissed or reached a terminal decision, so
  // the canvas can show that state instead of a live-looking document.
  const [submissionOutcome, setSubmissionOutcome] =
    useState<ReviewSubmissionOutcome | null>(null);

  const openSoftwareMapElement = useCallback(
    (elementPath: string) => {
      if (!softwareMapEnabled) return;
      setSoftwareMapFocusRequest((current) => ({
        requestId: (current?.requestId ?? 0) + 1,
        elementPath,
      }));
    },
    [softwareMapEnabled],
  );

  const dismissReview = useCallback(async () => {
    await review.dismiss();
    captureUiEvent(session, "review_dismissed", { via: "review_topbar" });
    setSubmissionOutcome("dismissed");
  }, [review, session]);

  const actions = useMemo<ReviewActionsValue>(
    () => ({
      softwareMapEnabled,
      dismissReview,
      openSoftwareMapElement,
      openTraceSession,
    }),
    [
      dismissReview,
      openSoftwareMapElement,
      openTraceSession,
      softwareMapEnabled,
    ],
  );

  const state = useMemo<ReviewStateValue>(
    () => ({
      historicalRevision: review.historicalRevision,
      resolvedBaseRef: review.pins?.base ?? null,
      resolvedHeadRef: review.pins?.head ?? null,
      softwareMapFocusRequest,
      submissionOutcome,
    }),
    [review, softwareMapFocusRequest, submissionOutcome],
  );

  return (
    <ReviewActionsContext.Provider value={actions}>
      <ReviewStateContext.Provider value={state}>
        {children}
      </ReviewStateContext.Provider>
    </ReviewActionsContext.Provider>
  );
}

export function useReviewActions(): ReviewActionsValue {
  const value = useContext(ReviewActionsContext);

  if (!value)
    throw new Error("Review components must render inside ReviewProvider");

  return value;
}

export function useReviewState(): ReviewStateValue {
  const value = useContext(ReviewStateContext);

  if (!value)
    throw new Error("Review components must render inside ReviewProvider");

  return value;
}

/** Merged view for consumers that need both halves. Re-renders on state changes. */
export function useReview(): ReviewContextValue {
  const actions = useReviewActions();
  const state = useReviewState();

  return useMemo(() => ({ ...actions, ...state }), [actions, state]);
}
