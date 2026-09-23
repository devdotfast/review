import { type SpawnOptions, spawn } from "node:child_process";
import path from "node:path";

import {
  type WhiteboardDesktopDiscovery,
  parseWhiteboardVerbResponse,
} from "@dev.fast/whiteboard-protocol";

import {
  readHealthyWhiteboardDesktopDiscovery,
  readWhiteboardDesktopDiscovery,
} from "./desktop-discovery";

const WHITEBOARD_DESKTOP_BUNDLE_ID = "dev.fast.review";

/** "1" on launches without --focus; Desktop opens inactive. */
export const WHITEBOARD_DESKTOP_BACKGROUND_ENV =
  "DEV_FAST_WHITEBOARD_DESKTOP_BACKGROUND";

const DEFAULT_LAUNCH_TIMEOUT_MS = 90_000;

const POLL_INTERVAL_MS = 250;

const EARLY_EXIT_GRACE_MS = 5_000;

interface DesktopLaunchProcess {
  once(event: "error", listener: (error: Error) => void): this;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  unref(): void;
}

interface WhiteboardAppLauncherRuntime {
  readWhiteboardDesktopDiscovery: typeof readWhiteboardDesktopDiscovery;
  fetch: typeof globalThis.fetch;
  focusDesktop: (discovery: WhiteboardDesktopDiscovery) => Promise<void>;
  launchDesktop: typeof launchDesktopApplication;
  now: () => number;
  wait: (milliseconds: number) => Promise<void>;
}

export interface RunWhiteboardAppLaunchInput {
  timeoutMs?: number;
  /** Bring Review Desktop forward. */
  focus?: boolean;
}

export interface WhiteboardAppLaunchEvent {
  event: "app";
  action: "launch";
  state: "launched" | "running";
  instanceId: string;
}

export interface DesktopLaunchAttempt {
  method: string;
  successfulExitIsExpected: boolean;
  completion: Promise<DesktopLaunchCompletion>;
}

