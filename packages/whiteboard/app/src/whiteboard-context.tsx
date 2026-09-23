import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

import { useWhiteboardSession } from "./host/whiteboard-session";

export type WhiteboardSubmissionOutcome =
  | "approved"
  | "changes-requested"
  | "dismissed";

export interface SoftwareMapFocusRequest {
  requestId: number;
  elementPath: string;
}

export interface WhiteboardActionsValue {
  softwareMapEnabled: boolean;
  dismissWhiteboard: () => Promise<void>;
  openSoftwareMapElement: (elementPath: string) => void;
  openTraceSession?: (input: {
    sessionId: string;
    trace?: string;
    eventIndex?: number;
  }) => void;
}

export interface WhiteboardStateValue {
  historicalRevision: string | null;
  resolvedBaseRef: string | null;
  resolvedHeadRef: string | null;
  softwareMapFocusRequest: SoftwareMapFocusRequest | null;
  submissionOutcome: WhiteboardSubmissionOutcome | null;
}

export type WhiteboardContextValue = WhiteboardActionsValue &
  WhiteboardStateValue;

const WhiteboardActionsContext = createContext<WhiteboardActionsValue | null>(
  null,
);

const WhiteboardStateContext = createContext<WhiteboardStateValue | null>(null);

export function WhiteboardProvider({
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
  const session = useWhiteboardSession();
  const whiteboardFetch = session.fetch;
  const review = session.review!;

  const [softwareMapFocusRequest, setSoftwareMapFocusRequest] =
    useState<SoftwareMapFocusRequest | null>(null);

  // Set once the review has been dismissed or reached a terminal decision, so
  // the canvas can show that state instead of a live-looking document.
  const [submissionOutcome, setSubmissionOutcome] =
    useState<WhiteboardSubmissionOutcome | null>(null);

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

  const dismissWhiteboard = useCallback(async () => {
    await review.dismiss();
    setSubmissionOutcome("dismissed");
  }, [review]);

  const actions = useMemo<WhiteboardActionsValue>(
    () => ({
      softwareMapEnabled,
      dismissWhiteboard,
      openSoftwareMapElement,
      openTraceSession,
    }),
    [
      dismissWhiteboard,
      openSoftwareMapElement,
      openTraceSession,
      softwareMapEnabled,
    ],
  );

  const state = useMemo<WhiteboardStateValue>(
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
    <WhiteboardActionsContext.Provider value={actions}>
      <WhiteboardStateContext.Provider value={state}>
        {children}
      </WhiteboardStateContext.Provider>
    </WhiteboardActionsContext.Provider>
  );
}

export function useWhiteboardActions(): WhiteboardActionsValue {
  const value = useContext(WhiteboardActionsContext);

  if (!value)
    throw new Error("Review components must render inside WhiteboardProvider");

  return value;
}

export function useWhiteboardState(): WhiteboardStateValue {
  const value = useContext(WhiteboardStateContext);

  if (!value)
    throw new Error("Review components must render inside WhiteboardProvider");

  return value;
}

/** Merged view for consumers that need both halves. Re-renders on state changes. */
export function useWhiteboard(): WhiteboardContextValue {
  const actions = useWhiteboardActions();
  const state = useWhiteboardState();

  return useMemo(() => ({ ...actions, ...state }), [actions, state]);
}
