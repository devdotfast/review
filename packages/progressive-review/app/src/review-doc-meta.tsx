import {
  type JsonValue,
  type ReviewDiffStats,
  isJsonObject,
  jsonNumber,
  jsonString,
  summarizeReviewDiffFiles,
} from "@dev.fast/review-protocol";
import { type ReactElement, useEffect, useState } from "react";

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
