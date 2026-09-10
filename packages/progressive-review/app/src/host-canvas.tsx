import {
  type HostCheckpoint,
  type HostDocumentState,
  type HostReview,
  type HostSourceQuote,
  type ReviewCanvasContent,
  ReviewClient,
} from "@dev.fast/review-protocol";
import { useCallback, useEffect, useRef, useState } from "react";

import { useHostResources } from "./host-canvas-resources";
import { HostDocumentRenderer } from "./host-document-renderer";
import { HostSourceBrowser } from "./host-source-browser";

import "./host-canvas.css";

type HostCanvasContent = Extract<ReviewCanvasContent, { kind: "host" }>;

/** The native shell supplies only a connection; every review read/write is API-owned. */
export function HostCanvas({ content }: { content: HostCanvasContent }) {
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
      (cause: unknown) => {
        if (!abort.signal.aborted) setError(message(cause));
      },
    );
    return () => abort.abort();
  }, [content.connection.serverUrl, content.connection.token]);
  if (error)
    return (
      <main className="host-canvas">
        <p role="alert">{error}</p>
      </main>
    );
  if (!client)
    return (
      <main className="host-canvas">
        <p role="status">Connecting to Review…</p>
      </main>
    );
  return content.reviewId ? (
    <HostReviewCanvas
      key={content.reviewId}
      client={client}
      reviewId={content.reviewId}
      content={content}
    />
  ) : (
    <HostReviewList client={client} content={content} />
  );
}

function HostReviewList({
  client,
  content,
}: {
  client: ReviewClient;
  content: HostCanvasContent;
}) {
  const [reviews, setReviews] = useState<HostReview[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    const abort = new AbortController();
    const refresh = async () => {
      const page = await client.query(
        "reviews.list",
        { limit: 200 },
        abort.signal,
      );
      const all = [...page.result.items];
      let cursor = page.result.nextCursor;
      while (cursor) {
        const next = await client.query(
          "reviews.list",
          { cursor, limit: 200 },
          abort.signal,
        );
        all.push(...next.result.items);
        cursor = next.result.nextCursor;
      }
      if (!abort.signal.aborted) {
        setReviews(all);
        setError(undefined);
      }
      return page.eventCursor;
    };
    void refresh()
      .then((after) =>
        client.subscribe({
          after,
          signal: abort.signal,
          onReset: refresh,
          onEvent: (event) =>
            event.type.startsWith("review.") ? refresh() : undefined,
          onError: (failure) => setError(failure.message),
        }),
      )
      .catch((cause: unknown) => {
        if (!abort.signal.aborted) setError(message(cause));
      });
    return () => abort.abort();
  }, [client]);
  return (
    <main className="host-canvas host-canvas-list">
      <header className="host-canvas-toolbar">
        <h1>Local reviews</h1>
        {content.openWelcome && (
          <button type="button" onClick={content.openWelcome}>
            Welcome
          </button>
        )}
        {content.openSettings && (
          <button type="button" onClick={content.openSettings}>
            Settings
          </button>
        )}
        {content.openTutorial && (
          <button type="button" onClick={content.openTutorial}>
            Tutorial
          </button>
        )}
      </header>
      <p>Reviews authored through the desktop API.</p>
      {error && <p role="alert">{error}</p>}
      {!reviews && <p role="status">Loading reviews…</p>}
      {reviews?.length === 0 && (
        <p>No reviews yet. Connect your agent to this desktop to create one.</p>
      )}
      <ul>
        {reviews?.map((review) => (
          <li key={review.id}>
            <button
              type="button"
              onClick={() => content.openReview(review.id, review.title)}
            >
              {review.title}
            </button>
            <span>
              {review.workflow.replaceAll("_", " ")} · version{" "}
              {review.documentVersion}
            </span>
          </li>
        ))}
      </ul>
    </main>
  );
}

