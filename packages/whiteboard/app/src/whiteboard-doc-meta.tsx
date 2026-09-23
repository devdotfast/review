import {
  type WhiteboardDiffStats,
  type WhiteboardStackLayer,
  summarizeWhiteboardDiffFiles,
} from "@dev.fast/whiteboard-protocol";
import {
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import { DiffCount } from "./diff-count";
import { DisplayedWhiteboardVersionContext } from "./displayed-whiteboard-version-context";
import { useWhiteboardSession } from "./host/whiteboard-session";
import { WhiteboardBranchRange } from "./whiteboard-branch-range";
import { useWhiteboardDiffFiles } from "./whiteboard-diff-files-context";

interface WhiteboardDocumentMetaState {
  pullRequestNumber: number | null;
  pullRequestUrl: string | null;
  updatedAtMs: number | null;
}

/**
 * Automatic document header: repository and PR identity above the title,
 * with the saved branch, commit range and diff statistics below it.
 */
export function WhiteboardDocumentMetaLine({
  children,
}: {
  children?: ReactNode;
}): ReactElement {
  const session = useWhiteboardSession();
  const whiteboardFetch = session.fetch;
  const displayedVersion = useContext(DisplayedWhiteboardVersionContext);
  const diffFiles = useWhiteboardDiffFiles();

  const whiteboard = session.review!;
  const meta = documentMetaState(whiteboard);

  const [relativeTimeNowMs, setRelativeTimeNowMs] = useState<number | null>(
    null,
  );

  const [stackLayers, setStackLayers] = useState<WhiteboardStackLayer[]>([]);

  useEffect(() => {
    setRelativeTimeNowMs(Date.now());
  }, [displayedVersion]);

  useEffect(() => {
    const controller = new AbortController();

    if (!meta?.pullRequestNumber) {
      setStackLayers([]);

      return () => controller.abort();
    }

    const layers = whiteboard.stack(controller.signal);

    layers
      .then((next) => {
        if (!controller.signal.aborted) setStackLayers(next);
      })
      .catch(() => {});

    return () => controller.abort();
  }, [
    meta?.pullRequestNumber,
    meta?.pullRequestUrl,
    whiteboardFetch,
    whiteboard,
    displayedVersion,
  ]);

  const diff =
    diffFiles.status === "loaded" ? whiteboardDiffStats(diffFiles) : null;

  const updatedLabel =
    meta?.updatedAtMs != null && relativeTimeNowMs != null
      ? relativeTimeLabel(meta.updatedAtMs, relativeTimeNowMs)
      : null;

  const repository = meta.pullRequestUrl?.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\//,
  );

  return (
    <header className="whiteboard-document-header">
      <div className="whiteboard-header-top" data-whiteboard-copy-ignore>
        <div className="whiteboard-header-identity">
          {repository ? (
            <span>
              {repository[1]} / {repository[2]}
            </span>
          ) : null}
          {repository && meta.pullRequestNumber != null ? (
            <span className="whiteboard-header-separator" aria-hidden="true">
              ·
            </span>
          ) : null}
          {meta.pullRequestNumber != null &&
            (meta.pullRequestUrl ? (
              <a
                className="whiteboard-doc-meta-pr"
                href={meta.pullRequestUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                PR #{meta.pullRequestNumber}
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 20 20"
                  aria-hidden="true"
                >
                  <path d="M7 4h9v9M16 4 5 15" />
                </svg>
              </a>
            ) : (
              <span className="whiteboard-doc-meta-pr">
                PR #{meta.pullRequestNumber}
              </span>
            ))}
          {stackLayers.length > 1 ? (
            <>
              <span className="whiteboard-header-separator" aria-hidden="true">
                ·
              </span>
              <WhiteboardStackSelector layers={stackLayers} />
            </>
          ) : null}
        </div>
        {updatedLabel && (
          <span className="whiteboard-header-updated">
            Updated {updatedLabel}
          </span>
        )}
      </div>
      {children}
      <div className="whiteboard-header-details" data-whiteboard-copy-ignore>
        {whiteboard.headBranch?.trim() ? (
          <span
            className="whiteboard-doc-meta-branch"
            title={`Head branch: ${whiteboard.headBranch}`}
          >
            <svg width="13" height="13" viewBox="0 0 20 20" aria-hidden="true">
              <circle cx="5" cy="4.5" r="2" />
              <circle cx="5" cy="15.5" r="2" />
              <circle cx="15" cy="6.5" r="2" />
              <path d="M5 6.5v7M15 8.5c0 3-10 2-10 5" />
            </svg>
            <span>{whiteboard.headBranch}</span>
          </span>
        ) : null}
        {diff && whiteboard.pins && (
          <div className="whiteboard-header-stats">
            <span>
              {diff.fileCount === 1 ? "1 file" : `${diff.fileCount} files`}
            </span>
            <DiffCount additions={diff.additions} deletions={diff.deletions} />
            {diff.additions + diff.deletions > 0 ? (
              <span className="whiteboard-header-change-bar" aria-hidden="true">
                {diff.additions > 0 ? (
                  <span style={{ flexGrow: diff.additions }} />
                ) : null}
                {diff.deletions > 0 ? (
                  <span
                    className="is-removed"
                    style={{ flexGrow: diff.deletions }}
                  />
                ) : null}
              </span>
            ) : null}
          </div>
        )}
      </div>
      {whiteboard.pins && (
        <div
          className="whiteboard-header-comparison"
          data-whiteboard-copy-ignore
        >
          <span>Comparing</span>
          <WhiteboardBranchRange
            baseRef={whiteboard.pins.base}
            headRef={whiteboard.pins.head}
          />
        </div>
      )}
    </header>
  );
}

function WhiteboardStackSelector({
  layers,
}: {
  layers: readonly WhiteboardStackLayer[];
}): ReactElement {
  const session = useWhiteboardSession();
  const detailsRef = useRef<HTMLDetailsElement>(null);

  const currentIndex = layers.findIndex(
    (layer) => layer.relation === "current",
  );

  const position = currentIndex < 0 ? 1 : currentIndex + 1;

  const openLayer = (
    layer: WhiteboardStackLayer,
    event: Pick<MouseEvent, "metaKey" | "ctrlKey" | "shiftKey" | "button">,
  ) => {
    if (!layer.sessionId) return;
    detailsRef.current?.removeAttribute("open");
    void session.surface.post({
      name: "openWhiteboard",
      args: {
        sessionId: layer.sessionId,
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
    <details className="whiteboard-stack-selector" ref={detailsRef}>
      <summary>
        <span className="whiteboard-stack-position">
          {position} of {layers.length}
        </span>
        <span className="whiteboard-stack-label">stack</span>
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="m3 4.5 3 3 3-3" />
        </svg>
      </summary>
      <div className="whiteboard-stack-menu">
        {layers.map((layer, index) => (
          <WhiteboardStackLayerRow
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

function WhiteboardStackLayerRow({
  layer,
  position,
  onOpen,
}: {
  layer: WhiteboardStackLayer;
  position: number;
  onOpen: (
    layer: WhiteboardStackLayer,
    event: Pick<MouseEvent, "metaKey" | "ctrlKey" | "shiftKey" | "button">,
  ) => void;
}): ReactElement {
  const current = layer.relation === "current";

  const content = (
    <>
      <span className="whiteboard-stack-indicator">
        <span className="whiteboard-stack-position-marker">{position}</span>
      </span>
      <span className="whiteboard-stack-layer-copy">
        <span className="whiteboard-stack-layer-title">
          PR #{layer.pullRequestNumber}
          {layer.whiteboardTitle ? ` · ${layer.whiteboardTitle}` : ""}
        </span>
        <span className="whiteboard-stack-branch">{layer.branch}</span>
      </span>
      <span className="whiteboard-stack-relation">
        {!layer.sessionId && !current ? "No session" : layer.relation}
      </span>
    </>
  );

  if (current) {
    return (
      <div className="whiteboard-stack-row is-current" aria-current="true">
        {content}
      </div>
    );
  }

  return (
    <button
      className="whiteboard-stack-row"
      type="button"
      data-relation={layer.relation}
      disabled={!layer.sessionId}
      title={
        layer.sessionId
          ? "Open session (Cmd/Ctrl-click to open in the background)"
          : "No generated session exists for this pull request"
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
}): WhiteboardDocumentMetaState {
  return {
    pullRequestNumber: meta.pullRequestNumber ?? null,
    pullRequestUrl: meta.pullRequestUrl ?? null,
    updatedAtMs: meta.updatedAtMs ?? null,
  };
}

function whiteboardDiffStats(diff: {
  files?: { additions?: number; deletions?: number }[];
}): WhiteboardDiffStats | null {
  if (!diff.files?.length) return null;

  return summarizeWhiteboardDiffFiles(diff.files);
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
