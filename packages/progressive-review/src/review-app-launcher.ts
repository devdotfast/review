import { type SpawnOptions, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import {
  type ReviewDesktopDiscovery,
  parseReviewVerbResponse,
} from "@dev.fast/review-protocol";

import {
  readHealthyReviewDesktopDiscovery,
  readReviewDesktopDiscovery,
} from "./desktop-discovery";
import { findProgressiveReviewPackageRoot } from "./package-paths";
import { reviewDesktopDiscoveryPath } from "./server/desktop-paths";

const REVIEW_DESKTOP_BUNDLE_ID = "dev.fast.review";
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

interface ReviewAppLauncherRuntime {
  readReviewDesktopDiscovery: typeof readReviewDesktopDiscovery;
  fetch: typeof globalThis.fetch;
  focusDesktop: (discovery: ReviewDesktopDiscovery) => Promise<void>;
  launchDesktop: typeof launchDesktopApplication;
  now: () => number;
  wait: (milliseconds: number) => Promise<void>;
}

export interface RunReviewAppLaunchInput {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  packageRoot?: string;
}

export interface ReviewAppLaunchEvent {
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
  packageRoot?: string;
  spawn?: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => DesktopLaunchProcess;
}

export async function runReviewAppLaunch(
  input: RunReviewAppLaunchInput = {},
  overrides: Partial<ReviewAppLauncherRuntime> = {},
): Promise<ReviewAppLaunchEvent> {
  const env = input.env ?? process.env;
  const packageRoot = input.packageRoot ?? findProgressiveReviewPackageRoot();
  const checkout = checkoutLaunchScript(packageRoot);
  const checkBuild = (discovery: ReviewDesktopDiscovery) => {
    if (
      checkout &&
      (!discovery.cliPath ||
        path.resolve(discovery.cliPath) !==
          path.join(packageRoot, "dist", "cli.js"))
    )
      throw new Error(
        "A different Review Desktop build owns this profile. Close it or select an isolated DEV_REVIEW_HOME before launching this checkout. The installed app was not activated.",
      );
  };
  const fetch = overrides.fetch ?? globalThis.fetch;
  const runtime: ReviewAppLauncherRuntime = {
    readReviewDesktopDiscovery: () =>
      readReviewDesktopDiscovery(reviewDesktopDiscoveryPath(env)),
    fetch,
    focusDesktop: (discovery) => focusReviewDesktop(discovery, fetch),
    launchDesktop: () => launchDesktopApplication({ env, packageRoot }),
    now: Date.now,
    wait: (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    ...overrides,
  };
  const running = await readLaunchHealthyDesktop(runtime);
  if (running) {
    checkBuild(running);
    await runtime.focusDesktop(running);
    return launchEvent("running", running.instanceId);
  }

  const attempt = runtime.launchDesktop();
  let completion: Promise<DesktopLaunchCompletion> | undefined =
    observedCompletion(attempt);
  void completion.catch(() => undefined);
  const deadline =
    runtime.now() + (input.timeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS);
  let unexpectedSuccessfulExitAt: number | undefined;
  while (runtime.now() < deadline) {
    const ready = await readLaunchHealthyDesktop(runtime);
    if (ready) {
      checkBuild(ready);
      return launchEvent("launched", ready.instanceId);
    }
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
    `Review Desktop did not become ready within ${Math.ceil((input.timeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS) / 1_000)} seconds after ${attempt.method}. Open Review Desktop once, then run \`review app launch\` again.`,
  );
}

async function focusReviewDesktop(
  discovery: ReviewDesktopDiscovery,
  fetch: typeof globalThis.fetch,
): Promise<void> {
  const response = await fetch(`${discovery.url}/app/focus`, {
    method: "POST",
    headers: { "x-review-token": discovery.token },
    signal: AbortSignal.timeout(5_000),
  });
  const result = parseReviewVerbResponse(await response.json());
  if (!response.ok || !result.ok) {
    throw new Error(
      result.ok
        ? `Review Desktop focus returned ${response.status}.`
        : result.error,
    );
  }
}

export function launchDesktopApplication(
  input: LaunchDesktopApplicationInput = {},
): DesktopLaunchAttempt {
  const platform = input.platform ?? process.platform;
  const electron = input.electron ?? Boolean(process.versions.electron);
  const checkout = electron
    ? null
    : checkoutLaunchScript(
        input.packageRoot ?? findProgressiveReviewPackageRoot(),
      );
  if (platform !== "darwin" && !checkout) {
    return {
      method: `the macOS bundle identifier "${REVIEW_DESKTOP_BUNDLE_ID}"`,
      successfulExitIsExpected: false,
      completion: Promise.reject(
        new Error("automatic launch is available only on macOS"),
      ),
    };
  }

  const command = checkout
    ? "/bin/bash"
    : electron
      ? (input.execPath ?? process.execPath)
      : "/usr/bin/open";
  const env = { ...(input.env ?? process.env) };
  delete env.ELECTRON_RUN_AS_NODE;
  const stateRoot = env.DEV_FAST_REVIEW_DESKTOP_STATE_ROOT?.trim();
  const args = checkout
    ? [checkout]
    : electron
      ? stateRoot
        ? [
            `--user-data-dir=${path.resolve(stateRoot, "user-data")}`,
            `--extensions-dir=${path.resolve(stateRoot, "extensions")}`,
          ]
        : []
      : ["-b", REVIEW_DESKTOP_BUNDLE_ID];
  const method = checkout
    ? `this checkout's Desktop launcher at "${checkout}"`
    : electron
      ? `the Desktop-managed bundle at "${command}"`
      : `the macOS bundle identifier "${REVIEW_DESKTOP_BUNDLE_ID}"`;

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
    successfulExitIsExpected: !electron && !checkout,
    completion,
  };
}

function checkoutLaunchScript(packageRoot: string): string | null {
  const script = path.resolve(
    packageRoot,
    "../../apps/review-desktop/scripts/run.sh",
  );
  return existsSync(script) ? script : null;
}

function launchEvent(
  state: ReviewAppLaunchEvent["state"],
  instanceId: string,
): ReviewAppLaunchEvent {
  return { event: "app", action: "launch", state, instanceId };
}

async function readLaunchHealthyDesktop(
  runtime: Pick<
    ReviewAppLauncherRuntime,
    "readReviewDesktopDiscovery" | "fetch"
  >,
) {
  try {
    return await readHealthyReviewDesktopDiscovery({
      readDiscovery: runtime.readReviewDesktopDiscovery,
      fetch: runtime.fetch,
    });
  } catch {
    // Launch must recover from stale, malformed, and incompatible discovery.
    return null;
  }
}

function launchFailure(method: string, error: Error): Error {
  return new Error(
    `Could not launch Review Desktop with ${method}: ${error.message}. Open Review Desktop once, then run \`review app launch\` again.`,
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
