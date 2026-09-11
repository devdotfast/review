import {
  type HostDocumentState,
  type HostQueryResults,
  type HostReviewVersionSummary,
  type HostReviewWithSnapshot,
  type ReviewCanvasContent,
  ReviewClient,
  type ReviewCommitSummary,
} from "@dev.fast/review-protocol";
import type { MDXComponents } from "mdx/types";
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { App, type PublishedSoftwareMap } from "./App";
import {
  type HostAuthoringActivity,
  HostAuthoringActivityContext,
} from "./host-authoring-activity";
import { useHostResources } from "./host-canvas-resources";
import {
  hostAnchorRef,
  hostMapModel,
  projectHostGraphTarget,
  resolveHostGraphTarget,
} from "./host-document-components";
import {
  HostDocumentRenderer,
  type HostDocumentRendererProps,
  hostDocumentHasTitle,
} from "./host-document-renderer";
import { HostReviewHome } from "./host-review-home";
import { createHostCommentStore } from "./host/host-comment-store";
import {
  type HostReviewViewState,
  createHostReviewSession,
  refreshHostReviewSession,
} from "./host/host-review-session";
import { ReviewSessionProvider } from "./host/review-session";
import { ReviewCanvasLoading } from "./review-canvas-loading";
import type { ReadyReviewDocumentEntry } from "./review-documents-runtime";
import type { ReviewFindHost } from "./review-find";
import { TutorialProvider } from "./tutorial-context";

type HostCanvasContent = Extract<ReviewCanvasContent, { kind: "host" }>;

/** Supplies API data to the existing Home and review UI, not a second UI. */
export function HostCanvas({
  content,
  findHost,
}: {
  content: HostCanvasContent;
  findHost?: ReviewFindHost;
}) {
  const [client, setClient] = useState<ReviewClient>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const abort = new AbortController();
    setClient(undefined);
    setError(undefined);
    void ReviewClient.connect(content.connection, abort.signal).then(
      (connected) => {
        if (!abort.signal.aborted) setClient(connected);
      },
      (cause) => {
        if (!abort.signal.aborted) setError(message(cause));
      },
    );
    return () => abort.abort();
  }, [content.connection.serverUrl, content.connection.token]);
  if (error) return <CanvasError message={error} />;
  if (!client) return <ReviewCanvasLoading page note="Connecting to Review…" />;
  return content.reviewId ? (
    <HostReviewCanvas
      key={content.reviewId}
      client={client}
      reviewId={content.reviewId}
      content={content}
      findHost={findHost}
    />
  ) : (
    <HostReviewHome client={client} content={content} />
  );
}

