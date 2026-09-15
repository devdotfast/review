import type {
  CreateReviewCommentInput,
  ReviewCanvasContent,
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
import { ReviewApiClient } from "../../src/review-api/client";
import type { Snapshot } from "../../src/review-api/store";
import { ApiComments } from "./api-comments";
import {
  ApiDocument,
  type ApiDocumentData,
  createDocumentLoader,
  sourceAnchor,
} from "./api-document";
import { retainedTrace } from "./api-trace";
import { App } from "./App";
import type { RenderedReviewDocument } from "./App";
import { AuthoringActivityContext } from "./authoring-activity";
import {
  ReviewSessionProvider,
  createReviewSession,
} from "./host/review-session";
import type { ReviewFindHost } from "./review-find";
import { TutorialProvider } from "./tutorial-context";

type ApiContent = Extract<ReviewCanvasContent, { kind: "api" }>;

const DocumentData = createContext<ApiDocumentData | null>(null);

// A stable component type keeps sections, diagram tours and selections mounted.
function DocumentBody() {
  return <ApiDocument data={useContext(DocumentData)!} />;
}

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
  // Source models may keep an earlier document version with identical pins.
  // Prose edits must not rebuild native editors or detach their comments.
  const sourceRef = useRef<{ key: string; version: number }>(undefined);
  const sourceVersion = sourceRef.current?.version;
  const [error, setError] = useState<string>();
  const [commentError, setCommentError] = useState<string>();

  const comments = useMemo(
    () =>
      new ApiComments(
        client,
        content.reviewId,
        () => {
          if (!dataRef.current) throw new Error("Review is still loading.");

          return dataRef.current.snapshot.version;
        },
        setCommentError,
      ),
    [client, content.reviewId],
  );

  useEffect(() => {
    comments.start();

    return () => comments.dispose();
  }, [comments]);
  useEffect(() => {
    if (!data) return;
    void comments.refresh().catch((cause) => setCommentError(String(cause)));

    return content.bindFeedback?.({
      reviewId: content.reviewId,
      version: sourceVersion!,
      pins: data.snapshot.pins,
      comments,
    });
  }, [
    content.bindFeedback,
    content.reviewId,
    data?.snapshot.version,
    sourceVersion,
    comments,
  ]);
  useEffect(() => {
    const abort = new AbortController();
    const loader = createDocumentLoader(client);
    setData(undefined);
    setActivity(undefined);

    const show = async (snapshot: Snapshot) => {
      const next = await loader.load(snapshot);

      if (!abort.signal.aborted) {
        // Native source widgets must use these pins on their first mount.
        const key = JSON.stringify([snapshot.reviewId, snapshot.pins]);

        if (sourceRef.current?.key !== key)
          sourceRef.current = { key, version: snapshot.version };
        content.setVersion?.(sourceRef.current.version);
        setData(next);
        setError(undefined);
        content.setTitle?.(snapshot.title);
      }
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
          if (!abort.signal.aborted) setError(String(cause));
        }

        return;
      }

      let shownVersion: number | undefined;
      await client.follow<Snapshot & { activity: ActivitySnapshot }>(
        content.reviewId,
        abort.signal,
        "document",
        async (snapshot) => {
          setActivity(snapshot.activity);

          if (shownVersion !== snapshot.version) {
            await show(snapshot);
            shownVersion = snapshot.version;
          } else setError(undefined);
        },
        (cause) => {
          setActivity("unknown");
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
      comments,
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

    if (content.openSource)
      session.openOriginalCode = async (threadId) => {
        const { source, range } = await comments.originalSource(threadId);
        await content.openSource!(source, range);
      };

    session.softwareMapData = (model) =>
      [...(dataRef.current?.maps.values() ?? [])].find((map) => map === model)
        ?.pinnedData;
    session.resolveCodePeek = async ({ root, graph }) => {
      const snapshot = dataRef.current!.snapshot;

      const source = {
        file: root.file,
        fromLine: root.fromLine,
        toLine: root.toLine,
        side: graph,
      };

      const quote = await client.post<{ text: string }>(
        `/${content.reviewId}/source`,
        {
          version: snapshot.version,
          source,
        },
      );

      return sourceAnchor(JSON.stringify(source), source, root.file, quote.text)
        .peek.resolution!;
    };

    const fetch = session.fetch;
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

      if (route === "/submissions") {
        // SAFETY: the existing ReviewPanel creates this in-process submission envelope.
        const input = JSON.parse(String(init?.body)) as {
          submissionId: string;
          decision: "approve" | "request-changes";
          comments: CreateReviewCommentInput[];
        };

        await comments.submit(
          input.decision,
          input.submissionId,
          input.comments,
        );

        return Response.json({ ok: true });
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

      return fetch(route, init, options);
    };

    return session;
  }, [
    client,
    content.bridge,
    content.reviewId,
    content.openSource,
    version,
    comments,
    traceKey,
    nativeSources,
  ]);

  useEffect(() => {
    if (data) content.bridge.ready();
  }, [Boolean(data), content.bridge]);

  if (!data) return <p role="status">{error ?? "Loading review…"}</p>;

  return (
    <ReviewSessionProvider session={session}>
      <DocumentData.Provider value={data}>
        <TutorialProvider>
          {error && <p role="status">{error}</p>}
          {commentError && <p role="status">{commentError}</p>}
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
    anchorContents: new Map(
      [...data.anchors].map(([id, anchor]) => [id, anchor.title]),
    ),
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
