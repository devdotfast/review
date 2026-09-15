import type { ReviewVerbRequest } from "@dev.fast/review-protocol";

import type {
  AgentServer,
  NativeReviewMessage,
} from "../native-agent/native-session.js";
import type { QuestionExecution } from "./questions.js";

/** A fresh terminal session. Keep observing after the first answer to save terminal follow-ups. */
export async function answerWithAgent(
  agent: AgentServer,
  input: QuestionExecution,
  open: (
    args: Extract<
      ReviewVerbRequest,
      { name: "openNativeAgentTerminal" }
    >["args"],
  ) => Promise<void>,
) {
  const launched = await agent.launch({
    cwd: input.cwd,
    prompt: { id: input.messageId, text: input.prompt },
  });

  const pipe = await agent.updates(launched.sessionId);

  const interrupt = () => {
    void agent.interrupt(launched.sessionId).catch(() => {});
    void pipe.close();
  };

  input.signal.addEventListener("abort", interrupt, { once: true });
  let first = true;
  let resolveAnswer!: (text: string) => void;
  let rejectAnswer!: (cause: unknown) => void;

  const answer = new Promise<string>((resolve, reject) => {
    resolveAnswer = resolve;
    rejectAnswer = reject;
  });

  void (async () => {
    try {
      if (input.signal.aborted) throw new Error("Question canceled.");

      let pending: NativeReviewMessage | undefined,
        running = false;

      const saved = new Set<string>();

      for await (const update of pipe.updates) {
        if (input.signal.aborted) throw new Error("Question canceled.");

        if (update.type === "message.updated") {
          const message = update.message;

          if (saved.has(message.id)) continue;

          if (message.role === "assistant") pending = message;
          else {
            saved.add(message.id);

            if (!first)
              await input.onFollowup({
                id: `${launched.sessionId}:${message.id}`,
                by: "user",
                body: message.body,
              });
          }
        } else {
          if (update.status === "running") running = true;

          if (update.status === "failed" || update.status === "interrupted")
            throw new Error("Agent stopped before completing its answer.");

          if (update.status === "idle" && (running || pending)) {
            if (!pending?.body.trim())
              throw new Error("Agent finished without an answer.");
            saved.add(pending.id);

            if (first) {
              first = false;
              resolveAnswer(pending.body);
            } else
              await input.onFollowup({
                id: `${launched.sessionId}:${pending.id}`,
                by: "agent",
                body: pending.body,
              });
            pending = undefined;
            running = false;
          }
        }
      }

      if (first)
        throw new Error(
          "Agent connection closed before completing its answer.",
        );
    } catch (error) {
      rejectAnswer(error);

      if (!first && !input.signal.aborted) input.onError();
    } finally {
      input.signal.removeEventListener("abort", interrupt);
      await pipe.close();
    }
  })();

  try {
    // Consume updates before attaching the terminal; fast agents can finish immediately.
    const [, result] = await Promise.all([
      open({
        reviewId: input.reviewId,
        threadId: input.threadId,
        askMessageId: input.messageId,
        session: { harness: agent.harness, sessionId: launched.sessionId },
        command: launched.command,
      }),
      answer,
    ]);

    return result;
  } catch (error) {
    interrupt();
    throw error;
  }
}
