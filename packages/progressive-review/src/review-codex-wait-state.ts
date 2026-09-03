import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { type JsonValue, parseJsonText } from "@dev.fast/review-protocol";
import { z } from "zod";

import { isMissingFileError } from "./native-agent/transcript-json";
import { writePrivateJsonAtomic } from "./server/desktop-paths";
import { processIsAlive, withFileLock } from "./with-file-lock";

const waitStateSchema = z.object({
  delivered: z.array(z.string()),
  waiter: z
    .object({ ownerToken: z.string(), pid: z.int().positive() })
    .nullable(),
});

type WaitState = z.infer<typeof waitStateSchema>;

export type ReviewCodexWaitOwner = {
  env: NodeJS.ProcessEnv;
  ownerToken: string;
  reviewUuid: string;
  threadId: string;
};

export type ReviewCodexWaitRegistration = {
  pid: number;
  reused: boolean;
  reviewUuid: string;
  threadId: string;
};

type RegistrationDependencies = {
  createOwnerToken(): string;
  processIsAlive(pid: number): boolean;
};

export async function registerReviewCodexWait(
  input: {
    env: NodeJS.ProcessEnv;
    reviewUuid: string;
    start(ownerToken: string): number;
    threadId: string;
  },
  dependencies: RegistrationDependencies = {
    createOwnerToken: randomUUID,
    processIsAlive,
  },
): Promise<ReviewCodexWaitRegistration> {
  return await updateWaitState(input, (state) => {
    if (state.waiter && dependencies.processIsAlive(state.waiter.pid)) {
      return [undefined, registration(input, state.waiter.pid, true)];
    }

    const ownerToken = dependencies.createOwnerToken();
    const pid = input.start(ownerToken);
    return [
      { ...state, waiter: { ownerToken, pid } },
      registration(input, pid, false),
    ];
  });
}

export async function deliverReviewCodexMessage(
  input: ReviewCodexWaitOwner & { messageId: string },
  deliver: () => Promise<void>,
): Promise<boolean> {
  const shouldDeliver = await updateWaitState(input, (state) => {
    if (!ownsWaiter(state, input.ownerToken)) return [undefined, false];
    if (state.delivered.includes(input.messageId)) return [undefined, false];
    return [undefined, true];
  });
  if (!shouldDeliver) return false;

  await deliver();
  await updateWaitState(input, (state) => [
    state.delivered.includes(input.messageId)
      ? undefined
      : { ...state, delivered: [...state.delivered, input.messageId] },
    undefined,
  ]);
  return true;
}

export async function clearReviewCodexWaiter(
  input: ReviewCodexWaitOwner,
): Promise<void> {
  await updateWaitState(input, (state) =>
    ownsWaiter(state, input.ownerToken)
      ? [{ ...state, waiter: null }, undefined]
      : [undefined, undefined],
  );
}

function registration(
  input: { reviewUuid: string; threadId: string },
  pid: number,
  reused: boolean,
): ReviewCodexWaitRegistration {
  return {
    pid,
    reused,
    reviewUuid: input.reviewUuid,
    threadId: input.threadId,
  };
}

function ownsWaiter(state: WaitState, ownerToken: string): boolean {
  return state.waiter?.ownerToken === ownerToken;
}

type StateUpdate<T> = (
  state: WaitState,
) => [nextState: WaitState | undefined, result: T];

async function updateWaitState<T>(
  input: { env: NodeJS.ProcessEnv; reviewUuid: string; threadId: string },
  update: StateUpdate<T>,
): Promise<T> {
  const statePath = reviewCodexWaitStatePath(input);
  const outcome = await withFileLock(
    `${statePath}.lock`,
    {
      heartbeatMs: 1_000,
      retryMs: 10,
      staleMs: 10_000,
      timeoutMs: 5_000,
      unownedGraceMs: 1_000,
    },
    async () => {
      const [nextState, result] = update(await readWaitState(statePath));
      if (nextState) await writePrivateJsonAtomic(statePath, nextState);
      return result;
    },
  );
  if (!outcome.acquired) {
    throw new Error(
      `Timed out while updating the Codex waiter for Review ${input.reviewUuid}.`,
    );
  }
  return outcome.result;
}

async function readWaitState(statePath: string): Promise<WaitState> {
  let value: JsonValue;
  try {
    value = parseJsonText(await readFile(statePath, "utf8"));
  } catch (error) {
    if (isMissingFileError(error)) {
      return { waiter: null, delivered: [] };
    }
    throw new Error(`Could not read Codex waiter state at ${statePath}.`, {
      cause: error,
    });
  }
  const state = waitStateSchema.safeParse(value);
  if (!state.success) {
    throw new Error(`Codex waiter state is invalid at ${statePath}.`);
  }
  return state.data;
}

function reviewCodexWaitStatePath(input: {
  env: NodeJS.ProcessEnv;
  reviewUuid: string;
  threadId: string;
}): string {
  const devHome = input.env.DEV_REVIEW_HOME?.trim()
    ? path.resolve(input.env.DEV_REVIEW_HOME)
    : path.join(homedir(), ".dev");
  const threadKey = createHash("sha256")
    .update(input.threadId)
    .digest("hex")
    .slice(0, 24);
  return path.join(
    devHome,
    "review-codex-waits",
    input.reviewUuid,
    `${threadKey}.json`,
  );
}
