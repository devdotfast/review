/**
 * Pi extension that mirrors the live session into Review. Pi runs this
 * in-process, so the conversation is projected from the session manager's
 * own state and posted to the PiAgentServer that launched this terminal.
 * Every post carries the whole projection; the server forwards the tail.
 */

interface PiContentBlock {
  type?: string;
  text?: string;
}

interface PiEntry {
  id?: string;
  parentId?: string | null;
  type?: string;
  timestamp?: string;
  message?: {
    role?: string;
    /** Plain text, or Pi's content blocks. */
    content?: string | PiContentBlock[];
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

/** Pi's event object; the bridge re-projects the session instead of reading it. */
interface PiBridgeEvent {
  type?: string;
}

interface PiBridgeApi {
  on(
    event: "agent_settled" | "message_end" | "session_start",
    listener: (
      event: PiBridgeEvent,
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

function textBlocks(value: string | PiContentBlock[] | undefined): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return value.trim() ? [value] : [];
  return value.flatMap((block) =>
    block.type === "text" && block.text?.trim() ? [block.text] : [],
  );
}

function timestamp(entry: PiEntry): string {
  if (entry.timestamp !== undefined) return entry.timestamp;
  const millis = entry.message?.timestamp;
  if (millis !== undefined) return new Date(millis).toISOString();
  return new Date(0).toISOString();
}
