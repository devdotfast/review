import type { ReviewCanvasContent } from "@dev.fast/review-protocol";
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
import { ReviewDocumentBoundary } from "./review-document-boundary";
import { reportReviewDocumentRenderError } from "./review-document-error-report";
import type { ReviewFindHost } from "./review-find";
import { TutorialProvider } from "./tutorial-context";

type ApiContent = Extract<ReviewCanvasContent, { kind: "api" }>;

const DocumentData = createContext<ApiDocumentData | null>(null);

// A stable component type keeps sections, diagram tours and selections mounted.
function DocumentBody() {
  const data = useContext(DocumentData)!;
  const session = useReviewSession();

  // App keys its boundary on the review id; this one recovers on the next version.
  return (
    <ReviewDocumentBoundary
      session={session}
      revision={`${data.snapshot.reviewId}:${data.snapshot.version}`}
      onError={(_revision, error) =>
        reportReviewDocumentRenderError(session, error)
      }
    >
      <ApiDocument data={data} />
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

  const traceKey = JSON.stringify([...(data?.traces.keys() ?? [])]);

  const nativeSources = useMemo(
    () => ({
      inlineEditors: { ...content.bridge.inlineEditors },
      diffView: { ...content.bridge.diffView },
    }),
    [content.bridge, sourceVersion],
  );

  const session = useMemo(() => {
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

    const session = createReviewSession(bridge);
    session.keepsDismissedReviews = true;

    session.softwareMapData = (model) =>
      [...(dataRef.current?.maps.values() ?? [])].find((map) => map === model)
        ?.pinnedData;

    const apiFetch = session.fetch;
    // The old views consume these small view models. Their data came from the API.
    session.fetch = async (route, init, options) => {
      const snapshot = dataRef.current?.snapshot;

      if (route === "/dismiss") {
        await client.post("/commands", {
          commandId: crypto.randomUUID(),
          operation: {
            type: "attention",
            reviewId: content.reviewId,
            action: "dismiss",
          },
        });

        return Response.json({ ok: true });
      }

      if (route === "/agent-traces")
        return Response.json({
          ok: true,
          sessions: [...(dataRef.current?.traces ?? [])].map(
            ([id, trace]) => retainedTrace(id, trace).session,
          ),
        });

      if (route.startsWith("/agent-traces/")) {
        const id = decodeURIComponent(route.slice("/agent-traces/".length));
        const trace = dataRef.current?.traces.get(id);

        return trace
          ? Response.json(retainedTrace(id, trace))
          : Response.json(
              { ok: false, error: "Trace is not part of this review version." },
              { status: 404 },
            );
      }

      if (route === "/session" && snapshot)
        return Response.json({
          ok: true,
          session: {
            resolvedBaseRef: snapshot.pins.base,
            headRef: snapshot.pins.head,
            historicalRevision: version === undefined ? null : String(version),
          },
        });

      if (route === "/document-meta" && snapshot)
        return Response.json({
          ok: true,
          updatedAtMs: Date.parse(snapshot.createdAt),
        });

      if (route === "/revisions") {
        const history = await client.read<
          { version: number; createdAt: string }[]
        >(`/${content.reviewId}/history`, init?.signal ?? undefined);

        return Response.json({
          ok: true,
          versions: history.map((item) => ({
            revision: String(item.version),
            sealedAt: Date.parse(item.createdAt),
            isCurrent: item.version === snapshot?.version,
          })),
        });
      }

      return apiFetch(route, init, options);
    };

    return session;
  }, [
    client,
    content.bridge,
    content.reviewId,
    content.openSource,
    version,
    traceKey,
    nativeSources,
  ]);

  useEffect(() => {
    if (data) content.bridge.ready();
  }, [Boolean(data), content.bridge]);

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
        <TutorialProvider>
          {error && <p role="status">{error}</p>}
          <AuthoringActivityContext.Provider
            value={version === undefined ? activity : undefined}
          >
            <CanvasDocument data={data} findHost={findHost} />
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
}: {
  data: ApiDocumentData;
  findHost?: ReviewFindHost;
}) {
  const snapshot = data.snapshot;

  const document: RenderedReviewDocument = {
    key: snapshot.reviewId,
    routePath: "/",
    filePath: `review:${snapshot.reviewId}`,
    documentSoftwareModels: [...data.maps.values()],
    anchors: data.anchors,
    render: DocumentBody,
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
      softwareMapEnabled={data.maps.size > 0}
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
