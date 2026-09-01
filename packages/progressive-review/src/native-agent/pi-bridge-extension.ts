/**
 * Pi extension that mirrors the live session into Review. Pi runs this
 * in-process, so the conversation is projected from the session manager's
 * own state and posted to the PiAgentServer that launched this terminal.
 * Every post carries the whole projection; the server forwards the tail.
 */

interface PiEntry {
  id?: string;
  parentId?: string | null;
  type?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
    stopReason?: string;
    timestamp?: number;
  };
}

interface PiBridgeContext {
  sessionManager: {
    getBranch(): PiEntry[];
    getSessionId(): string;
  };
}

interface PiBridgeApi {
  on(
    event: "agent_settled" | "message_end" | "session_start",
    listener: (
      event: unknown,
      context: PiBridgeContext,
    ) => void | Promise<void>,
  ): void;
}

interface BridgeMessage {
  role: "user" | "assistant";
  body: string;
  createdAt: string;
}

const BRIDGE_URL_ENV = "DEV_FAST_REVIEW_AGENT_BRIDGE_URL";
const BRIDGE_TOKEN_ENV = "DEV_FAST_REVIEW_AGENT_BRIDGE_TOKEN";

export default function piBridgeExtension(pi: PiBridgeApi): void {
  const post = async (context: PiBridgeContext): Promise<void> => {
    const url = process.env[BRIDGE_URL_ENV];
    const token = process.env[BRIDGE_TOKEN_ENV];
    if (!url || !token) return;
    try {
      await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-review-token": token,
        },
        body: JSON.stringify({
          sessionId: context.sessionManager.getSessionId(),
          messages: projectBranch(context.sessionManager.getBranch()),
        }),
      });
    } catch {
      // The bridge is fail-open. Native agent work must continue.
    }
  };

  pi.on("session_start", (_event, context) => post(context));
  pi.on("message_end", (_event, context) => post(context));
  pi.on("agent_settled", (_event, context) => post(context));
}

/** Review-visible messages on the active branch: every user message, and the final assistant message before the next user message. */
export function projectBranch(branch: readonly PiEntry[]): BridgeMessage[] {
  // getBranch walks leaf to root; present root first.
  const ordered =
    branch.length > 0 && branch[0]?.parentId ? [...branch].reverse() : branch;
  const messages: BridgeMessage[] = [];
  let pendingAssistant: BridgeMessage | undefined;
  const flushAssistant = (): void => {
    if (pendingAssistant) messages.push(pendingAssistant);
    pendingAssistant = undefined;
  };
  for (const entry of ordered) {
    if (entry.type !== "message" || !entry.message) continue;
    const body = textBlocks(entry.message.content).join("\n").trim();
    if (entry.message.role === "user") {
      flushAssistant();
      if (body)
        messages.push({ role: "user", body, createdAt: timestamp(entry) });
      continue;
    }
    if (
      entry.message.role === "assistant" &&
      entry.message.stopReason === "stop" &&
      body
    ) {
      pendingAssistant = {
        role: "assistant",
        body,
        createdAt: timestamp(entry),
      };
    }
  }
  flushAssistant();
  return messages;
}

function textBlocks(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value] : [];
  if (!Array.isArray(value)) return [];
  return value.flatMap((block: unknown) =>
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string" &&
    (block as { text: string }).text.trim()
      ? [(block as { text: string }).text]
      : [],
  );
}

function timestamp(entry: PiEntry): string {
  if (typeof entry.timestamp === "string") return entry.timestamp;
  if (typeof entry.message?.timestamp === "number") {
    return new Date(entry.message.timestamp).toISOString();
  }
  return new Date(0).toISOString();
}
