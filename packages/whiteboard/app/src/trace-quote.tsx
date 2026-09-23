import { type ReactNode, isValidElement } from "react";

import type { WhiteboardComponentProps } from "../../src/whiteboard-document-data";
import { isReactTextNode } from "./agent-markdown";
import { ProsePeekAnchor } from "./whiteboard-components";
import { useOptionalWhiteboardPanel } from "./whiteboard-panel";

function extractText(node: ReactNode): string {
  if (isReactTextNode(node)) return String(node);

  if (Array.isArray(node)) return node.map(extractText).join("");

  if (isValidElement<{ children?: ReactNode }>(node)) {
    return extractText(node.props.children);
  }

  return "";
}

export function TraceQuote({
  sessionId,
  trace,
  event,
  children,
}: WhiteboardComponentProps<"TraceQuote"> & { children?: ReactNode }) {
  const quote = extractText(children);
  const openPeek = useOptionalWhiteboardPanel((state) => state.openPeek);

  const isOpen =
    useOptionalWhiteboardPanel((state) => {
      const active = state.active;

      return (
        active?.kind === "peek" &&
        active.content.kind === "trace-quote" &&
        active.content.sessionId === sessionId &&
        active.content.quote === quote &&
        active.content.trace === trace
      );
    }) ?? false;

  const href = `#trace-${sessionId}${trace ? `-${trace}` : ""}${event !== undefined ? `-event-${event}` : ""}`;

  return (
    <span className="whiteboard-trace-quote-container">
      <ProsePeekAnchor
        href={href}
        className="whiteboard-trace-quote"
        isOpen={isOpen}
        inertFallback={
          <span className="whiteboard-trace-quote whiteboard-trace-quote--inert">
            {children}
          </span>
        }
        onOpen={() => {
          openPeek?.({
            kind: "peek",
            content: {
              kind: "trace-quote",
              sessionId,
              trace,
              event,
              quote,
            },
          });
        }}
        onAlreadyOpen={() => {
          const targetTurn = document.getElementById(
            "whiteboard-trace-target-event",
          );

          const quoteMark = targetTurn?.querySelector(
            ".whiteboard-trace-quote-mark",
          );

          const el = quoteMark ?? targetTurn;
          // jsdom has no scrollIntoView, so the call stays optional.
          el?.scrollIntoView?.({ block: "center", behavior: "auto" });
        }}
      >
        {children}
      </ProsePeekAnchor>
    </span>
  );
}
