import { useState } from "react";

import type { DiffSelection } from "../../src/lens-selection";
import type { CallStackDiffBlock } from "../../src/review-api/blocks/call_stack_diff";
import { type CallTreeStop, callTreeStops } from "./call-tree";
import { DiagramHeader } from "./diagram-header";
import { compactDiffCount as compact } from "./diff-count";
import { useReviewSession } from "./host/review-session";
import { useReviewLenses } from "./review-lenses";
import { useReviewPanel } from "./review-panel";
import { captureUiEvent } from "./ui-telemetry";

// Presentation retained from review-experimental's DiffWorkspace.
export function CallTree({
  block,
  onReveal,
  requireReady = false,
  currentStopId = null,
}: {
  block: CallStackDiffBlock;
  requireReady?: boolean;
  onReveal(source: DiffSelection, sectionId?: string, anchorId?: string): void;
  /** Set by a scroll-tracking host; otherwise the last clicked stop is current. */
  currentStopId?: string | null;
}) {
  const lenses = useReviewLenses();
  const stops = callTreeStops(block);
  const [clicked, setClicked] = useState<string>();
  const active = currentStopId ?? clicked;

  return (
    <nav
      className="review-lens-sidebar review-lens-sidebar--callstack"
      aria-label="Call tree"
    >
      <div className="review-call-tree">
        {stops.map((stop, index) => {
          const availability = requireReady
            ? lenses?.availability(stop.sources)
            : "ready";

          const unavailable = availability !== "ready";
          const stats = lenses?.stats(lenses.resolve(stop.sources));

          const change =
            stats?.total.additions && stats?.total.deletions
              ? "modified"
              : stats?.total.additions
                ? "added"
                : stats?.total.deletions
                  ? "removed"
                  : "unchanged";

          return (
            <div
              className={`review-call-entry ${stats?.state === "viewed" ? "is-viewed" : ""}`}
              key={stop.id}
            >
              <TreeConnectors
                stop={stop}
                parentDistance={
                  index -
                  stops.findIndex((candidate) => candidate.id === stop.parentId)
                }
                onCallSite={() => {
                  if (
                    stop.callSite &&
                    (!requireReady ||
                      lenses?.availability([stop.callSite]) === "ready")
                  )
                    onReveal(stop.callSite, stop.id, stop.anchorId);
                }}
              />
              <button
                type="button"
                disabled={unavailable}
                style={{
                  paddingLeft: 14 + (stop.depth + 1) * 16,
                  opacity: unavailable ? 0.45 : undefined,
                }}
                className={`review-call-row review-call-row--${change}`}
                data-review-anchor-id={stop.anchorId}
                aria-current={stop.id === active ? "true" : undefined}
                aria-label={`${stop.label}, ${change}`}
                title={
                  unavailable
                    ? availability === "pending"
                      ? "Waiting for diff…"
                      : "Source unavailable at these pins"
                    : [stop.label, stop.via].filter(Boolean).join(" · ")
                }
                onClick={() => {
                  setClicked(stop.id);
                  onReveal(stop.source, stop.id, stop.anchorId);
                }}
              >
                <span className="review-call-name">{stop.label}</span>
                {unavailable && (
                  <span className="review-lens-stats">
                    {availability === "pending" ? "…" : "Unavailable"}
                  </span>
                )}
                {!unavailable && stats && change !== "unchanged" && (
                  <span
                    className="review-lens-stats"
                    title={`Remaining +${stats.remaining.additions} −${stats.remaining.deletions} · Total +${stats.total.additions} −${stats.total.deletions}`}
                  >
                    {stats.state === "viewed" ? (
                      "✓"
                    ) : (
                      <>
                        <span className="diff-count-added">
                          +{compact(stats.remaining.additions)}
                        </span>
                        <span className="diff-count-removed">
                          −{compact(stats.remaining.deletions)}
                        </span>
                      </>
                    )}
                  </span>
                )}
              </button>
            </div>
          );
        })}
      </div>
    </nav>
  );
}

function TreeConnectors({
  stop,
  parentDistance,
  onCallSite,
}: {
  stop: CallTreeStop;
  parentDistance: number;
  onCallSite: () => void;
}) {
  // The section title is the visual parent of every top-level call.
  const width = (stop.depth + 1) * 16;
  const branchX = stop.depth === 0 ? 0.5 : width - 10;

  return (
    <svg
      className="review-call-connectors"
      width={width}
      height="26"
      viewBox={`0 0 ${width} 26`}
    >
      {stop.branches.map((continues, index) =>
        continues ? (
          <path
            key={index}
            d={`M ${index === 0 ? 0.5 : index * 16 + 6} 0 V 26`}
          />
        ) : null,
      )}
      {!stop.last ? <path d={`M ${branchX} 13 V 26`} /> : null}
      <g
        role={stop.callSite ? "button" : undefined}
        tabIndex={stop.callSite ? 0 : undefined}
        aria-label={
          stop.callSite ? `Go to call site of ${stop.label}` : undefined
        }
        className={stop.callSite ? "review-call-edge" : undefined}
        onClick={stop.callSite ? onCallSite : undefined}
        onKeyDown={
          stop.callSite
            ? (event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onCallSite();
                }
              }
            : undefined
        }
      >
        <title>
          {stop.callSite
            ? `Go to call site of ${stop.label}`
            : "No call-site location recorded"}
        </title>
        <path d={`M ${branchX} 0 V 13 H ${width}`} />
        {stop.callSite ? (
          <>
            <path
              className="review-call-edge-highlight"
              d={`M ${branchX} ${-(parentDistance - 1) * 26} V 13 H ${width}`}
            />
            <path
              className="review-call-edge-hit"
              d={`M ${branchX} 0 V 13 H ${width}`}
            />
          </>
        ) : null}
      </g>
    </svg>
  );
}

/** Document host: the same tree, with source peeks instead of diff navigation. */
export function DocumentCallTree({ block }: { block: CallStackDiffBlock }) {
  const session = useReviewSession();
  const openPeek = useReviewPanel((state) => state.openPeek);

  return (
    <figure
      className="review-document-call-tree"
      data-review-call-stack="ready"
    >
      <DiagramHeader kind="Call tree" title={block.title ?? "Call tree"} />
      <CallTree
        block={block}
        onReveal={(source, sectionId, anchorId) => {
          captureUiEvent(session, "peek_opened", { via: "call_stack_frame" });

          const stop = callTreeStops(block).find(
            (stop) => stop.id === sectionId,
          )!;

          openPeek({
            kind: "peek",
            anchor: {
              id: anchorId ?? sectionId!,
              title: stop.label,
              peek: source,
            },
            content: { kind: "source", source },
          });
        }}
      />
    </figure>
  );
}
