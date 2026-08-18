interface PiObserverContext {
  sessionManager: {
    getSessionFile(): string | undefined;
    getSessionId(): string;
  };
}

interface PiObserverApi {
  on(
    event: "agent_settled" | "message_end" | "session_start",
    listener: (
      event: unknown,
      context: PiObserverContext,
    ) => void | Promise<void>,
  ): void;
}

const HOOK_URL_ENV = "DEV_FAST_REVIEW_AGENT_HOOK_URL";
const HOOK_TOKEN_ENV = "DEV_FAST_REVIEW_AGENT_HOOK_TOKEN";

export default function piObserverExtension(pi: PiObserverApi): void {
  const post = async (
    event: "agent_settled" | "message_end" | "session_start",
    context: PiObserverContext,
  ): Promise<void> => {
    const url = process.env[HOOK_URL_ENV];
    const token = process.env[HOOK_TOKEN_ENV];
    if (!url || !token) return;
    try {
      await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-review-token": token,
        },
        body: JSON.stringify({
          event,
          sessionId: context.sessionManager.getSessionId(),
          transcriptPath: context.sessionManager.getSessionFile(),
        }),
      });
    } catch {
      // Observation is fail-open. Native agent work must continue.
    }
  };

  pi.on("session_start", (_event, context) => post("session_start", context));
  pi.on("message_end", (_event, context) => post("message_end", context));
  pi.on("agent_settled", (_event, context) => post("agent_settled", context));
}
