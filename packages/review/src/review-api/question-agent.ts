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
  let launched = await agent.launch({
    cwd: input.cwd,
    prompt: { id: input.messageId, text: input.prompt },
  });

  let observing = false;
  let observedSignal = input.signal;
  let stop = () => {};

  let observation = Promise.resolve();
  let resolveAnswer!: (text: string) => void;
  let rejectAnswer!: (cause: unknown) => void;

  const answer = new Promise<string>((resolve, reject) => {
    resolveAnswer = resolve;
    rejectAnswer = reject;
  });

  const observe = async (signal: AbortSignal, first: boolean) => {
    const sessionId = launched.sessionId;
    const pipe = await agent.updates(sessionId);

    const interrupt = () => {
      void agent.interrupt(sessionId).catch(() => {});
      void pipe.close();
    };

    stop = interrupt;
    observedSignal = signal;
    signal.addEventListener("abort", interrupt, { once: true });

    if (signal.aborted) interrupt();
    observing = true;
    observation = (async () => {
      try {
        if (signal.aborted) throw new Error("Question canceled.");

        let pending: NativeReviewMessage | undefined,
          running = false;

        const saved = new Set<string>();

        for await (const update of pipe.updates) {
          if (signal.aborted) throw new Error("Question canceled.");

          if (update.type === "message.updated") {
            const message = update.message;

            if (saved.has(message.id)) continue;

            if (message.role === "assistant") pending = message;
            else {
              saved.add(message.id);

              if (!first)
                await input.onFollowup({
                  id: `${sessionId}:${message.id}`,
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
                  id: `${sessionId}:${pending.id}`,
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

        if (!first && !signal.aborted) input.onError();
      } finally {
        observing = false;
        signal.removeEventListener("abort", interrupt);
        await pipe.close();
      }
    })();
  };

  const show = () =>
    open({
      reviewId: input.reviewId,
      threadId: input.threadId,
      askMessageId: input.messageId,
      session: { harness: agent.harness, sessionId: launched.sessionId },
      command: launched.command,
    });

  const reopen = async (signal: AbortSignal) => {
    // A live observer means the existing terminal can be brought forward.
    // Otherwise resume silently and observe only new terminal follow-ups.
    if (!observing || observedSignal.aborted) {
      await observation;
      launched = await agent.launch({
        cwd: input.cwd,
        session: { resume: launched.sessionId },
      });
      await observe(signal, false);
    }

    try {
      await show();
    } catch (error) {
      stop();
      throw error;
    }
  };

  await observe(input.signal, true);
  const initialOpen = show();
  input.onSession(
    { harness: agent.harness, sessionId: launched.sessionId },
    async (signal) => {
      await initialOpen;
      await reopen(signal);
    },
  );

  try {
    // Consume updates before attaching the terminal; fast agents can finish immediately.
    const [, result] = await Promise.all([initialOpen, answer]);

    return result;
  } catch (error) {
    if (!input.signal.aborted) stop();
    throw error;
  }
}
