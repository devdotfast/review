import {
  type JsonValue,
  type ReviewDiffStats,
  type ReviewStackLayer,
  isJsonObject,
  jsonNumber,
  jsonString,
  parseReviewStackResponse,
  summarizeReviewDiffFiles,
} from "@dev.fast/review-protocol";
import {
  type MouseEvent,
  type ReactElement,
  useEffect,
  useRef,
  useState,
} from "react";

import { useReviewSession } from "./host/review-session";
import { useReviewDiffFiles } from "./review-diff-files-context";
import { useReviewInitialData } from "./review-initial-data-context";
interface ReviewDocumentMetaState {
  pullRequestNumber: number | null;
  pullRequestUrl: string | null;
  updatedAtMs: number | null;
}

/**
 * The document byline: pull request number, changed-file count, diff stats,
 * and how recently the review document was generated. Rendered directly
 * under the document title.
 */
export function ReviewDocumentMetaLine(): ReactElement | null {
  const session = useReviewSession();
  const reviewFetch = session.fetch;
  const initialData = useReviewInitialData();
  const diffFiles = useReviewDiffFiles();
  const initialDocumentMeta = initialData?.documentMeta;
  const initialDiffStats = initialData?.diffStats;
  const [meta, setMeta] = useState<ReviewDocumentMetaState | null>(() =>
    initialDocumentMeta ? documentMetaState(initialDocumentMeta) : null,
  );
  const [initialDiff] = useState<ReviewDiffStats | null>(() =>
    initialDiffStats ? reviewDiffStats(initialDiffStats) : null,
  );
  const [relativeTimeNowMs, setRelativeTimeNowMs] = useState<number | null>(
    null,
  );
  const [stackLayers, setStackLayers] = useState<ReviewStackLayer[]>([]);

  useEffect(() => {
    setRelativeTimeNowMs(Date.now());
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    if (!initialDocumentMeta) {
      reviewFetch("/document-meta", {
        signal: controller.signal,
      })
        .then(async (response) => {
          const json: JsonValue = await response.json();
          if (!response.ok || !isJsonObject(json) || json.ok !== true) return;
          setMeta(
            documentMetaState({
              updatedAtMs: jsonNumber(json.updatedAtMs),
              pullRequestNumber: jsonNumber(json.pullRequestNumber),
              pullRequestUrl: jsonString(json.pullRequestUrl),
            }),
          );
        })
        .catch(() => {});
    }
    return () => controller.abort();
  }, [initialDocumentMeta, reviewFetch]);

  useEffect(() => {
    const controller = new AbortController();
    if (!meta?.pullRequestNumber) {
      setStackLayers([]);
      return () => controller.abort();
    }
    reviewFetch("/stack", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        setStackLayers(parseReviewStackResponse(await response.json()).layers);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [meta?.pullRequestNumber, reviewFetch]);

  const diff =
    diffFiles.status === "loaded" ? reviewDiffStats(diffFiles) : initialDiff;
  const updatedLabel =
    meta?.updatedAtMs != null && relativeTimeNowMs != null
      ? relativeTimeLabel(meta.updatedAtMs, relativeTimeNowMs)
      : null;
  if (!meta?.pullRequestNumber && !diff && !updatedLabel) return null;

  return (
    <div className="review-doc-meta">
      {meta?.pullRequestNumber != null &&
        (meta.pullRequestUrl ? (
          <a
            className="review-doc-meta-pr"
            href={meta.pullRequestUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            PR #{meta.pullRequestNumber}
          </a>
        ) : (
          <span className="review-doc-meta-pr">
            PR #{meta.pullRequestNumber}
          </span>
        ))}
      {stackLayers.length > 1 ? (
        <ReviewStackSelector layers={stackLayers} />
      ) : null}
      {diff && (
        <>
          <span>
            {diff.fileCount === 1 ? "1 file" : `${diff.fileCount} files`}
          </span>
          <span className="review-doc-meta-added">+{diff.additions}</span>
          <span className="review-doc-meta-removed">−{diff.deletions}</span>
        </>
      )}
      {updatedLabel && <span>updated {updatedLabel}</span>}
    </div>
  );
}

function ReviewStackSelector({
  layers,
}: {
  layers: readonly ReviewStackLayer[];
}): ReactElement {
  const session = useReviewSession();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const currentIndex = layers.findIndex(
    (layer) => layer.relation === "current",
  );
  const position = currentIndex < 0 ? 1 : currentIndex + 1;
  const openLayer = (
    layer: ReviewStackLayer,
    event: Pick<MouseEvent, "metaKey" | "ctrlKey" | "shiftKey" | "button">,
  ) => {
    if (!layer.reviewUuid) return;
    detailsRef.current?.removeAttribute("open");
    void session.surface.post({
      name: "openReview",
      args: {
        reviewUuid: layer.reviewUuid,
        active: !(
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.button === 1
        ),
      },
    });
  };

  return (
    <details className="review-stack-selector" ref={detailsRef}>
      <summary>
        <span className="review-stack-position">
          {position} of {layers.length}
        </span>
        <span className="review-stack-label">stack</span>
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="m3 4.5 3 3 3-3" />
        </svg>
      </summary>
      <div className="review-stack-menu">
        {layers.map((layer, index) => (
          <ReviewStackLayerRow
            key={layer.pullRequestNumber}
            layer={layer}
            position={index + 1}
            onOpen={openLayer}
          />
        ))}
      </div>
    </details>
  );
}

function ReviewStackLayerRow({
  layer,
  position,
  onOpen,
}: {
  layer: ReviewStackLayer;
  position: number;
  onOpen: (
    layer: ReviewStackLayer,
    event: Pick<MouseEvent, "metaKey" | "ctrlKey" | "shiftKey" | "button">,
  ) => void;
}): ReactElement {
  const current = layer.relation === "current";
  const content = (
    <>
      <span className="review-stack-indicator">
        <span className="review-stack-position-marker">{position}</span>
      </span>
      <span className="review-stack-layer-copy">
        <span className="review-stack-layer-title">
          PR #{layer.pullRequestNumber}
          {layer.reviewTitle ? ` · ${layer.reviewTitle}` : ""}
        </span>
        <span className="review-stack-branch">{layer.branch}</span>
      </span>
      <span className="review-stack-relation">
        {!layer.reviewUuid && !current ? "No Review" : layer.relation}
      </span>
    </>
  );

  if (current) {
    return (
      <div className="review-stack-row is-current" aria-current="true">
        {content}
      </div>
    );
  }

  return (
    <button
      className="review-stack-row"
      type="button"
      data-relation={layer.relation}
      disabled={!layer.reviewUuid}
      title={
        layer.reviewUuid
          ? "Open Review (Cmd/Ctrl-click to open in the background)"
          : "No generated Review exists for this pull request"
      }
      onClick={(event) => onOpen(layer, event)}
      onAuxClick={(event) => {
        if (event.button === 1) onOpen(layer, event);
      }}
    >
      {content}
    </button>
  );
}

function documentMetaState(meta: {
  updatedAtMs?: number;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
}): ReviewDocumentMetaState {
  return {
    pullRequestNumber: meta.pullRequestNumber ?? null,
    pullRequestUrl: meta.pullRequestUrl ?? null,
    updatedAtMs: meta.updatedAtMs ?? null,
  };
}

function reviewDiffStats(diff: {
  files?: { additions?: number; deletions?: number }[];
}): ReviewDiffStats | null {
  if (!diff.files?.length) return null;
  return summarizeReviewDiffFiles(diff.files);
}

function relativeTimeLabel(timeMs: number, nowMs: number): string | null {
  if (!Number.isFinite(timeMs)) return null;
  const seconds = Math.max(0, Math.round((nowMs - timeMs) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return days === 1 ? "1 day ago" : `${days} days ago`;
  return new Date(timeMs).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