function HostReviewCanvas({
  client,
  reviewId,
  content,
}: {
  client: ReviewClient;
  reviewId: string;
  content: HostCanvasContent;
}) {
  const [review, setReview] = useState<HostReview>();
  const [document, setDocument] = useState<HostDocumentState>();
  const [checkpoints, setCheckpoints] = useState<HostCheckpoint[]>([]);
  const [checkpointId, setCheckpointId] = useState("");
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [sourceId, setSourceId] = useState<string>();
  const [sourceBrowserOpen, setSourceBrowserOpen] = useState(false);
  const [failures, setFailures] = useState<{
    version: number;
    items: Record<string, string>;
  }>({ version: 0, items: {} });
  const canvasSessionId = useRef(crypto.randomUUID());
  const metadataGeneration = useRef(0);
  const canvas = useRef<HTMLDivElement>(null);
  const sourceDialog = useRef<HTMLDialogElement>(null);
  const checkpoint = checkpoints.find((item) => item.id === checkpointId);
  const published = checkpoints.find(
    (item) => item.id === review?.publishedCheckpointId,
  );
  const {
    resources,
    errors: resourceErrors,
    retry: retryResources,
  } = useHostResources(client, document, content.wasmUrl);

  const refreshMetadata = useCallback(
    async (signal?: AbortSignal) => {
      const generation = ++metadataGeneration.current;
      const [metadata, history] = await Promise.all([
        client.query("review.get", { reviewId }, signal),
        client.query("checkpoints.list", { reviewId, limit: 200 }, signal),
      ]);
      const all = [...history.result.items];
      let cursor = history.result.nextCursor;
      while (cursor) {
        const page = await client.query(
          "checkpoints.list",
          { reviewId, cursor, limit: 200 },
          signal,
        );
        all.push(...page.result.items);
        cursor = page.result.nextCursor;
      }
      if (!signal?.aborted && generation === metadataGeneration.current) {
        setReview(metadata.result.review);
        setCheckpoints(all);
      }
    },
    [client, reviewId],
  );

  useEffect(() => {
    if (review) content.setTitle?.(review.title);
  }, [review?.title, content.setTitle]);

  useEffect(() => {
    const abort = new AbortController();
    void refreshMetadata(abort.signal).catch((cause: unknown) => {
      if (!abort.signal.aborted) setError(message(cause));
    });
    return () => abort.abort();
  }, [refreshMetadata]);

  useEffect(() => {
    const abort = new AbortController();
    setDocument(undefined);
    setSourceId(undefined);
    setError(undefined);
    // A checkpoint identifies an immutable version; it never receives working
    // document events. Returning to Live obtains a fresh snapshot and cursor.
    void client
      .watchDocument({
        reviewId,
        version: checkpoint?.documentVersion,
        signal: abort.signal,
        onDocument: (next) => {
          setDocument(next);
          setError(undefined);
        },
        onEvent: (event) => {
          if (
            event.type.startsWith("review.") ||
            event.type === "checkpoint.created"
          )
            void refreshMetadata(abort.signal).catch((cause: unknown) => {
              if (!abort.signal.aborted) setError(message(cause));
            });
        },
        onError: (failure) => setError(failure.message),
      })
      .catch((cause: unknown) => {
        if (!abort.signal.aborted) setError(message(cause));
      });
    return () => abort.abort();
  }, [client, reviewId, checkpoint?.documentVersion, refreshMetadata]);

  const reportError = useCallback(
    (nodeId: string, failure: Error) => {
      if (!document) return;
      setFailures((prior) => {
        const items =
          prior.version === document.version ? { ...prior.items } : {};
        items[nodeId] = failure.message;
        return { version: document.version, items };
      });
    },
    [document?.version],
  );

  useEffect(() => {
    if (!document || checkpointId || resources.pending?.size) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      const items = failures.version === document.version ? failures.items : {};
      const visibleNodeIds = Array.from(
        canvas.current?.querySelectorAll<HTMLElement>("[data-node-id]") ?? [],
      )
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => element.dataset.nodeId!);
      void client
        .command(
          "canvas.report",
          {
            reviewId,
            canvasSessionId: canvasSessionId.current,
            documentVersion: document.version,
            status: Object.keys(items).length ? "failed" : "rendered",
            visibleNodeIds,
            failures: Object.entries(items).map(([nodeId, failure]) => ({
              nodeId,
              code: "RENDER_FAILED",
              message: failure,
            })),
          },
          { signal: abort.signal },
        )
        .catch((cause: unknown) => {
          if (!abort.signal.aborted) setError(message(cause));
        });
    }, 100);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [client, reviewId, document, failures, checkpointId, resources.pending]);

  useEffect(() => {
    if (sourceId) sourceDialog.current?.showModal();
    else sourceDialog.current?.close();
  }, [sourceId]);

  const publish = async () => {
    if (!review || !document) return;
    setPending(true);
    setError(undefined);
    try {
      await client.command("review.publish", {
        reviewId,
        expectedDocumentVersion: document.version,
        expectedReviewVersion: review.version,
        mapVersions: { base: null, head: null },
      });
      await refreshMetadata();
    } catch (failure) {
      setError(message(failure));
    } finally {
      setPending(false);
    }
  };
  const reopen = async () => {
    if (!review) return;
    setPending(true);
    setError(undefined);
    try {
      await client.command("review.reopen", {
        reviewId,
        expectedVersion: review.version,
      });
      await refreshMetadata();
    } catch (failure) {
      setError(message(failure));
    } finally {
      setPending(false);
    }
  };
  const source = sourceId ? document?.evidence[sourceId] : undefined;
  const openSource = (anchorId: string) => {
    const anchor = document?.definitions[anchorId];
    if (!content.source || !document || anchor?.kind !== "anchor") {
      setSourceId(anchorId);
      return;
    }
    void content.source
      .open({
        reviewId,
        documentVersion: document.version,
        range: anchor.source,
      })
      .catch((cause: unknown) => setError(message(cause)));
  };
  const openSourceRange =
    content.source && document
      ? (span: HostSourceQuote["span"]) => {
          const side =
            span.commit === document.binding.headCommit
              ? "head"
              : span.commit === document.binding.baseCommit
                ? "base"
                : null;
          if (!side || span.repositoryId !== document.binding.repositoryId) {
            setError(
              "This retained source is outside the displayed document's binding.",
            );
            return;
          }
          void content
            .source!.open({
              reviewId,
              documentVersion: document.version,
              range: {
                side,
                file: span.file,
                fromLine: span.fromLine,
                toLine: span.toLine,
              },
            })
            .catch((cause: unknown) => setError(message(cause)));
        }
      : undefined;
  return (
    <main className="host-canvas">
      <header className="host-canvas-toolbar">
        <div>
          <h1>{checkpoint?.title ?? review?.title ?? "Review"}</h1>
          <span>
            {checkpoint ? `Checkpoint ${checkpoint.ordinal}` : "Live"} · version{" "}
            {document?.version ?? "…"}
          </span>
          {!checkpoint && (
            <span className="host-canvas-publication" role="status">
              {published
                ? document?.version === published.documentVersion
                  ? `Published checkpoint ${published.ordinal}`
                  : `Changes since checkpoint ${published.ordinal}`
                : "Not published"}
            </span>
          )}
        </div>
        <label>
          Version{" "}
          <select
            aria-label="Review version"
            value={checkpointId}
            onChange={(event) => setCheckpointId(event.target.value)}
          >
            <option value="">Live document</option>
            {checkpoints.map((item) => (
              <option key={item.id} value={item.id}>
                Checkpoint {item.ordinal} · version {item.documentVersion}
              </option>
            ))}
          </select>
        </label>
        {review?.workflow === "closed" ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => void reopen()}
          >
            Reopen review
          </button>
        ) : (
          <button
            type="button"
            disabled={pending || !document || !!checkpointId}
            onClick={() => void publish()}
          >
            Publish checkpoint
          </button>
        )}
        <button
          type="button"
          aria-expanded={sourceBrowserOpen}
          onClick={() => setSourceBrowserOpen((value) => !value)}
        >
          Source
        </button>
        <button type="button" onClick={content.showHome}>
          Home
        </button>
      </header>
      {error && (
        <p role="alert" className="host-canvas-error">
          {error}
        </p>
      )}
      {!document && <p role="status">Loading review…</p>}
      {resourceErrors.size > 0 && (
        <p role="alert">
          Some retained resources could not be loaded.{" "}
          <button
            type="button"
            onClick={() => {
              setFailures({ version: document?.version ?? 0, items: {} });
              retryResources();
            }}
          >
            Retry resources
          </button>
        </p>
      )}
      {document && sourceBrowserOpen && (
        <HostSourceBrowser
          client={client}
          document={document}
          source={content.source}
        />
      )}
      <div ref={canvas}>
        {document && (
          <HostDocumentRenderer
            document={document}
            resources={resources}
            source={content.source}
            onSourceOpen={openSource}
            onSourceRangeOpen={openSourceRange}
            onError={reportError}
          />
        )}
      </div>
      <dialog
        ref={sourceDialog}
        className="host-canvas-source"
        onClose={() => setSourceId(undefined)}
      >
        <header>
          <h2>{source?.span.file ?? "Retained source"}</h2>
          <button type="button" onClick={() => setSourceId(undefined)}>
            Close
          </button>
        </header>
        {source ? (
          <>
            <p>
              Lines {source.span.fromLine}–{source.span.toLine} ·{" "}
              {source.span.commit.slice(0, 12)}
            </p>
            <pre>
              <code>{source.text}</code>
            </pre>
          </>
        ) : (
          <p>
            This document does not contain retained evidence for this reference.
          </p>
        )}
      </dialog>
    </main>
  );
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
