import type { WhiteboardDiffFileWire } from "@dev.fast/whiteboard-protocol";
import {
  type ReactNode,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { useWhiteboardSession } from "./host/whiteboard-session";
import { useWhiteboardContainer } from "./whiteboard-root-context";

export type WhiteboardDiffFilesState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "loaded"; files: WhiteboardDiffFileWire[] };

const WhiteboardDiffFilesContext = createContext<WhiteboardDiffFilesState>({
  status: "loading",
});

interface WhiteboardDiffFilesSnapshot {
  documentKey: string;
  state: WhiteboardDiffFilesState;
}

const LOADING_WHITEBOARD_DIFF_FILES_STATE: WhiteboardDiffFilesState = {
  status: "loading",
};

export function WhiteboardDiffFilesProvider({
  documentKey,
  children,
}: {
  documentKey: string;
  children: ReactNode;
}) {
  const session = useWhiteboardSession();
  const diffView = session.bridge.diffView;
  const container = useWhiteboardContainer();

  const [snapshot, setSnapshot] = useState<WhiteboardDiffFilesSnapshot>(() => ({
    documentKey,
    state: LOADING_WHITEBOARD_DIFF_FILES_STATE,
  }));

  const state =
    snapshot.documentKey === documentKey
      ? snapshot.state
      : LOADING_WHITEBOARD_DIFF_FILES_STATE;

  useEffect(() => {
    const controller = new AbortController();
    setSnapshot((current) =>
      current.documentKey === documentKey && current.state.status === "loading"
        ? current
        : {
            documentKey,
            state: LOADING_WHITEBOARD_DIFF_FILES_STATE,
          },
    );
    recordDiffSummaryRequest(container);

    const request = diffView.files().then((files) => [...files]);

    request
      .then((files) => {
        if (controller.signal.aborted) return;
        setSnapshot({
          documentKey,
          state: { status: "loaded", files },
        });
        recordDiffSummaryReady(container);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setSnapshot({
          documentKey,
          state: {
            status: "error",
            error: cause instanceof Error ? cause.message : String(cause),
          },
        });
      });

    return () => controller.abort();
  }, [container, diffView, documentKey]);

  const value = useMemo(() => state, [state]);

  return (
    <WhiteboardDiffFilesContext.Provider value={value}>
      {children}
    </WhiteboardDiffFilesContext.Provider>
  );
}

export function useWhiteboardDiffFiles(): WhiteboardDiffFilesState {
  return useContext(WhiteboardDiffFilesContext);
}

function recordDiffSummaryRequest(container: HTMLElement | null): void {
  if (!container) return;

  const current = Number(
    container.dataset.whiteboardDiffSummaryRequestCount ?? 0,
  );

  container.dataset.whiteboardDiffSummaryRequestCount = String(current + 1);
  container.dataset.whiteboardDiffSummaryStartedAfterMount = String(
    Boolean(container.querySelector(".whiteboard-app")),
  );
  container.dataset.whiteboardDiffSummaryIncludePatch = "false";
}

function recordDiffSummaryReady(container: HTMLElement | null): void {
  if (!container) return;

  const current = Number(
    container.dataset.whiteboardDiffSummaryReadyCount ?? 0,
  );

  container.dataset.whiteboardDiffSummaryReadyCount = String(current + 1);
}
