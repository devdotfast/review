import type { Writable } from "node:stream";

import {
  type ReviewDesktopGlobalEvent,
  ReviewDesktopGlobalEventSchema,
} from "@dev.fast/review-protocol";

import { readReviewDesktopDiscovery } from "./desktop-discovery";
import type { StoredReview } from "./review-home";
import { readOpenReviewThreadCount } from "./review-storage";
import { resolveReviewRoot } from "./runtime";
import { resolvePublishReview } from "./server/publish-preparation";

const DEFAULT_TIMEOUT_SECONDS = 3600;

type ReviewStatus = StoredReview["review"]["status"];
type ReviewStatusChange = Extract<
  ReviewDesktopGlobalEvent,
  { event: "review-status-changed" }
>;
type ReviewDeleted = Extract<
  ReviewDesktopGlobalEvent,
  { event: "review-deleted" }
>;
/* Dismissal ends the reader's involvement, so a waiting agent must stop. It
   replaced the old "rejected" close, which the desktop no longer writes. */
type ReviewAttentionChanged = Extract<
  ReviewDesktopGlobalEvent,
  { event: "review-attention-changed" }
>;

type ReviewWaitEvent =
  | ReviewStatusChange
  | ReviewDeleted
  | ReviewAttentionChanged;

export type ReviewWaitResult =
  | {
      event: "review-status";
      uuid: string;
      status: ReviewStatus;
      decision?: ReviewStatusChange["decision"];
      openThreads: number;
      occurredAtMs: number;
      review: StoredReview;
    }
  | {
      event: "review-deleted";
      uuid: string;
      occurredAtMs: number;
      review: StoredReview;
    }
  | {
      event: "review-dismissed";
      uuid: string;
      occurredAtMs: number;
      review: StoredReview;
    }
  | {
      event: "timeout";
      uuid: string;
      timeoutSeconds: number;
      occurredAtMs: number;
      review: StoredReview;
    };

export interface ReviewWaitDependencies {
  fetch: typeof fetch;
  now(): number;
  readDesktopDiscovery: typeof readReviewDesktopDiscovery;
  readOpenReviewThreadCount: typeof readOpenReviewThreadCount;
  resolvePublishReview: typeof resolvePublishReview;
  resolveReviewRoot: typeof resolveReviewRoot;
}

const defaultReviewWaitDependencies: ReviewWaitDependencies = {
  fetch,
  now: Date.now,
  readDesktopDiscovery: readReviewDesktopDiscovery,
  readOpenReviewThreadCount,
  resolvePublishReview,
  resolveReviewRoot,
};

/** The JSON line `review wait` prints; key order is part of the contract. */
interface ReviewWaitJsonOutput {
  event: string;
  uuid: string;
  status: ReviewStatus;
  decision?: ReviewStatusChange["decision"];
  openThreads: number;
}

export async function runReviewWait(
  input: {
    cwd: string;
    reviewUuid?: string;
    requiresAgent?: boolean;
    timeoutSeconds?: number;
    stdout: Writable;
  },
  dependencies: ReviewWaitDependencies = defaultReviewWaitDependencies,
): Promise<number> {
  const result = await waitForReviewAction(
    {
      cwd: input.cwd,
      reviewUuid: input.reviewUuid,
      requiresAgent: input.requiresAgent,
      timeoutSeconds: input.timeoutSeconds,
    },
    dependencies,
  );
  writeWaitResult(input.stdout, result);
  return result.event === "timeout" ? 1 : 0;
}

export async function validateReviewWait(
  input: {
    cwd: string;
    reviewUuid?: string;
  },
  dependencies: ReviewWaitDependencies = defaultReviewWaitDependencies,
): Promise<StoredReview> {
  const discovery = await requireReviewDesktop(dependencies);
  const response = await dependencies.fetch(`${discovery.url}/events`, {
    headers: { "x-review-token": discovery.token },
  });
  if (!response.ok || !response.body) {
    throw new Error(`Review Desktop returned ${response.status} for events.`);
  }
  await response.body.cancel();
  const reviewRoot = await dependencies.resolveReviewRoot(input.cwd);
  return await dependencies.resolvePublishReview(reviewRoot, input.reviewUuid, {
    includeTerminal: true,
  });
}

