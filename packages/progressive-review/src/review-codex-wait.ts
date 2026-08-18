import {
  type CodexThreadWakeupInput,
  wakeCodexThreadWithRetry,
} from "./codex-thread-wakeup";
import {
  clearReviewCodexWaiter,
  deliverReviewCodexMessage,
} from "./review-codex-wait-state";
import {
  type ReviewWaitDependencies,
  type ReviewWaitResult,
  waitForReviewAction,
} from "./review-wait";

export type ReviewCodexWaitDependencies = {
  clearWaiter: typeof clearReviewCodexWaiter;
  deliverMessage: typeof deliverReviewCodexMessage;
  wakeCodex(input: CodexThreadWakeupInput): Promise<void>;
  waitForReviewAction: typeof waitForReviewAction;
};

const defaultReviewCodexWaitDependencies: ReviewCodexWaitDependencies = {
  clearWaiter: clearReviewCodexWaiter,
  deliverMessage: deliverReviewCodexMessage,
  wakeCodex: wakeCodexThreadWithRetry,
  waitForReviewAction,
};

export async function runReviewCodexWait(
  input: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    ownerToken: string;
    reviewUuid: string;
    threadId: string;
    timeoutSeconds: number;
  },
  dependencies: ReviewCodexWaitDependencies = defaultReviewCodexWaitDependencies,
  waitDependencies?: ReviewWaitDependencies,
): Promise<number> {
  const owner = {
    env: input.env,
    ownerToken: input.ownerToken,
    reviewUuid: input.reviewUuid,
    threadId: input.threadId,
  };
  try {
    const result = await dependencies.waitForReviewAction(
      {
        cwd: input.cwd,
        reviewUuid: input.reviewUuid,
        requiresAgent: true,
        timeoutSeconds: input.timeoutSeconds,
      },
      waitDependencies,
    );
    const messageId = codexReviewMessageId(result);
    await dependencies.deliverMessage({ ...owner, messageId }, async () => {
      await dependencies.wakeCodex({
        clientUserMessageId: messageId,
        env: input.env,
        prompt: codexReviewWakePrompt(result),
        threadId: input.threadId,
      });
    });
    return result.event === "timeout" ? 1 : 0;
  } finally {
    await dependencies.clearWaiter(owner);
  }
}

export function codexReviewMessageId(result: ReviewWaitResult): string {
  const outcome =
    result.event === "review-status"
      ? [result.event, result.status]
      : [result.event];
  const round = result.review.review.presentedDocumentRevision ?? "unpublished";
  return ["dev-fast-review", result.uuid, round, ...outcome].join(":");
}

export function codexReviewWakePrompt(result: ReviewWaitResult): string {
  if (result.event === "timeout") {
    return [
      "<automated_message>",
      `This is an automated message from dev.fast Review. The wait for review ${result.uuid} timed out after ${result.timeoutSeconds} seconds with no reviewer action.`,
      `Run \`review wait --requires-agent --codex --review ${result.uuid}\` again if you still need to block, or continue without it.`,
      "</automated_message>",
    ].join("\n");
  }
  if (result.event === "review-deleted") {
    return [
      "<automated_message>",
      `This is an automated message from dev.fast Review. The reviewer deleted review ${result.uuid} (\"${result.review.review.title}\").`,
      "The review and its threads no longer exist. Do not wait on or publish to this review again; continue without it.",
      "</automated_message>",
    ].join("\n");
  }
  if (result.event === "review-dismissed") {
    return [
      "<automated_message>",
      `This is an automated message from dev.fast Review. The reviewer dismissed review ${result.uuid} (\"${result.review.review.title}\").`,
      "The reviewer is finished with it. Do not wait on or publish to this review again; continue without it.",
      "</automated_message>",
    ].join("\n");
  }
  return [
    "<automated_message>",
    `This is an automated message from dev.fast Review. Review ${result.uuid} (\"${result.review.review.title}\") requires your attention.`,
    `Status: ${result.status}. Decision: ${result.decision ?? "none"}. Open threads: ${result.openThreads}.`,
    `Run \`review threads list --review ${result.uuid}\`. Address every open thread and resolve each one with \`review threads resolve <threadId> --review ${result.uuid}\`. List the threads again. Re-publish only when no open threads remain.`,
    `Run \`review wait --requires-agent --codex --review ${result.uuid}\` again if you need to block for the next reviewer action.`,
    "</automated_message>",
  ].join("\n");
}
