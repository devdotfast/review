import { randomUUID } from "node:crypto";

import type { SessionUpdate } from "./native-session";

interface PiMessage {
  role: string;
  content: string | { type: string; text?: string }[];
  stopReason?: string;
  errorMessage?: string;
  timestamp: number;
}

interface PiBridgeContext {
  sessionManager: { getSessionId(): string };
}

interface PiBridgeApi {
  on(
    event: "message_end",
    listener: (
      event: { message: PiMessage },
      context: PiBridgeContext,
    ) => Promise<void>,
  ): void;
  on(
    event: "agent_start" | "agent_settled" | "session_shutdown",
    listener: (
      event: { type: "agent_start" | "agent_settled" | "session_shutdown" },
      context: PiBridgeContext,
    ) => Promise<void>,
  ): void;
}

/** Forward newly completed messages, never the session manager's inherited branch. */
export default function piBridgeExtension(pi: PiBridgeApi): void {
  const url = process.env.DEV_FAST_REVIEW_AGENT_BRIDGE_URL;
  const token = process.env.DEV_FAST_REVIEW_AGENT_BRIDGE_TOKEN;
  const launchId = process.env.DEV_FAST_REVIEW_AGENT_LAUNCH_ID;
  if (!url || !token || !launchId)
    throw new Error("Review's Pi bridge requires its URL and token.");
  let failed = false;
  const post = async (
    context: PiBridgeContext,
    update: SessionUpdate,
  ): Promise<void> => {
    try {
      await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-review-token": token,
        },
        body: JSON.stringify({
          sessionId: context.sessionManager.getSessionId(),
          review_launch_id: launchId,
          ...update,
        }),
      });
    } catch {
      // Observation failure must not abort native work.
    }
  };
  pi.on("agent_start", async (_event, context) => {
    failed = false;
    await post(context, { type: "status.changed", status: "running" });
  });
  pi.on("message_end", async ({ message }, context) => {
    if (
      message.role === "assistant" &&
      (message.stopReason === "error" || message.stopReason === "aborted")
    ) {
      failed = true;
      await post(context, {
        type: "status.changed",
        status: message.stopReason === "aborted" ? "interrupted" : "failed",
        error: message.errorMessage,
      });
      return;
    }
    if (
      message.role !== "user" &&
      !(message.role === "assistant" && message.stopReason === "stop")
    )
      return;
    const body = !Array.isArray(message.content)
      ? message.content
      : message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n");
    if (!body.trim()) return;
    await post(context, {
      type: "message.updated",
      message: {
        id: randomUUID(),
        role: message.role,
        body,
        createdAt: new Date(message.timestamp).toISOString(),
      },
    });
  });
  pi.on("agent_settled", async (_event, context) => {
    if (!failed)
      await post(context, { type: "status.changed", status: "idle" });
  });
  pi.on("session_shutdown", async (_event, context) => {
    await post(context, { type: "status.changed", status: "interrupted" });
  });
}
