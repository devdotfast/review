import {
  type JsonValue,
  ReviewDocumentVersionSchema,
  type ReviewDocumentVersionWire,
  isJsonObject,
  jsonObject,
  jsonString,
  parseZod,
} from "@dev.fast/review-protocol";
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { useReviewSession } from "./host/review-session";
import { reviewAppTelemetryHeaders } from "./ui-telemetry";

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
  listVersions: () => Promise<ReviewDocumentVersionWire[] | null>;
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

  const [softwareMapFocusRequest, setSoftwareMapFocusRequest] =
    useState<SoftwareMapFocusRequest | null>(null);

  // Set once the review has been dismissed or reached a terminal decision, so
  // the canvas can show that state instead of a live-looking document.
  const [submissionOutcome, setSubmissionOutcome] =
    useState<ReviewSubmissionOutcome | null>(null);

  const [historicalRevision, setHistoricalRevision] = useState<string | null>(
    null,
  );

  const [resolvedRefs, setResolvedRefs] = useState<{
    base: string | null;
    head: string | null;
  }>({ base: null, head: null });

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
    const response = await reviewFetch(
      "/dismiss",
      { method: "POST", headers: reviewAppTelemetryHeaders(session) },
      { routePath: documentRoute },
    );

    if (!response.ok) {
      throw new Error(`Review dismiss failed (${response.status}).`);
    }

    setSubmissionOutcome("dismissed");
  }, [documentRoute, reviewFetch, session]);

  const listVersions = useCallback(async () => {
    const response = await reviewFetch(
      "/revisions",
      {},
      { routePath: documentRoute },
    );

    if (!response.ok) return null;
    const body: JsonValue = await response.json();

    if (!isJsonObject(body) || body.ok !== true) return null;

    return parseZod(
      ReviewDocumentVersionSchema.array(),
      body.versions ?? [],
      "versions",
    );
  }, [documentRoute, reviewFetch]);

  // Session facts travel the data plane, not the build plane: a fetch always
  // reflects the running server. A review opened after a terminal decision
  // must show its outcome banner from the first render, not only in the
  // session where the decision happened, and the Map's topology banner names
  // the resolved base and head refs.
  useEffect(() => {
    let disposed = false;
    void reviewFetch("/session", {}, { routePath: documentRoute })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(
            `Review session request failed (${response.status}).`,
          );
        }

        const body: JsonValue = await response.json();

        const reviewSession = isJsonObject(body)
          ? jsonObject(body.session)
          : undefined;

        if (disposed) return;
        setHistoricalRevision(
          jsonString(reviewSession?.historicalRevision) ?? null,
        );
        setResolvedRefs({
          base: jsonString(reviewSession?.resolvedBaseRef) ?? null,
          head: jsonString(reviewSession?.headRef) ?? null,
        });
        const reviewStatus = jsonString(reviewSession?.reviewStatus);

        if (reviewStatus === "accepted") {
          setSubmissionOutcome("approved");
        } else if (reviewStatus === "awaiting-agent-updates") {
          setSubmissionOutcome("changes-requested");
        }
      })
      .catch((cause: unknown) => {
        console.error("Review session fetch failed", cause);
      });

    return () => {
      disposed = true;
    };
  }, [documentRoute, reviewFetch]);

  const actions = useMemo<ReviewActionsValue>(
    () => ({
      softwareMapEnabled,
      listVersions,
      dismissReview,
      openSoftwareMapElement,
      openTraceSession,
    }),
    [
      dismissReview,
      listVersions,
      openSoftwareMapElement,
      openTraceSession,
      softwareMapEnabled,
    ],
  );

  const state = useMemo<ReviewStateValue>(
    () => ({
      historicalRevision,
      resolvedBaseRef: resolvedRefs.base,
      resolvedHeadRef: resolvedRefs.head,
      softwareMapFocusRequest,
      submissionOutcome,
    }),
    [
      historicalRevision,
      resolvedRefs,
      softwareMapFocusRequest,
      submissionOutcome,
    ],
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