// This exported core is shared by the foreground waiter and detached Codex waiter.
export async function waitForReviewAction(
  input: {
    cwd: string;
    reviewUuid?: string;
    requiresAgent?: boolean;
    timeoutSeconds?: number;
  },
  dependencies: ReviewWaitDependencies = defaultReviewWaitDependencies,
): Promise<ReviewWaitResult> {
  const timeoutSeconds = input.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const discovery = await requireReviewDesktop(dependencies);
  const response = await dependencies.fetch(`${discovery.url}/events`, {
    headers: { "x-review-token": discovery.token },
  });
  if (!response.ok || !response.body) {
    throw new Error(`Review Desktop returned ${response.status} for events.`);
  }

  const reviewRoot = await dependencies.resolveReviewRoot(input.cwd);
  const review = await dependencies.resolvePublishReview(
    reviewRoot,
    input.reviewUuid,
    { includeTerminal: true },
  );
  if (
    input.requiresAgent
      ? reviewWaitRequiresAgentStatus(review.review.status)
      : review.review.status !== "awaiting-review"
  ) {
    await response.body.cancel();
    return {
      event: "review-status",
      uuid: review.review.uuid,
      status: review.review.status,
      openThreads: await dependencies.readOpenReviewThreadCount(review.dir),
      occurredAtMs: dependencies.now(),
      review,
    };
  }

  const result = await waitForReviewStatusChange(
    response.body,
    review.review.uuid,
    timeoutSeconds,
    input.requiresAgent ? reviewWaitRequiresAgentResult : () => true,
  );
  if (result.event === "timeout") {
    return { ...result, occurredAtMs: dependencies.now(), review };
  }
  if (result.event === "review-deleted") {
    // The review directory is gone; do not read thread state from it.
    return {
      event: "review-deleted",
      uuid: result.uuid,
      occurredAtMs: dependencies.now(),
      review,
    };
  }
  if (result.event === "review-attention-changed") {
    return {
      event: "review-dismissed",
      uuid: result.uuid,
      occurredAtMs: dependencies.now(),
      review,
    };
  }

  const status: ReviewWaitResult = {
    event: "review-status",
    uuid: result.uuid,
    status: result.status,
    openThreads: await dependencies.readOpenReviewThreadCount(review.dir),
    occurredAtMs: dependencies.now(),
    review,
  };
  if (result.decision) status.decision = result.decision;
  return status;
}

export function reviewRequiresAgentAction(status: ReviewStatus): boolean {
  return status === "draft" || status === "awaiting-agent-updates";
}

function reviewWaitRequiresAgentResult(event: ReviewWaitEvent): boolean {
  return (
    event.event === "review-deleted" ||
    event.event === "review-attention-changed" ||
    event.status === "accepted" ||
    event.status === "rejected" ||
    reviewRequiresAgentAction(event.status)
  );
}

function reviewWaitRequiresAgentStatus(status: ReviewStatus): boolean {
  return (
    reviewRequiresAgentAction(status) ||
    status === "accepted" ||
    status === "rejected"
  );
}

function writeWaitResult(stdout: Writable, result: ReviewWaitResult): void {
  if (result.event === "timeout") {
    stdout.write(
      `${JSON.stringify({
        event: result.event,
        uuid: result.uuid,
        timeoutSeconds: result.timeoutSeconds,
      })}\n`,
    );
    return;
  }
  if (
    result.event === "review-deleted" ||
    result.event === "review-dismissed"
  ) {
    stdout.write(
      `${JSON.stringify({
        event: result.event,
        uuid: result.uuid,
      })}\n`,
    );
    return;
  }
  // JSON.stringify omits an undefined decision; the key order is the CLI's
  // documented output shape.
  const output: ReviewWaitJsonOutput = {
    event: result.event,
    uuid: result.uuid,
    status: result.status,
    decision: result.decision,
    openThreads: result.openThreads,
  };
  stdout.write(`${JSON.stringify(output)}\n`);
}

async function requireReviewDesktop(dependencies: ReviewWaitDependencies) {
  const discovery = await dependencies.readDesktopDiscovery();
  if (!discovery) {
    throw new Error(
      "Review Desktop is not running. Run `review app launch`, then retry `review wait`.",
    );
  }
  return discovery;
}

async function waitForReviewStatusChange(
  body: ReadableStream<Uint8Array>,
  uuid: string,
  timeoutSeconds: number,
  shouldFinish: (event: ReviewWaitEvent) => boolean,
): Promise<
  ReviewWaitEvent | { event: "timeout"; uuid: string; timeoutSeconds: number }
> {
  const reader = body.getReader();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (
      result:
        | ReviewWaitEvent
        | { event: "timeout"; uuid: string; timeoutSeconds: number },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      void reader.cancel();
      resolve(result);
    };
    const timeout = setTimeout(
      () => finish({ event: "timeout", uuid, timeoutSeconds }),
      timeoutSeconds * 1000,
    );
    consumeSse(reader, (event) => {
      if (
        (event.event === "review-status-changed" ||
          event.event === "review-deleted" ||
          // Only dismissal ends the wait; a "viewed" stamp is not an outcome.
          (event.event === "review-attention-changed" &&
            event.attention === "dismissed")) &&
        event.uuid === uuid &&
        shouldFinish(event)
      ) {
        finish(event);
      }
    }).then(
      () => {
        if (!settled) {
          clearTimeout(timeout);
          reject(new Error("Review Desktop events stream ended."));
        }
      },
      (error) => {
        if (!settled) {
          clearTimeout(timeout);
          reject(error);
        }
      },
    );
  });
}

async function consumeSse(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  consume: (event: ReviewDesktopGlobalEvent) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  const consumeLine = (line: string) => {
    if (!line) {
      if (data.length > 0) {
        consume(
          ReviewDesktopGlobalEventSchema.parse(JSON.parse(data.join("\n"))),
        );
        data = [];
      }
      return;
    }
    if (line.startsWith(":")) return;
    if (line.startsWith("data:")) {
      data.push(line.slice("data:".length).replace(/^ /, ""));
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      consumeLine(buffer.slice(0, newline).replace(/\r$/, ""));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
    if (done) break;
  }
  if (buffer) consumeLine(buffer.replace(/\r$/, ""));
  if (data.length > 0) {
    consume(ReviewDesktopGlobalEventSchema.parse(JSON.parse(data.join("\n"))));
  }
}
