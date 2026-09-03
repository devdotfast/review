import { type ReactNode, isValidElement } from "react";

import type { TraceQuoteProps } from "../../src/authoring";
import { isReactTextNode } from "./agent-markdown";
import { ProsePeekAnchor } from "./review-components";
import { useOptionalReviewPanel } from "./review-panel";

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
}: TraceQuoteProps) {
  const quote = extractText(children);
  const openPeek = useOptionalReviewPanel((state) => state.openPeek);
  const isOpen =
    useOptionalReviewPanel((state) => {
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
    <ProsePeekAnchor
      href={href}
      className="review-trace-quote"
      isOpen={isOpen}
      inertFallback={
        <span className="review-trace-quote review-trace-quote--inert">
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
        const targetTurn = document.getElementById("review-trace-target-event");
        const quoteMark = targetTurn?.querySelector(".review-trace-quote-mark");
        const el = quoteMark ?? targetTurn;
        // jsdom has no scrollIntoView, so the call stays optional.
        el?.scrollIntoView?.({ block: "center", behavior: "auto" });
      }}
    >
      {children}
    </ProsePeekAnchor>
  );
}
