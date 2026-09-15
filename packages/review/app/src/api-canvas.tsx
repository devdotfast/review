import type { ReviewCanvasContent } from "@dev.fast/review-protocol";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { ReviewApiClient } from "../../src/review-api/client";
import type { Snapshot } from "../../src/review-api/store";
import {
  ApiDocument,
  type ApiDocumentData,
  createDocumentLoader,
} from "./api-document";
import { App } from "./App";
import type { RenderedReviewDocument } from "./App";
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
  useEffect(() => setVersion(content.version), [content.version]);
  const [data, setData] = useState<ApiDocumentData>();
  const dataRef = useRef(data);
  dataRef.current = data;
  const [error, setError] = useState<string>();
  useEffect(() => {
    const abort = new AbortController();
    const loader = createDocumentLoader(client);
    setData(undefined);

    const show = async (snapshot: Snapshot) => {
      const next = await loader.load(snapshot);

      if (!abort.signal.aborted) {
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

      while (!abort.signal.aborted) {
        try {
          for await (const next of client.watch(content.reviewId, abort.signal))
            await show(next);

          if (!abort.signal.aborted) setError("Connection lost. Reconnecting…");
        } catch (cause) {
          if (!abort.signal.aborted)
            setError(
              `Connection lost. Reconnecting… ${cause instanceof Error ? cause.message : ""}`,
            );
        }

        if (!abort.signal.aborted)
          await new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(timer);
              abort.signal.removeEventListener("abort", done);
              resolve();
            };

            const timer = setTimeout(done, 1000);
            abort.signal.addEventListener("abort", done, { once: true });
          });
      }
    })();

    return () => {
      abort.abort();
      loader.dispose();
    };
  }, [client, content.reviewId, version]);

  const session = useMemo(() => {
    const bridge = {
      ...content.bridge,
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
    const fetch = session.fetch;
    // The old views consume these small view models. Their data came from the API.
    session.fetch = async (route, init, options) => {
      const snapshot = dataRef.current?.snapshot;

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
  }, [client, content.bridge, content.reviewId, version]);

  useEffect(() => {
    if (data) content.bridge.ready();
  }, [Boolean(data), content.bridge]);

  if (!data) return <p role="status">{error ?? "Loading review…"}</p>;
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
    <ReviewSessionProvider session={session}>
      <DocumentData.Provider value={data}>
        <TutorialProvider>
          {error && <p role="status">{error}</p>}
          {version !== undefined && (
            <button onClick={() => setVersion(undefined)}>
              Back to latest version
            </button>
          )}
          <App
            documentState={{ state: "ready", document }}
            softwareMapState={{ state: "absent" }}
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
        </TutorialProvider>
      </DocumentData.Provider>
    </ReviewSessionProvider>
  );
}
