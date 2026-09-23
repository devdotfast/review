import {
  type WhiteboardCanvasContent,
  parseWhiteboardStackResponse,
  resolveWhiteboardSourceView,
} from "@dev.fast/whiteboard-protocol";
import {
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { ActivitySnapshot } from "../../src/session-api/activity";
import {
  SessionApiClient,
  SessionApiError,
} from "../../src/session-api/client";
import type { Snapshot } from "../../src/session-api/store";
import {
  ApiDocument,
  type ApiDocumentData,
  createDocumentLoader,
} from "./api-document";
import { retainedTrace } from "./api-trace";
import { App } from "./App";
import type { RenderedWhiteboardDocument } from "./App";
import { AuthoringActivityContext } from "./authoring-activity";
import {
  type AuthoringCursor,
  type CursorMemory,
  nextCursor,
} from "./authoring-cursor";
import { DisplayedWhiteboardVersionContext } from "./displayed-whiteboard-version-context";
import { DrawQueueProvider } from "./draw-queue-provider";
import {
  WhiteboardSessionProvider,
  createWhiteboardSession,
  useWhiteboardSession,
} from "./host/whiteboard-session";
import { SharingContext } from "./share-control";
import { TutorialProvider } from "./tutorial-context";
import { WhiteboardDocumentBoundary } from "./whiteboard-document-boundary";
import { reportWhiteboardDocumentRenderError } from "./whiteboard-document-error-report";
import type { WhiteboardFindHost } from "./whiteboard-find";
import { WhiteboardLensesProvider } from "./whiteboard-lenses";

type ApiContent = Extract<WhiteboardCanvasContent, { kind: "api" }>;

const DocumentData = createContext<ApiDocumentData | null>(null);

const MapEnabled = createContext(false);

// A stable component type keeps sections, diagram tours and selections mounted.
function DocumentBody() {
  const data = useContext(DocumentData)!;
  const session = useWhiteboardSession();
  const softwareMapEnabled = useContext(MapEnabled);

  // App keys its boundary on the review id; this one recovers on the next version.
  return (
    <WhiteboardDocumentBoundary
      session={session}
      revision={`${data.snapshot.sessionId}:${data.snapshot.version}:${data.snapshot.pins?.worktreeRevision ?? ""}`}
      onError={(_revision, error) =>
        reportWhiteboardDocumentRenderError(session, error)
      }
    >
      <ApiDocument data={data} softwareMapEnabled={softwareMapEnabled} />
    </WhiteboardDocumentBoundary>
  );
}

const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

export function ApiCanvas({
  content,
  findHost,
}: {
  content: ApiContent;
  findHost?: WhiteboardFindHost;
}) {
  const client = useMemo(
    () =>
      new SessionApiClient(
        {
          ...content.bridge.config,
          apiPath: "/sessions-api",
        },
        content.bridge.request,
      ),
    [content.bridge],
  );

  const [version, setVersion] = useState(content.version);
  const [coverageRevision, setCoverageRevision] = useState(0);
  const [activity, setActivity] = useState<ActivitySnapshot | "unknown">();
  const [cursor, setCursor] = useState<AuthoringCursor | null>(null);
  const [lensCursor, setLensCursor] = useState<AuthoringCursor | null>(null);
  useEffect(() => setVersion(content.version), [content.version]);
  const [data, setData] = useState<ApiDocumentData>();
  const dataRef = useRef(data);
  dataRef.current = data;
  const sourceRef = useRef<{ key: string; version: number }>(undefined);
  const sourceVersion = sourceRef.current?.key;
  const [error, setError] = useState<string>();
  useEffect(() => {
    const abort = new AbortController();
    const loader = createDocumentLoader(client);
    setData(undefined);
    setActivity(undefined);
    setCursor(null);
    setLensCursor(null);
    // One stream, two couriers: each scope folds its own edits and focus.
    const cursorMemory: CursorMemory = {};
    const lensMemory: CursorMemory = {};

    const show = async (snapshot: Snapshot) => {
      const next = await loader.load(snapshot);

      if (abort.signal.aborted) return;

      // Native source widgets must use these pins on their first mount.
      const key = JSON.stringify([
        snapshot.sessionId,
        snapshot.pins,
        version === undefined ? "current" : version,
      ]);

      if (sourceRef.current?.key !== key)
        sourceRef.current = { key, version: snapshot.version };

      content.setSourceView?.(
        version === undefined
          ? { sessionId: snapshot.sessionId, kind: "current" }
          : { sessionId: snapshot.sessionId, kind: "version", version },
        resolveWhiteboardSourceView({
          ...snapshot,
          version: sourceRef.current.version,
        }),
      );
      setData(next);
      setError(undefined);
      content.setTitle?.(snapshot.title);
    };

    void (async () => {
      if (version !== undefined) {
        try {
          await show(
            await client.read(
              `/${content.sessionId}?full=true&version=${version}`,
              abort.signal,
            ),
          );
        } catch (cause) {
          if (!abort.signal.aborted) setError(message(cause));
        }
      }

      let shownVersion: string | undefined;
      await client.follow<
        Snapshot & { activity: ActivitySnapshot; coverageRevision?: number }
      >(
        content.sessionId,
        abort.signal,
        async (snapshot) => {
          setActivity(snapshot.activity);
          setCursor((current) => nextCursor(current, cursorMemory, snapshot));
          setLensCursor((current) =>
            nextCursor(current, lensMemory, snapshot, "lenses"),
          );
          setCoverageRevision(snapshot.coverageRevision ?? 0);

          if (version !== undefined) return;

          if (
            shownVersion ===
            `${snapshot.version}:${snapshot.pins?.worktreeRevision ?? ""}:${snapshot.sourceUnavailable ?? false}`
          ) {
            setError(undefined);

            return;
          }

          try {
            await show(snapshot);
            shownVersion = `${snapshot.version}:${snapshot.pins?.worktreeRevision ?? ""}:${snapshot.sourceUnavailable ?? false}`;
          } catch (cause) {
            // A failed resource or source fetch is a document problem. The
            // stream and the activity signal are still healthy, so do not
            // reconnect or report unknown activity.
            if (!abort.signal.aborted) setError(String(cause));
          }
        },
        (cause) => {
          setActivity("unknown");
          setCursor((current) =>
            current
              ? nextCursor(current, cursorMemory, {
                  version: cursorMemory.version ?? 0,
                  activity: "unknown",
                })
              : current,
          );

          setLensCursor((current) =>
            current
              ? nextCursor(
                  current,
                  lensMemory,
                  {
                    version: lensMemory.version ?? 0,
                    activity: "unknown",
                  },
                  "lenses",
                )
              : current,
          );

          if (
            cause instanceof SessionApiError &&
            [401, 403, 404].includes(cause.status)
          ) {
            setError(cause.message);

            return;
          }

          setError(
            `Connection lost. Reconnecting… ${cause instanceof Error ? cause.message : ""}`,
          );
        },
      );
    })();

    return () => {
      abort.abort();
      loader.dispose();
    };
  }, [client, content.sessionId, version]);

  const nativeSources = useMemo(
    () => ({
      inlineEditors: { ...content.bridge.inlineEditors },
      diffView: { ...content.bridge.diffView },
    }),
    [content.bridge, sourceVersion, content.structuralDiffEnabled],
  );

  const baseSession = useMemo(() => {
    const bridge = {
      ...content.bridge,
      ...nativeSources,
      post: async (request: Parameters<ApiContent["bridge"]["post"]>[0]) => {
        if (request.name === "openWhiteboardRevision") {
          setVersion(
            request.args.revision === undefined
              ? undefined
              : Number(request.args.revision),
          );

          return { ok: true as const };
        }

        return content.bridge.post(request);
      },
    };

    const session = createWhiteboardSession(bridge, {
      jsonWhiteboard: {
        id: content.sessionId,
        version: () => dataRef.current?.snapshot.version,
      },
    });

    session.softwareMapData = (model) =>
      [...(dataRef.current?.maps.values() ?? [])].find((map) => map === model)
        ?.pinnedData;

    return session;
  }, [content.bridge, content.sessionId, nativeSources]);

  const session = useMemo(() => {
    if (!data) return baseSession;
    const snapshot = data.snapshot;

    return {
      ...baseSession,
      review: {
        kind: snapshot.kind,
        pins: snapshot.pins
          ? { base: snapshot.pins.base, head: snapshot.pins.head }
          : undefined,
        historicalRevision: version === undefined ? null : String(version),
        updatedAtMs: Date.parse(snapshot.createdAt),
        headBranch: snapshot.origin?.branch,
        pullRequestNumber: snapshot.origin?.pullRequestNumber,
        pullRequestUrl: snapshot.origin?.pullRequestUrl,
        traces: new Map(
          [...data.traces].map(([id, trace]) => [id, retainedTrace(id, trace)]),
        ),
        listVersions: async () => {
          const history = await client.read<
            { version: number; createdAt: string }[]
          >(`/${content.sessionId}/history`);

          return history.map((item) => ({
            revision: String(item.version),
            sealedAt: Date.parse(item.createdAt),
            isCurrent: item.version === snapshot.version,
          }));
        },
        stack: async (signal: AbortSignal) =>
          parseWhiteboardStackResponse(
            await client.read(
              `/${snapshot.sessionId}/stack?version=${snapshot.version}`,
              signal,
            ),
          ).layers,
        dismiss: async () => {
          await client.post("/commands", {
            commandId: crypto.randomUUID(),
            operation: {
              type: "attention",
              sessionId: content.sessionId,
              action: "dismiss",
            },
          });
        },
      },
    };
  }, [baseSession, client, content.sessionId, data, version]);

  useEffect(() => {
    if (data) content.bridge.ready();
  }, [Boolean(data), content.bridge]);

  useEffect(() => {
    if (data) content.setTutorial?.(data.snapshot.origin?.tutorial === true);
  }, [data?.snapshot.origin?.tutorial, content.setTutorial]);

  const sharing = useMemo(
    () =>
      data
        ? {
            client,
            sessionId: content.sessionId,
            version: data.snapshot.version,
            sender: data.snapshot.shared?.login,
          }
        : null,
    [client, content.sessionId, data],
  );

  // Loads are near-instant, so stay blank until there is data or an error.
  if (!data)
    return (
      error !== undefined && (
        <>
          <p role="status">{error}</p>
          {version !== undefined && (
            <button onClick={() => setVersion(undefined)}>
              Back to latest version
            </button>
          )}
        </>
      )
    );

  return (
    <SharingContext.Provider value={sharing}>
      <WhiteboardSessionProvider session={session}>
        <DocumentData.Provider value={data}>
          <WhiteboardLensesProvider
            client={client}
            snapshot={data.snapshot}
            coverageRevision={coverageRevision}
            structuralDiffEnabled={content.structuralDiffEnabled}
          >
            <TutorialProvider tutorial={content.tutorial}>
              {error && <p role="status">{error}</p>}
              <AuthoringActivityContext.Provider
                value={version === undefined ? activity : undefined}
              >
                <DrawQueueProvider
                  cursor={version === undefined ? cursor : undefined}
                >
                  <DrawQueueProvider
                    scope="lenses"
                    cursor={version === undefined ? lensCursor : undefined}
                  >
                    <DisplayedWhiteboardVersionContext.Provider
                      value={data.snapshot.version}
                    >
                      <MapEnabled.Provider
                        value={content.softwareMapEnabled === true}
                      >
                        <CanvasDocument
                          data={data}
                          findHost={findHost}
                          softwareMapEnabled={
                            content.softwareMapEnabled === true
                          }
                        />
                      </MapEnabled.Provider>
                    </DisplayedWhiteboardVersionContext.Provider>
                  </DrawQueueProvider>
                </DrawQueueProvider>
              </AuthoringActivityContext.Provider>
            </TutorialProvider>
          </WhiteboardLensesProvider>
        </DocumentData.Provider>
      </WhiteboardSessionProvider>
    </SharingContext.Provider>
  );
}

// Activity updates only the badge; keep diagram inputs stable until document data changes.
const CanvasDocument = memo(function CanvasDocument({
  data,
  findHost,
  softwareMapEnabled,
}: {
  data: ApiDocumentData;
  findHost?: WhiteboardFindHost;
  softwareMapEnabled: boolean;
}) {
  const snapshot = data.snapshot;

  const document: RenderedWhiteboardDocument = {
    key: snapshot.sessionId,
    routePath: "/",
    filePath: `review:${snapshot.sessionId}`,
    documentSoftwareModels: [...data.maps.values()],
    anchors: data.anchors,
    render: DocumentBody,
    tocEntries: data.headings.entries,
    empty: snapshot.document.length === 0,
  };

  return (
    <App
      documentState={{ state: "ready", document }}
      softwareMapState={{
        state: "ready",
        softwareMap: {
          head:
            [...data.maps.values()].find(
              (map) => map.pinnedData.side === "head",
            ) ?? null,
          base:
            [...data.maps.values()].find(
              (map) => map.pinnedData.side === "base",
            ) ?? null,
        },
      }}
      softwareMapEnabled={softwareMapEnabled && data.maps.size > 0}
      // A document without pins of its own has no change range: the Diff and
      // Commits views hide, as for a review whose base is its head.
      range={{
        sourceUnavailable: snapshot.sourceUnavailable
          ? "Local checkout unavailable."
          : undefined,
        baseRef: snapshot.pins?.base ?? "",
        headRef: snapshot.pins?.head ?? "",
        baseCommit: snapshot.pins?.base ?? "",
        headCommit: snapshot.pins?.head ?? "",
      }}
      commits={data.commits}
      findHost={findHost}
    />
  );
});
