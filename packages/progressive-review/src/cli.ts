#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  jsonObject,
  jsonString,
  parseJsonText,
} from "@dev.fast/review-protocol";

// A standalone build (npx/global install) defers to the CLI bundled with a
// running Review Desktop so the CLI can never skew from the server it talks
// to. Checkout runs execute src/cli.ts via tsx and therefore never delegate.
// Delegation runs before the Node floor check on purpose: the app's
// Electron-as-Node runtime can rescue a machine whose system Node is too old.
const delegatedExitCode = maybeDelegateToDesktopCli(process.argv.slice(2));
if (delegatedExitCode !== null) {
  process.exitCode = delegatedExitCode;
} else if (!supportedNodeRuntime()) {
  process.stderr.write(
    `Review needs Node.js 24 or newer; found ${process.versions.node}. ` +
      "Update Node, or use the review command installed by Review Desktop.\n",
  );
  process.exitCode = 1;
} else {
  const { runProgressiveReviewCli } = await import("./cli-runner.js");

  process.exitCode = await runProgressiveReviewCli({
    argv: process.argv.slice(2),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}

// An Electron-as-Node runtime (the app's) is trusted as-is: it is the same
// runtime the Review server runs on. Only a system Node gets the floor check,
// so an old `node` fails with an instruction instead of a syntax or
// missing-builtin crash deeper in.
function supportedNodeRuntime(): boolean {
  if (process.versions.electron) return true;
  return Number(process.versions.node.split(".")[0]) >= 24;
}

function maybeDelegateToDesktopCli(argv: string[]): number | null {
  const env = process.env;
  if (env.DEV_FAST_REVIEW_CLI_NO_DELEGATE || env.DEV_FAST_REVIEW_CLI_DELEGATED)
    return null;
  // stop-hook runs on every agent stop and must not pay a discovery read plus
  // a second node spawn; internal-test must exercise this entry, not the
  // app's.
  if (
    argv[0] === "stop-hook" ||
    argv[0] === "internal-test" ||
    argv[0] === "wait-codex" ||
    argv[0] === "prepare-worktree"
  )
    return null;
  const ownPath = fileURLToPath(import.meta.url);
  if (!/[\\/]dist[\\/]cli\.js$/.test(ownPath)) return null;
  const devHome = env.DEV_REVIEW_HOME?.trim()
    ? path.resolve(env.DEV_REVIEW_HOME)
    : path.join(os.homedir(), ".dev");
  let cliPath: string;
  let runtimePath: string | undefined;
  try {
    const discovery = jsonObject(
      parseJsonText(
        readFileSync(
          path.join(devHome, "review-desktop", "server.json"),
          "utf8",
        ),
      ),
    );
    const discoveredCliPath = jsonString(discovery?.cliPath);
    if (!discoveredCliPath) return null;
    cliPath = discoveredCliPath;
    const discoveredRuntimePath = jsonString(discovery?.cliRuntimePath);
    if (discoveredRuntimePath && existsSync(discoveredRuntimePath)) {
      runtimePath = discoveredRuntimePath;
    }
  } catch {
    return null;
  }
  try {
    if (realpathSync(cliPath) === realpathSync(ownPath)) return null;
  } catch {
    return null;
  }
  // Prefer the app's Electron-as-Node runtime: it matches the server exactly
  // and works even when this process runs on an older system Node.
  const result = spawnSync(
    runtimePath ?? process.execPath,
    [cliPath, ...argv],
    {
      stdio: "inherit",
      env: {
        ...env,
        DEV_FAST_REVIEW_CLI_DELEGATED: "1",
        ...(runtimePath ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      },
    },
  );
  if (result.signal) {
    process.kill(process.pid, result.signal);
    return 1;
  }
  return result.status ?? 1;
}