function HostReviewCanvas({
  client,
  reviewId,
  content,
  findHost,
}: {
  client: ReviewClient;
  reviewId: string;
  content: HostCanvasContent;
  findHost?: ReviewFindHost;
}) {
  const [observed, setObserved] = useState<
    HostReviewWithSnapshot & {
      document: HostDocumentState;
      requestedVersion: number | undefined;
    }
  >();
  const document = observed?.document;
  const review = observed?.review;
  const [history, setHistory] = useState<HostReviewVersionSummary[]>([]);
  const [selectedReviewVersion, setSelectedReviewVersion] = useState<
    number | null
  >(content.reviewVersion ?? null);
  const [activity, setActivity] = useState<HostAuthoringActivity>();
  const [error, setError] = useState<string>();
  const generation = useRef(0);
  const refreshHistory = useCallback(
    async (signal?: AbortSignal) => {
      const request = ++generation.current;
      const history = await client.query(
        "review.history",
        { reviewId, limit: 200 },
        signal,
      );
      const all = [...history.result.items];
      let cursor = history.result.nextCursor;
      while (cursor) {
        const page = await client.query(
          "review.history",
          { reviewId, cursor, limit: 200 },
          signal,
        );
        all.push(...page.result.items);
        cursor = page.result.nextCursor;
      }
      if (!signal?.aborted && request === generation.current) {
        setHistory(all);
      }
    },
    [client, reviewId],
  );
  useEffect(() => {
    if (observed) content.setTitle?.(observed.snapshot.title);
  }, [observed?.snapshot.title, content.setTitle]);
  useEffect(() => {
    if (!review?.deletedAt || !content.closeReview) return;
    content.showHome();
    void content
      .closeReview(reviewId)
      .catch((cause) => setError(message(cause)));
  }, [review?.deletedAt, reviewId, content.closeReview, content.showHome]);
  useEffect(() => {
    const abort = new AbortController();
    void refreshHistory(abort.signal).catch((cause) => {
      if (!abort.signal.aborted) setError(message(cause));
    });
    return () => abort.abort();
  }, [refreshHistory]);
  useEffect(() => {
    const abort = new AbortController();
    const requestedVersion = selectedReviewVersion ?? undefined;
    setObserved(undefined);
    setError(undefined);
    setActivity(undefined);
    void (async () => {
      const activityEnabled =
        requestedVersion === undefined &&
        (await client
          .query("capabilities", {}, abort.signal)
          .then(({ result }) => result.queries.includes("authoring.get"))
          .catch(() => false));
      if (abort.signal.aborted) return;
      return client.watchReview({
        reviewId,
        reviewVersion: requestedVersion,
        signal: abort.signal,
        onActivity: activityEnabled
          ? (next) => {
              if (!abort.signal.aborted) setActivity(next ?? "unknown");
            }
          : undefined,
        onReview: (next) => {
          if (abort.signal.aborted) return;
          setObserved({ ...next, requestedVersion });
          setError(undefined);
        },
        onEvent: (event) => {
          if (
            event.type === "review.committed" ||
            event.type === "review.resync_required"
          )
            void refreshHistory(abort.signal).catch((cause) => {
              if (!abort.signal.aborted) setError(message(cause));
            });
        },
        onError: (failure) => {
          if (!abort.signal.aborted) setError(failure.message);
        },
      });
    })().catch((cause) => {
      if (!abort.signal.aborted) setError(message(cause));
    });
    return () => abort.abort();
  }, [client, reviewId, selectedReviewVersion, refreshHistory]);
  // Selection changes render before the old watch's effect is cleaned up.
  // Never pair its document with a newly selected checkpoint/live mode.
  if (
    !document ||
    !review ||
    observed?.requestedVersion !== (selectedReviewVersion ?? undefined)
  )
    return error ? (
      <CanvasError message={error} />
    ) : (
      <ReviewCanvasLoading page note="Still loading this review…" />
    );
  return (
    <HostAuthoringActivityContext.Provider
      value={selectedReviewVersion !== null ? undefined : activity}
    >
      <ReviewView
        key={`${selectedReviewVersion ?? "live"}:${document.binding.id}`}
        client={client}
        content={content}
        state={{
          document,
          review,
          snapshot: observed.snapshot,
          history,
          selectedReviewVersion,
        }}
        findHost={findHost}
        openRevision={setSelectedReviewVersion}
        error={error}
      />
    </HostAuthoringActivityContext.Provider>
  );
}

const DocumentBodyContext = createContext<
  (HostDocumentRendererProps & { title: string }) | null
>(null);
// Stable identity preserves the original document boundary, panels and selection during live updates.
function JsonDocumentBody({ components }: { components?: MDXComponents }) {
  const body = useContext(DocumentBodyContext);
  if (!body) throw new Error("The review document is not loaded.");
  const hasTitle = hostDocumentHasTitle(body.document);
  return (
    <>
      {!hasTitle && createElement(components?.h1 ?? "h1", null, body.title)}
      <HostDocumentRenderer {...body} components={components} />
    </>
  );
}

