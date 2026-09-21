import type { ReactElement, ReactNode } from "react";

/**
 * Agent-chat row for whatever the human said: a right-aligned bubble with an
 * optional caption, skinned by the `agent-chat-user*` rules.
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
