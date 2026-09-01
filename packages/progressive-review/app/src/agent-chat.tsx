import type { ReactElement, ReactNode } from "react";

/**
 * Shared agent-chat rows. The trace document and comment threads render the
 * same transcript anatomy through these components: a right-aligned bubble for
 * whatever the human said, full-width prose for whatever the agent said, and a
 * mono status row for agent activity. Each surface only chooses which rows to
 * feed and which chrome wraps them; the skin is defined once, by the
 * `agent-chat-*` rules the trace styles share.
 */

export function AgentChatUserMessage({
  children,
  caption,
  bubbleClassName,
}: {
  children: ReactNode;
  caption?: ReactNode;
  bubbleClassName?: string;
}): ReactElement {
  return (
    <div className="agent-chat-user">
      <div
        className={
          bubbleClassName
            ? `agent-chat-user-bubble ${bubbleClassName}`
            : "agent-chat-user-bubble"
        }
      >
        {children}
      </div>
      {caption != null && <span className="agent-chat-caption">{caption}</span>}
    </div>
  );
}

export function AgentChatAgentMessage({
  children,
  caption,
}: {
  children: ReactNode;
  caption?: ReactNode;
}): ReactElement {
  return (
    <div className="agent-chat-agent">
      <div className="agent-chat-prose">{children}</div>
      {caption != null && <span className="agent-chat-caption">{caption}</span>}
    </div>
  );
}

/**
 * Agent activity as a transcript row: a mono label against a hairline, the
 * same register as the trace document's worked separator. `tone` marks the
 * live state with the accent dot.
 */
export function AgentChatStatusRow({
  children,
  tone = "idle",
}: {
  children: ReactNode;
  tone?: "idle" | "running";
}): ReactElement {
  return (
    <div className="agent-chat-status">
      {tone === "running" && (
        <span className="agent-chat-status-dot" aria-hidden="true" />
      )}
      <span className="agent-chat-status-label">{children}</span>
      <span className="agent-chat-status-line" aria-hidden="true" />
    </div>
  );
}
