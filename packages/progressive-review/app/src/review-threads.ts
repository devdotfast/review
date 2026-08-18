import { gitLabDiffPositionRows } from "@dev.fast/review-protocol";

import type { CommentThreadView } from "./review-context";
import { projectCodeTarget } from "./target-fingerprint";
import type { ThreadTargetState } from "./thread-target-state";

export interface ThreadMessage {
  id: string;
  by: string;
  at: string;
  body: string;
  userAuthored: boolean;
  /** Agent answers render through markdown; user messages are plain text. */
  agentMarkdown?: boolean;
  running?: boolean;
  error?: string;
  stderr?: string;
}

/**
 * One annotation thread. User and agent messages render as equal participants.
 */
export interface ThreadView {
  key: string;
  threadId: string;
  target: CommentThreadView["target"];
  quote: string;
  resolved: boolean;
  clientStatus?: CommentThreadView["clientStatus"];
  agentSession?: CommentThreadView["agentSession"];
  messages: ThreadMessage[];
  latestAt: string;
  targetState?: ThreadTargetState;
}

export type ThreadListStatus = "open" | "pending" | "resolved";

export function threadListStatus(thread: ThreadView): ThreadListStatus {
  if (thread.resolved) return "resolved";
  if (
    thread.clientStatus !== undefined &&
    thread.clientStatus !== "persisted"
  ) {
    return "pending";
  }
  return "open";
}

export function commentThreadView(thread: CommentThreadView): ThreadView {
  const messages: ThreadMessage[] = thread.messages.map((message) => ({
    id: message.id,
    by: message.by,
    at: message.at,
    body: message.body,
    userAuthored: message.role !== "agent",
    ...(message.format === "markdown" ? { agentMarkdown: true } : {}),
  }));
  if (thread.agentActivity) {
    const activity = thread.agentActivity;
    messages.push({
      id: `review-agent-activity:${activity.messageId}`,
      by: "Agent",
      at: activity.startedAt,
      body:
        activity.status === "starting"
          ? "Starting\u2026"
          : activity.status === "running"
            ? "Running\u2026"
            : "Failed",
      userAuthored: false,
      ...(activity.status === "failed" ? { error: activity.error } : {}),
      ...(activity.status !== "failed" ? { running: true } : {}),
    });
  }
  return {
    key: thread.threadId,
    threadId: thread.threadId,
    target: thread.target,
    quote: targetQuote(thread.target),
    resolved: thread.status === "resolved",
    clientStatus: thread.clientStatus,
    agentSession: thread.agentSession,
    messages,
    latestAt: messages.at(-1)?.at ?? "",
  };
}

export function targetQuote(target: CommentThreadView["target"]): string {
  if (target.kind === "document") return "Entire document";
  if (target.kind === "text") return target.selection.quote;
  if (target.kind === "code") {
    const projection =
      projectCodeTarget(target, "head") ?? projectCodeTarget(target, "base");
    if (projection) {
      const { endLine, startLine } = projection.span;
      return startLine === endLine
        ? `${projection.path}:L${startLine}`
        : `${projection.path}:L${startLine}-L${endLine}`;
    }
    const rows = gitLabDiffPositionRows(target.position);
    if (!rows) return "Code comment";
    const startPath =
      rows.start.new_line !== null
        ? target.position.new_path
        : target.position.old_path;
    const endPath =
      rows.end.new_line !== null
        ? target.position.new_path
        : target.position.old_path;
    const startLine = rows.start.new_line ?? rows.start.old_line;
    const endLine = rows.end.new_line ?? rows.end.old_line;
    if (!startPath || !endPath || startLine === null || endLine === null) {
      return "Code comment";
    }
    return `${startPath}:L${startLine} → ${endPath}:L${endLine}`;
  }
  return target.element.quote;
}

export function threadRelativeTimeLabel(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 45) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(time).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
