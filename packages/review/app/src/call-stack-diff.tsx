import {
  callStackConnectorPrefix,
  diffCallStacks,
} from "../../src/call-stack-diff";
import { frameIdentity, frameName } from "../../src/call-stack-frames";
import type { Frame } from "../../src/review-api/document";
import { evidenceLocation } from "../../src/source";
import { useReviewSession } from "./host/review-session";
import { useReviewPanel } from "./review-panel";
import type { PeekAnchor } from "./review-panel-model";
import { captureUiEvent } from "./ui-telemetry";

// A unified diff over a tree: a hunk header, tree-util connectors for
// continuity, a -/+ gutter and row tints for the change. Every frame is a
// live link — a click opens the frame's source, exactly like a prose link.
// There is nothing to fetch: the frame lists are the data.

export interface CallStackDiffProps {
  title?: string;
  base: readonly Frame[];
  head: readonly Frame[];
}

export function CallStackDiff({ title, base, head }: CallStackDiffProps) {
  const session = useReviewSession();
  const openPeek = useReviewPanel((state) => state.openPeek);
  const rows = diffCallStacks(base, head);
  const added = rows.filter((row) => row.change === "added").length;
  const removed = rows.filter((row) => row.change === "removed").length;

  return (
    <div className="call-stack-diff" data-review-call-stack="ready">
      <div className="call-stack-hunk">
        <span className="call-stack-hunk-label">
          {title ? `@@ ${title} · base → head @@` : "@@ base → head @@"}
        </span>
        <span className="call-stack-hunk-counts">
          {added > 0 ? (
            <span className="call-stack-count-added">+{added}</span>
          ) : null}
          {removed > 0 ? (
            <span className="call-stack-count-removed">−{removed}</span>
          ) : null}
        </span>
      </div>
      <div className="call-stack-body" role="list">
        {rows.map((row, index) => {
          const { frame } = row;
          const name = frameName(frame);
          const stack = row.change === "removed" ? base : head;
          const parent = stack[row.depth - 1];

          const marker =
            row.change === "added" ? "+" : row.change === "removed" ? "-" : " ";

          return (
            <button
              key={`${frame.id ?? frameIdentity(frame)}-${index}`}
              type="button"
              role="listitem"
              className={`call-stack-row call-stack-${row.change}`}
              data-review-anchor-id={frame.id ?? frameIdentity(frame)}
              title={`${rowTooltip(frame, parent)} — ${evidenceLocation(frame.source).file}:${evidenceLocation(frame.source).fromLine}`}
              onClick={() => {
                captureUiEvent(session, "peek_opened", {
                  via: "call_stack_frame",
                });
                openPeek({
                  kind: "peek",
                  anchor: panelAnchor(frame),
                  content: { kind: "source", source: frame.source },
                });
              }}
            >
              <span className="call-stack-gutter">{marker}</span>
              <span className="call-stack-tree">
                {callStackConnectorPrefix(rows, index)}
              </span>
              <span className="call-stack-name">{name}</span>
              {frame.via ? (
                <span className="call-stack-asserted">
                  ≈ {relationshipLabel(frame.via)}
                </span>
              ) : null}
              <span className="call-stack-spacer" />
              <span className="call-stack-loc">
                {locationLabel(
                  evidenceLocation(frame.source).file,
                  evidenceLocation(frame.source).fromLine,
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The side panel keys its state by anchor; a frame is its own anchor. */
function panelAnchor(frame: Frame): PeekAnchor {
  return {
    id: frame.id ?? frameIdentity(frame),
    title: frameName(frame),
    peek: frame.source,
  };
}

function relationshipLabel(via: NonNullable<Frame["via"]>): string {
  return via.kind === "call" ? via.reason : `${via.kind}: ${via.reason}`;
}

function rowTooltip(frame: Frame, parent: Frame | undefined): string {
  const name = frameName(frame);

  if (!frame.via) return name;

  return `${parent ? frameName(parent) : "…"} → ${name}: ${relationshipLabel(frame.via)}`;
}

// Rows show only the file name; the full repository path lives in the row
// tooltip. Deep monorepo paths otherwise crush the frame name lane.
function locationLabel(file: string, line: number): string {
  const name = file.split("/").pop() ?? file;

  return `${name}:${line}`;
}
