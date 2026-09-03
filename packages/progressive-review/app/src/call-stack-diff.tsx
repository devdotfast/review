import {
  type CallStackDiffProps,
  type CallStackEntry,
  callStackDiffPropsSchema,
  callStackEntryAnchor,
  isCallsAssertion,
} from "../../src/authoring";
import {
  callStackConnectorPrefix,
  diffCallStacks,
} from "../../src/call-stack-diff";
import { validatedCodePeekInputFromRef } from "./CodePeek";
import { useReviewSession } from "./host/review-session";
import { useReviewPanel } from "./review-panel";
import { captureUiEvent } from "./ui-telemetry";

// A unified diff over a tree: a hunk header, tree-util connectors for
// continuity, a -/+ gutter and row tints for the change. Every frame is a
// live link — a click opens the anchor's peek, exactly like a prose link.
// There is nothing to fetch: the authored lists are the data.

export function CallStackDiff(props: CallStackDiffProps) {
  const session = useReviewSession();
  const parsed = callStackDiffPropsSchema.parse(props);
  const openPeek = useReviewPanel((state) => state.openPeek);
  const rows = diffCallStacks(parsed.base, parsed.head);
  const added = rows.filter((row) => row.change === "added").length;
  const removed = rows.filter((row) => row.change === "removed").length;
  return (
    <div className="call-stack-diff" data-review-call-stack="ready">
      <div className="call-stack-hunk">
        <span className="call-stack-hunk-label">
          {parsed.title
            ? `@@ ${parsed.title} · base → head @@`
            : "@@ base → head @@"}
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
          const anchor = callStackEntryAnchor(row.entry);
          const marker =
            row.change === "added" ? "+" : row.change === "removed" ? "-" : " ";
          return (
            <button
              key={`${anchor.id}-${index}`}
              type="button"
              role="listitem"
              className={`call-stack-row call-stack-${row.change}`}
              data-review-anchor-id={anchor.id}
              title={`${rowTooltip(row.entry)} — ${anchor.peek.props.file}:${anchor.peek.props.fromLine}`}
              onClick={() => {
                captureUiEvent(session, "peek_opened", {
                  via: "call_stack_frame",
                });
                openPeek({
                  kind: "peek",
                  anchor,
                  content: {
                    kind: "resolved-code",
                    input: validatedCodePeekInputFromRef(anchor.peek),
                  },
                });
              }}
            >
              <span className="call-stack-gutter">{marker}</span>
              <span className="call-stack-tree">
                {callStackConnectorPrefix(rows, index)}
              </span>
              <span className="call-stack-name">{anchor.title}</span>
              {isCallsAssertion(row.entry) ? (
                <span className="call-stack-asserted">
                  ≈ {row.entry.reason ?? "asserted"}
                </span>
              ) : null}
              <span className="call-stack-spacer" />
              <span className="call-stack-loc">
                {locationLabel(
                  anchor.peek.props.file,
                  anchor.peek.props.fromLine,
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function rowTooltip(entry: CallStackEntry): string {
  if (!isCallsAssertion(entry)) return entry.title;
  const reason = entry.reason ? `: ${entry.reason}` : "";
  return `${entry.parent.title} → ${entry.child.title}${reason}`;
}

// Rows show only the file name; the full repository path lives in the row
// tooltip. Deep monorepo paths otherwise crush the frame name lane.
function locationLabel(file: string, line: number): string {
  const name = file.split("/").pop() ?? file;
  return `${name}:${line}`;
}
