import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearReviewCodexWaiter,
  deliverReviewCodexMessage,
  registerReviewCodexWait,
} from "./review-codex-wait-state";

const reviewUuid = "99d4519f-5a72-4684-9af4-98abaa2849cc";
const threadId = "thread-1";
const children: ChildProcess[] = [];
let root: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "review-codex-wait-state-"));
  env = { DEV_REVIEW_HOME: root };
});

afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  await rm(root, { force: true, recursive: true });
});

describe("Codex Review wait state", () => {
  it("starts one child for two concurrent registrations", async () => {
    const start = vi.fn<() => number>(() => {
      const child = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        { stdio: "ignore" },
      );
      children.push(child);
      if (!child.pid) throw new Error("Test child did not start.");
      return child.pid;
    });

    const [first, second] = await Promise.all([
      registerReviewCodexWait({ env, reviewUuid, start, threadId }),
      registerReviewCodexWait({ env, reviewUuid, start, threadId }),
    ]);

    expect(start).toHaveBeenCalledOnce();
    expect(first.pid).toBe(second.pid);
    expect([first.reused, second.reused].sort()).toEqual([false, true]);
  });

  it("replaces a dead waiter and rejects stale cleanup", async () => {
    await register(101, "owner-1", () => false);
    const replacement = await register(202, "owner-2", () => false);
    await clearReviewCodexWaiter(owner("owner-1"));
    const reused = await register(303, "owner-3", (pid) => pid === 202);

    expect(replacement).toMatchObject({ pid: 202, reused: false });
    expect(reused).toMatchObject({ pid: 202, reused: true });
  });

  it("records success and retries a failed delivery", async () => {
    await register(101, "owner-1", () => false);
    const send = vi.fn<() => Promise<undefined>>(async () => undefined);

    await expect(deliver("owner-1", "message-1", send)).resolves.toBe(true);
    await expect(deliver("owner-1", "message-1", send)).resolves.toBe(false);
    await expect(
      deliver("owner-1", "message-2", async () => {
        throw new Error("IPC failed");
      }),
    ).rejects.toThrow("IPC failed");
    await expect(deliver("owner-1", "message-2", send)).resolves.toBe(true);

    await register(202, "owner-2", () => false);
    await expect(deliver("owner-2", "message-1", send)).resolves.toBe(false);
    await expect(deliver("owner-2", "message-3", send)).resolves.toBe(true);
  });
});

function register(
  pid: number,
  ownerToken: string,
  processIsAlive: (candidate: number) => boolean,
) {
  return registerReviewCodexWait(
    { env, reviewUuid, start: () => pid, threadId },
    { createOwnerToken: () => ownerToken, processIsAlive },
  );
}

function owner(ownerToken: string) {
  return { env, ownerToken, reviewUuid, threadId };
}

function deliver(
  ownerToken: string,
  messageId: string,
  send: () => Promise<void>,
) {
  return deliverReviewCodexMessage({ ...owner(ownerToken), messageId }, send);
}