function ReviewView({
  client,
  content,
  state,
  findHost,
  openRevision,
  error,
}: {
  client: ReviewClient;
  content: HostCanvasContent;
  state: HostReviewViewState;
  findHost?: ReviewFindHost;
  openRevision(id: number | null): void;
  error?: string;
}) {
  const { document, review, snapshot, selectedReviewVersion } = state;
  const latest = useRef(state);
  latest.current = state;
  const [viewError, setViewError] = useState<string>();
  const appSessionId = useRef(crypto.randomUUID());
  const [commits, setCommits] = useState<ReviewCommitSummary[]>([]);
  const [softwareMap, setSoftwareMap] = useState<PublishedSoftwareMap | null>(
    null,
  );
  const canvas = useRef<HTMLDivElement>(null);
  const {
    resources,
    errors: resourceErrors,
    retry,
  } = useHostResources(client, document, content.wasmUrl);
  const availableMapVersions = Object.keys(resources.maps ?? {})
    .sort()
    .join(",");
  const resourcesRef = useRef(resources);
  resourcesRef.current = resources;
  const comments = useMemo(
    () =>
      createHostCommentStore({
        client,
        reviewId: review.id,
        getDocument: () => latest.current.document,
        onError: (failure) => setViewError(failure.message),
        resolveGraphTarget: (target, doc) =>
          resolveHostGraphTarget(target, doc, resourcesRef.current),
        projectGraphTarget: (target, doc) =>
          projectHostGraphTarget(target, doc, resourcesRef.current),
      }),
    [client, review.id],
  );
  const sessionCore = useMemo(
    () =>
      createHostReviewSession({
        appSessionId: appSessionId.current,
        client,
        content,
        comments,
        getState: () => latest.current,
        openRevision,
      }),
    [client, content, comments, openRevision],
  );
  const session = useMemo(
    () => refreshHostReviewSession(sessionCore),
    [sessionCore, review.state, document.createdAt],
  );
  useEffect(() => () => sessionCore.dispose(), [sessionCore]);
  content.source?.setDocumentVersion?.(document.reviewVersion);
  useEffect(() => {
    void comments.start().catch((cause) => setViewError(message(cause)));
    return () => comments.dispose();
  }, [comments]);
  useEffect(() => {
    void comments.refresh().catch((cause) => setViewError(message(cause)));
  }, [comments, document.reviewVersion, availableMapVersions]);
  useEffect(() => {
    session.signalReady();
  }, [session]);
  useEffect(() => {
    const abort = new AbortController();
    setSoftwareMap(null);
    const versions = snapshot.mapVersions;
    if (versions?.base && versions.head) {
      void Promise.all([
        client.query(
          "map.get",
          { reviewId: review.id, mapVersionId: versions.base },
          abort.signal,
        ),
        client.query(
          "map.get",
          { reviewId: review.id, mapVersionId: versions.head },
          abort.signal,
        ),
      ])
        .then(([base, head]) => {
          const mapNode = Object.values(latest.current.document.nodes).find(
            (node) =>
              node.type === "software_map" &&
              node.mapVersionId === head.result.id,
          );
          if (!abort.signal.aborted)
            setSoftwareMap({
              base: hostMapModel(base.result, mapNode?.id),
              head: hostMapModel(head.result, mapNode?.id),
            });
        })
        .catch((cause) => {
          if (!abort.signal.aborted) setViewError(message(cause));
        });
    }
    return () => abort.abort();
  }, [client, review.id, snapshot.mapVersions.base, snapshot.mapVersions.head]);
  useEffect(() => {
    const abort = new AbortController();
    void loadCommitSummaries(client, document, abort.signal)
      .then((items) => {
        if (!abort.signal.aborted) setCommits(items);
      })
      .catch((cause) => {
        if (!abort.signal.aborted) setViewError(message(cause));
      });
    return () => abort.abort();
  }, [client, review.id, document.binding.id]);
  const entry = useMemo<ReadyReviewDocumentEntry>(
    () => ({
      slug: review.id,
      routePath: `/reviews/${review.id}`,
      filePath: `review:${review.id}:${selectedReviewVersion ?? "live"}`,
      title: snapshot.title,
      documentSoftwareModels: Object.values(resources.maps ?? {}).map((map) =>
        hostMapModel(
          map,
          Object.values(document.nodes).find(
            (node) =>
              node.type === "software_map" && node.mapVersionId === map.id,
          )?.id,
        ),
      ),
      anchors: new Map(
        Object.entries(document.definitions)
          .filter(([, def]) => def.kind === "anchor")
          .map(([id]) => [id, hostAnchorRef(document, id)]),
      ),
      anchorContents: new Map(
        Object.entries(document.evidence).map(([id, quote]) => [
          id,
          quote.text,
        ]),
      ),
      Component: JsonDocumentBody,
      isDefault: true,
    }),
    [document, snapshot.title, selectedReviewVersion, resources.maps],
  );
  const reportError = useCallback((nodeId: string, failure: Error) => {
    console.error(`Review component ${nodeId} failed`, failure);
  }, []);
  const body = useMemo(
    () => ({
      document,
      resources,
      source: content.source,
      onError: reportError,
      title: entry.title,
    }),
    [document, resources, content.source, reportError, entry.title],
  );
  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      const { result } = await client.query(
        "attention.get",
        { reviewId: review.id },
        abort.signal,
      );
      await client.command(
        "attention.update",
        {
          reviewId: review.id,
          expectedAttentionVersion: result.attentionVersion,
          lastViewedReviewVersion: document.reviewVersion,
        },
        { signal: abort.signal },
      );
    })().catch((cause) => {
      if (!abort.signal.aborted) setViewError(message(cause));
    });
    return () => abort.abort();
  }, [client, review.id, document.reviewVersion]);
  return (
    <ReviewSessionProvider session={session}>
      <div className="review-session-content" ref={canvas}>
        {(error || viewError) && <p role="alert">{error ?? viewError}</p>}
        {resourceErrors.size > 0 && (
          <p role="alert">
            Some retained resources could not be loaded.{" "}
            <button type="button" onClick={retry}>
              Retry resources
            </button>
          </p>
        )}
        <TutorialProvider>
          <DocumentBodyContext.Provider value={body}>
            <App
              document={entry}
              softwareMap={softwareMap}
              softwareMapEnabled={content.softwareMapEnabled ?? true}
              range={{
                baseRef: document.binding.baseCommit,
                headRef: document.binding.headCommit,
                baseCommit: document.binding.baseCommit,
                headCommit: document.binding.headCommit,
              }}
              commits={commits}
              findHost={findHost}
            />
          </DocumentBodyContext.Provider>
        </TutorialProvider>
      </div>
    </ReviewSessionProvider>
  );
}

