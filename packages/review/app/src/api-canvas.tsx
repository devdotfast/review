import {
  type ReviewCanvasContent,
  parseReviewStackResponse,
} from "@dev.fast/review-protocol";
import {
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { ActivitySnapshot } from "../../src/review-api/activity";
import { ReviewApiClient, ReviewApiError } from "../../src/review-api/client";
import type { Snapshot } from "../../src/review-api/store";
import {
  ApiDocument,
  type ApiDocumentData,
  RevealAfterFirstPaint,
  createDocumentLoader,
} from "./api-document";
import { retainedTrace } from "./api-trace";
import { App } from "./App";
import type { RenderedReviewDocument } from "./App";
import { AuthoringActivityContext } from "./authoring-activity";
import {
  ReviewSessionProvider,
  createReviewSession,
  useReviewSession,
} from "./host/review-session";
import { ProjectPreparation } from "./project-preparation";
import { ReviewDocumentBoundary } from "./review-document-boundary";
import { reportReviewDocumentRenderError } from "./review-document-error-report";
import type { ReviewFindHost } from "./review-find";
import { DisplayedReviewVersionContext } from "./review-history-control";
import { TutorialProvider } from "./tutorial-context";

type ApiContent = Extract<ReviewCanvasContent, { kind: "api" }>;

const DocumentData = createContext<ApiDocumentData | null>(null);

const MapEnabled = createContext(false);

// A stable component type keeps sections, diagram tours and selections mounted.
function DocumentBody() {
  const data = useContext(DocumentData)!;
  const session = useReviewSession();
  const softwareMapEnabled = useContext(MapEnabled);

  // App keys its boundary on the review id; this one recovers on the next version.
  return (
    <ReviewDocumentBoundary
      session={session}
      revision={`${data.snapshot.reviewId}:${data.snapshot.version}`}
      onError={(_revision, error) =>
        reportReviewDocumentRenderError(session, error)
      }
    >
      <ApiDocument data={data} softwareMapEnabled={softwareMapEnabled} />
    </ReviewDocumentBoundary>
  );
}

const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

export function ApiCanvas({
  content,
  findHost,
}: {
  content: ApiContent;
  findHost?: ReviewFindHost;
}) {
  const client = useMemo(
    () => new ReviewApiClient(content.bridge.config, content.bridge.request),
    [content.bridge],
  );

  const [version, setVersion] = useState(content.version);
  const [activity, setActivity] = useState<ActivitySnapshot | "unknown">();
  useEffect(() => setVersion(content.version), [content.version]);
  const [data, setData] = useState<ApiDocumentData>();
  const dataRef = useRef(data);
  dataRef.current = data;
  const sourceRef = useRef<{ key: string; version: number }>(undefined);
  const sourceVersion = sourceRef.current?.version;
  const [error, setError] = useState<string>();
  useEffect(() => {
    const abort = new AbortController();
    const loader = createDocumentLoader(client);
    setData(undefined);
    setActivity(undefined);

    const show = async (snapshot: Snapshot) => {
      const next = await loader.load(snapshot);

      if (abort.signal.aborted) return;
      // Native source widgets must use these pins on their first mount.
      const key = JSON.stringify([snapshot.reviewId, snapshot.pins]);

      if (sourceRef.current?.key !== key)
        sourceRef.current = { key, version: snapshot.version };
      content.setVersion?.(sourceRef.current.version);
      setData(next);
      setError(undefined);
      content.setTitle?.(snapshot.title);
    };

    void (async () => {
      if (version !== undefined) {
        try {
          await show(
            await client.read(
              `/${content.reviewId}?full=true&version=${version}`,
              abort.signal,
            ),
          );
        } catch (cause) {
          if (!abort.signal.aborted) setError(message(cause));
        }

        return;
      }

      let shownVersion: number | undefined;
      await client.follow<Snapshot & { activity: ActivitySnapshot }>(
        content.reviewId,
        abort.signal,
        async (snapshot) => {
          setActivity(snapshot.activity);

          if (shownVersion === snapshot.version) {
            setError(undefined);

            return;
          }

          try {
            await show(snapshot);
            shownVersion = snapshot.version;
          } catch (cause) {
            // A failed resource or source fetch is a document problem. The
            // stream and the activity signal are still healthy, so do not
            // reconnect or report unknown activity.
            if (!abort.signal.aborted) setError(String(cause));
          }
        },
        (cause) => {
          setActivity("unknown");

          if (
            cause instanceof ReviewApiError &&
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
  }, [client, content.reviewId, version]);

  const nativeSources = useMemo(
    () => ({
      inlineEditors: { ...content.bridge.inlineEditors },
      diffView: { ...content.bridge.diffView },
    }),
    [content.bridge, sourceVersion],
  );

  const baseSession = useMemo(() => {
    const bridge = {
      ...content.bridge,
      ...nativeSources,
      post: async (request: Parameters<ApiContent["bridge"]["post"]>[0]) => {
        if (request.name === "openReviewRevision") {
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

    const session = createReviewSession(bridge, {
      jsonReview: {
        id: content.reviewId,
        version: () => dataRef.current?.snapshot.version,
      },
    });

    session.softwareMapData = (model) =>
      [...(dataRef.current?.maps.values() ?? [])].find((map) => map === model)
        ?.pinnedData;

    return session;
  }, [content.bridge, content.reviewId, nativeSources]);

  const session = useMemo(() => {
    if (!data) return baseSession;
    const snapshot = data.snapshot;

    return {
      ...baseSession,
      review: {
        pins: { base: snapshot.pins.base, head: snapshot.pins.head },
        historicalRevision: version === undefined ? null : String(version),
        updatedAtMs: Date.parse(snapshot.createdAt),
        pullRequestNumber: snapshot.origin?.pullRequestNumber,
        pullRequestUrl: snapshot.origin?.pullRequestUrl,
        traces: new Map(
          [...data.traces].map(([id, trace]) => [id, retainedTrace(id, trace)]),
        ),
        listVersions: async () => {
          const history = await client.read<
            { version: number; createdAt: string }[]
          >(`/${content.reviewId}/history`);

          return history.map((item) => ({
            revision: String(item.version),
            sealedAt: Date.parse(item.createdAt),
            isCurrent: item.version === snapshot.version,
          }));
        },
        stack: async (signal: AbortSignal) =>
          parseReviewStackResponse(
            await client.read(
              `/${snapshot.reviewId}/stack?version=${snapshot.version}`,
              signal,
            ),
          ).layers,
        dismiss: async () => {
          await client.post("/commands", {
            commandId: crypto.randomUUID(),
            operation: {
              type: "attention",
              reviewId: content.reviewId,
              action: "dismiss",
            },
          });
        },
      },
    };
  }, [baseSession, client, content.reviewId, data, version]);

  useEffect(() => {
    if (data) content.bridge.ready();
  }, [Boolean(data), content.bridge]);

  useEffect(() => {
    if (data) content.setTutorial?.(data.snapshot.origin?.tutorial === true);
  }, [data?.snapshot.origin?.tutorial, content.setTutorial]);

  if (!data)
    return (
      <>
        <p role="status">{error ?? "Loading review…"}</p>
        {version !== undefined && (
          <button onClick={() => setVersion(undefined)}>
            Back to latest version
          </button>
        )}
      </>
    );

  return (
    <ReviewSessionProvider session={session}>
      <DocumentData.Provider value={data}>
        <TutorialProvider tutorial={content.tutorial}>
          {error && <p role="status">{error}</p>}
          <AuthoringActivityContext.Provider
            value={version === undefined ? activity : undefined}
          >
            <DisplayedReviewVersionContext.Provider
              value={data.snapshot.version}
            >
              <ProjectPreparation
                client={client}
                reviewId={data.snapshot.reviewId}
              />
              <RevealAfterFirstPaint>
                <MapEnabled.Provider
                  value={content.softwareMapEnabled === true}
                >
                  <CanvasDocument
                    data={data}
                    findHost={findHost}
                    softwareMapEnabled={content.softwareMapEnabled === true}
                  />
                </MapEnabled.Provider>
              </RevealAfterFirstPaint>
            </DisplayedReviewVersionContext.Provider>
          </AuthoringActivityContext.Provider>
        </TutorialProvider>
      </DocumentData.Provider>
    </ReviewSessionProvider>
  );
}

// Activity updates only the badge; keep diagram inputs stable until document data changes.
const CanvasDocument = memo(function CanvasDocument({
  data,
  findHost,
  softwareMapEnabled,
}: {
  data: ApiDocumentData;
  findHost?: ReviewFindHost;
  softwareMapEnabled: boolean;
}) {
  const snapshot = data.snapshot;

  const document: RenderedReviewDocument = {
    key: snapshot.reviewId,
    routePath: "/",
    filePath: `review:${snapshot.reviewId}`,
    documentSoftwareModels: [...data.maps.values()],
    anchors: data.anchors,
    render: DocumentBody,
    tocEntries: data.headings.entries,
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
      range={{
        baseRef: snapshot.pins.base,
        headRef: snapshot.pins.head,
        baseCommit: snapshot.pins.base,
        headCommit: snapshot.pins.head,
      }}
      commits={data.commits}
      findHost={findHost}
    />
  );
});
