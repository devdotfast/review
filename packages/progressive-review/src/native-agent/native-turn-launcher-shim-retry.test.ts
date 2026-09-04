import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ReviewVerbRequest } from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as cliInstall from "../server/cli-install";
import type { BeginNativeLaunchInput } from "./native-observer";
import type { NativeTerminalHandle } from "./native-session";

const writePathShim = vi.spyOn(cliInstall, "writePathShim");
let failNTimes = 0;
let attempts = 0;

const { NativeReviewTurnLauncher } = await import("./native-turn-launcher");
const { NativeSessionObserverRegistry } = await import("./native-observer");

type NativeTerminalInput = Extract<
  ReviewVerbRequest,
  { name: "openNativeAgentTerminal" }
>["args"];
type OpenTerminalSpy = ReturnType<
  typeof vi.fn<(input: NativeTerminalInput) => void>
>;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  writePathShim.mockReset();
  failNTimes = 0;
  attempts = 0;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function enforceTransientFailure(failCount: number): void {
  failNTimes = failCount;
  attempts = 0;
  writePathShim.mockImplementation(async () => {
    attempts += 1;
    if (attempts <= failNTimes) {
      throw Object.assign(new Error("ENOSPC: transient"), { code: "ENOSPC" });
    }
  });
}

function succeedWithoutWriting(): void {
  writePathShim.mockImplementation(async () => {});
}

// The launcher's failure path rejects the `accepted` promise of a launch
// handle without ever awaiting it, which would surface as an unhandled
// rejection during failure-path tests. Attach a no-op handler here so failed
// launches do not leak rejections while still exercising the real observer.
class SwallowAcceptedObserver extends NativeSessionObserverRegistry {
  override beginLaunch(input: BeginNativeLaunchInput): NativeTerminalHandle {
    const handle = super.beginLaunch(input);
    handle.accepted.catch(() => {});
    return handle;
  }
}

describe("NativeReviewTurnLauncher shim preparation", () => {
  it("memoizes a successful shim write so writePathShim runs only once per session", async () => {
    const { launcher, openTerminal, runtimeDirectory } = await createLauncher();
    succeedWithoutWriting();

    for (const launchId of ["l1", "l2", "l3"]) {
      const handle = await launcher.launchTurn({
        launchId,
        threadId: "t",
        reviewMessageId: "m",
        cwd: "/tmp",
        prompt: "hi",
        route: { kind: "new", harness: "pi" },
      });
      await handle.detach();
    }

    expect(writePathShim).toHaveBeenCalledTimes(1);
    expect(openTerminal).toHaveBeenCalledTimes(3);
    const expectedPath = `${path.join(runtimeDirectory, "bin")}${
      path.delimiter
    }${process.env.PATH}`;
    for (const call of openTerminal.mock.calls) {
      expect(call[0].env.PATH).toBe(expectedPath);
    }
  });

  it("retries the idempotent shim write after a transient failure and opens the next terminal", async () => {
    const { launcher, openTerminal, runtimeDirectory } = await createLauncher();
    enforceTransientFailure(1);

    // 1st launch: writePathShim rejects -> launchTurn rejects, no terminal.
    await expect(
      launcher.launchTurn({
        launchId: "l1",
        threadId: "t1",
        reviewMessageId: "m1",
        cwd: "/tmp",
        prompt: "hi",
        route: { kind: "new", harness: "pi" },
      }),
    ).rejects.toMatchObject({ code: "ENOSPC" });
    expect(writePathShim).toHaveBeenCalledTimes(1);
    expect(openTerminal).not.toHaveBeenCalled();

    // 2nd launch: filesystem recovered -> writePathShim retried and succeeds.
    const handle = await launcher.launchTurn({
      launchId: "l2",
      threadId: "t2",
      reviewMessageId: "m2",
      cwd: "/tmp",
      prompt: "hi",
      route: { kind: "new", harness: "pi" },
    });

    expect(writePathShim).toHaveBeenCalledTimes(2);
    expect(openTerminal).toHaveBeenCalledTimes(1);
    const terminal = terminalInput(openTerminal);
    const binDirectory = path.join(runtimeDirectory, "bin");
    expect(terminal.env.PATH).toBe(
      `${binDirectory}${path.delimiter}${process.env.PATH}`,
    );

    // The recovered success is also memoized: a third launch must not re-write.
    const handle2 = await launcher.launchTurn({
      launchId: "l3",
      threadId: "t3",
      reviewMessageId: "m3",
      cwd: "/tmp",
      prompt: "hi",
      route: { kind: "new", harness: "pi" },
    });
    expect(writePathShim).toHaveBeenCalledTimes(2);
    await Promise.all([handle.detach(), handle2.detach()]);
  });

  it("does not touch writePathShim when reviewCliPath is unset", async () => {
    const { launcher, openTerminal } = await createLauncher({
      reviewCliPath: undefined,
    });
    succeedWithoutWriting();

    const handle = await launcher.launchTurn({
      launchId: "l1",
      threadId: "t1",
      reviewMessageId: "m1",
      cwd: "/tmp",
      prompt: "hi",
      route: { kind: "new", harness: "pi" },
    });

    expect(writePathShim).not.toHaveBeenCalled();
    const terminal = terminalInput(openTerminal);
    // No shim directory is prepended: PATH is just the inherited value.
    expect(terminal.env.PATH).toBe(process.env.PATH);
    await handle.detach();
  });
});

async function createLauncher(
  overrides: { reviewCliPath?: string } = {},
): Promise<{
  launcher: InstanceType<typeof NativeReviewTurnLauncher>;
  openTerminal: OpenTerminalSpy;
  runtimeDirectory: string;
}> {
  const runtimeDirectory = await mkdtemp(
    path.join(tmpdir(), "review-native-launcher-shim-"),
  );
  temporaryDirectories.push(runtimeDirectory);
  const openTerminal = vi.fn<(input: NativeTerminalInput) => void>();
  const launcher = new NativeReviewTurnLauncher({
    hookBaseUrl: "http://127.0.0.1:4000/hooks",
    hookToken: "secret",
    runtimeDirectory,
    reviewCliPath: Object.hasOwn(overrides, "reviewCliPath")
      ? overrides.reviewCliPath
      : "/some/cli.js",
    openTerminal: async (input) => openTerminal(input),
    observer: new SwallowAcceptedObserver(),
  });
  return { launcher, openTerminal, runtimeDirectory };
}

function terminalInput(openTerminal: OpenTerminalSpy): NativeTerminalInput {
  const input = openTerminal.mock.calls[0]?.[0];
  if (!input) throw new Error("Expected the native terminal to open.");
  return input;
}