async function loadCommitSummaries(
  client: ReviewClient,
  document: HostDocumentState,
  signal: AbortSignal,
): Promise<ReviewCommitSummary[]> {
  const source = {
    reviewId: document.reviewId,
    reviewVersion: document.reviewVersion,
  };
  const commits = [];
  let cursor: string | undefined;
  do {
    const page = await client.query(
      "source.commits",
      { ...source, cursor, limit: 200 },
      signal,
    );
    commits.push(...page.result.items);
    cursor = page.result.nextCursor ?? undefined;
  } while (cursor);
  const summaries: ReviewCommitSummary[] = [];
  for (const commit of commits) {
    let fileCount = 0,
      additions = 0,
      deletions = 0;
    cursor = undefined;
    do {
      const page: { result: HostQueryResults["source.diff"] } =
        await client.query(
          "source.diff",
          { ...source, comparisonCommit: commit.oid, cursor, limit: 200 },
          signal,
        );
      for (const file of page.result.items) {
        fileCount++;
        additions += file.additions;
        deletions += file.deletions;
      }
      cursor = page.result.nextCursor ?? undefined;
    } while (cursor);
    summaries.push({
      commit: commit.oid,
      parentCommit:
        commit.parents[0] ?? "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      subject: commit.subject,
      author: commit.author,
      authoredAt: commit.at,
      fileCount,
      additions,
      deletions,
    });
  }
  return summaries;
}
function CanvasError({ message }: { message: string }) {
  return (
    <main className="review-canvas-shell">
      <h1>Review unavailable</h1>
      <p role="alert">{message}</p>
    </main>
  );
}
function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