export interface DesktopLaunchCompletion {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface LaunchDesktopApplicationInput {
  platform?: NodeJS.Platform;
  execPath?: string;
  electron?: boolean;
  env?: NodeJS.ProcessEnv;
  focus?: boolean;
  spawn?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => DesktopLaunchProcess;
}

export async function runWhiteboardAppLaunch(
  input: RunWhiteboardAppLaunchInput = {},
  overrides: Partial<WhiteboardAppLauncherRuntime> = {},
): Promise<WhiteboardAppLaunchEvent> {
  const fetch = overrides.fetch ?? globalThis.fetch;

  const runtime: WhiteboardAppLauncherRuntime = {
    readWhiteboardDesktopDiscovery,
    fetch,
    focusDesktop: (discovery) => focusWhiteboardDesktop(discovery, fetch),
    launchDesktop: launchDesktopApplication,
    now: Date.now,
    wait: (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    ...overrides,
  };

  const running = await readLaunchHealthyDesktop(runtime);

  if (running) {
    if (input.focus) await runtime.focusDesktop(running);

    return launchEvent("running", running.instanceId);
  }

  const attempt = runtime.launchDesktop({ focus: input.focus });

  let completion: Promise<DesktopLaunchCompletion> | undefined =
    observedCompletion(attempt);

  void completion.catch(() => undefined);

  const deadline =
    runtime.now() + (input.timeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS);

  let unexpectedSuccessfulExitAt: number | undefined;

  while (runtime.now() < deadline) {
    const ready = await readLaunchHealthyDesktop(runtime);

    if (ready) return launchEvent("launched", ready.instanceId);

    if (
      unexpectedSuccessfulExitAt !== undefined &&
      runtime.now() - unexpectedSuccessfulExitAt >= EARLY_EXIT_GRACE_MS
    ) {
      throw launchFailure(
        attempt.method,
        new Error("the launch process exited before Desktop became ready"),
      );
    }

    const remaining = Math.max(0, deadline - runtime.now());

    const outcome = completion
      ? await Promise.race([
          completion.then((result) => ({ completion: result })),
          runtime
            .wait(Math.min(POLL_INTERVAL_MS, remaining))
            .then(() => ({ completion: null })),
        ])
      : await runtime
          .wait(Math.min(POLL_INTERVAL_MS, remaining))
          .then(() => ({ completion: null }));

    if (outcome.completion) {
      assertSuccessfulLaunchCompletion(attempt.method, outcome.completion);

      if (!attempt.successfulExitIsExpected) {
        unexpectedSuccessfulExitAt = runtime.now();
      }

      completion = undefined;
    }
  }

  if (unexpectedSuccessfulExitAt !== undefined) {
    throw launchFailure(
      attempt.method,
      new Error("the launch process exited before Desktop became ready"),
    );
  }

  throw new Error(
    `Whiteboard did not become ready within ${Math.ceil((input.timeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS) / 1_000)} seconds after ${attempt.method}. Open Whiteboard once, then run \`whiteboard app launch\` again.`,
  );
}

export async function focusWhiteboardDesktop(
  discovery: WhiteboardDesktopDiscovery,
  fetch: typeof globalThis.fetch,
): Promise<void> {
  const response = await fetch(`${discovery.url}/app/focus`, {
    method: "POST",
    headers: { "x-whiteboard-token": discovery.token },
    signal: AbortSignal.timeout(5_000),
  });

  const result = parseWhiteboardVerbResponse(await response.json());

  if (!response.ok || !result.ok) {
    throw new Error(
      result.ok
        ? `Whiteboard focus returned ${response.status}.`
        : result.error,
    );
  }
}

export function launchDesktopApplication(
  input: LaunchDesktopApplicationInput = {},
): DesktopLaunchAttempt {
  const platform = input.platform ?? process.platform;

  if (platform !== "darwin" && platform !== "linux") {
    return {
      method: `the ${platform} application launcher`,
      successfulExitIsExpected: false,
      completion: Promise.reject(
        new Error("automatic launch is available only on macOS and Linux"),
      ),
    };
  }

  const electron = input.electron ?? Boolean(process.versions.electron);
  const env = { ...(input.env ?? process.env) };
  const directLaunch = electron || platform === "linux";
  const focus = input.focus === true;

  if (focus) delete env[WHITEBOARD_DESKTOP_BACKGROUND_ENV];
  else env[WHITEBOARD_DESKTOP_BACKGROUND_ENV] = "1";

  if (directLaunch) delete env.ELECTRON_RUN_AS_NODE;

  if (platform === "linux") {
    delete env.VSCODE_DEV;
    delete env.VSCODE_CLI;
  }

  let command = "/usr/bin/open";
  let method = `the macOS bundle identifier "${WHITEBOARD_DESKTOP_BUNDLE_ID}"`;

  let args = ["-b", WHITEBOARD_DESKTOP_BUNDLE_ID];

  // open(1) drops the caller's env; --env carries the marker.
  if (!focus)
    args = ["-g", ...args, "--env", `${WHITEBOARD_DESKTOP_BACKGROUND_ENV}=1`];

  if (directLaunch) {
    // The Fedora CLI wrappers name their own channel's launcher.
    command =
      env.DEV_FAST_WHITEBOARD_DESKTOP_COMMAND?.trim() ||
      "/usr/bin/review-desktop";
    method = `the installed Linux launcher at "${command}"`;

    if (electron) {
      command = input.execPath ?? process.execPath;
      method = `the Desktop-managed bundle at "${command}"`;
    }

    args = [];
    const stateRoot = env.DEV_FAST_WHITEBOARD_DESKTOP_STATE_ROOT?.trim();

    if (stateRoot) {
      args = [
        `--user-data-dir=${path.resolve(stateRoot, "user-data")}`,
        `--extensions-dir=${path.resolve(stateRoot, "extensions")}`,
      ];
    }
  }

  let resolveCompletion: (result: DesktopLaunchCompletion) => void = () =>
    undefined;

  let rejectCompletion: (error: Error) => void = () => undefined;

  const completion = new Promise<DesktopLaunchCompletion>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  try {
    const spawnProcess = input.spawn ?? spawn;

    const child = spawnProcess(command, args, {
      detached: true,
      env,
      stdio: "ignore",
    });

    child.once("error", (error) => rejectCompletion(error));
    child.once("exit", (code, signal) => {
      resolveCompletion({ code, signal });
    });
    child.unref();
  } catch (error) {
    rejectCompletion(error instanceof Error ? error : new Error(String(error)));
  }

  return {
    method,
    successfulExitIsExpected: !directLaunch,
    completion,
  };
}

function launchEvent(
  state: WhiteboardAppLaunchEvent["state"],
  instanceId: string,
): WhiteboardAppLaunchEvent {
  return { event: "app", action: "launch", state, instanceId };
}

async function readLaunchHealthyDesktop(
  runtime: Pick<
    WhiteboardAppLauncherRuntime,
    "readWhiteboardDesktopDiscovery" | "fetch"
  >,
) {
  try {
    return await readHealthyWhiteboardDesktopDiscovery({
      readDiscovery: runtime.readWhiteboardDesktopDiscovery,
      fetch: runtime.fetch,
    });
  } catch {
    // Launch must recover from stale, malformed, and incompatible discovery.
    return null;
  }
}

function launchFailure(method: string, error: Error): Error {
  return new Error(
    `Could not launch Whiteboard with ${method}: ${error.message}. Open Whiteboard once, then run \`whiteboard app launch\` again.`,
  );
}

function assertSuccessfulLaunchCompletion(
  method: string,
  completion: DesktopLaunchCompletion,
): void {
  if (completion.code === 0 && !completion.signal) return;
  throw launchFailure(
    method,
    new Error(
      completion.signal
        ? `the launch process exited on ${completion.signal}`
        : `the launch process exited with code ${completion.code ?? "unknown"}`,
    ),
  );
}

function observedCompletion(
  attempt: DesktopLaunchAttempt,
): Promise<DesktopLaunchCompletion> {
  return attempt.completion.catch((error) => {
    throw launchFailure(
      attempt.method,
      error instanceof Error ? error : new Error(String(error)),
    );
  });
}
