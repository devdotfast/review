import type { ReactNode } from "react";

import type { TraceQuoteProps } from "../../src/authoring";
import { ProsePeekAnchor } from "./review-components";
import { useOptionalReviewPanel } from "./review-panel";

function extractText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") {
    return "";
  }
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(extractText).join("");
  }
  if (
    typeof node === "object" &&
    "props" in node &&
    (node as { props?: { children?: ReactNode } }).props
  ) {
    return extractText(
      (node as { props: { children?: ReactNode } }).props.children,
    );
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
        if (el && typeof el.scrollIntoView === "function") {
          el.scrollIntoView({ block: "center", behavior: "auto" });
        }
      }}
    >
      {children}
    </ProsePeekAnchor>
  );
}
