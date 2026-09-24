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
const argv = process.argv.slice(2);

const ownCliPath = fileURLToPath(import.meta.url);

const delegatedExitCode = await maybeDelegateToDesktopCli(argv);

process.exitCode = delegatedExitCode ?? (await runCli(ownCliPath));

async function runCli(effectivePath: string): Promise<number> {
  if (!supportedNodeRuntime()) {
    process.stderr.write(
      `Whiteboard needs Node.js 24 or newer; found ${process.versions.node}. ` +
        "Update Node, or use the whiteboard command installed by Whiteboard Desktop.\n",
    );

    return 1;
  }

  if (argv[0] === "mcp" && argv[1] === "install-instructions") {
    const { runMcpInstallInstructions } =
      await import("./mcp-install-instructions.js");

    return runMcpInstallInstructions({
      argv: argv.slice(2),
      stdout: process.stdout,
      stderr: process.stderr,
    });
  }

  const { runReviewCli } = await import("./cli-runner.js");

  return runReviewCli({
    argv,
    cliPaths: { requestedPath: ownCliPath, effectivePath },
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

async function maybeDelegateToDesktopCli(
  argv: string[],
): Promise<number | null> {
  const env = process.env;

  if (env.DEV_FAST_REVIEW_CLI_NO_DELEGATE || env.DEV_FAST_REVIEW_CLI_DELEGATED)
    return null;

  // api and mcp are thin HTTP clients whose tool catalog comes from the
  // server, so they cannot skew from it and must not be handed to a bundled
  // CLI that predates them.
  if (
    argv.some(
      (argument) =>
        ["api", "mcp", "server"].includes(argument) ||
        /^--state-dir(?:=|$)/.test(argument),
    ) ||
    env.DEV_REVIEW_SERVER_DIR?.trim()
  )
    return null;
  const ownPath = fileURLToPath(import.meta.url);

  if (!/[\\/]dist[\\/]cli\.js$/.test(ownPath)) return null;

  // This bootstrap runs before the Node floor check, so it cannot import
  // devReviewHome() from @dev.fast/trace-core: that module graph needs a modern
  // Node. Keep this copy in step with devReviewHome().
  const devHome = env.DEV_REVIEW_HOME?.trim()
    ? path.resolve(env.DEV_REVIEW_HOME.trim())
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
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    DEV_FAST_REVIEW_CLI_DELEGATED: "1",
  };

  // The current parser owns verbose diagnostics, including usage errors and
  // help, even when the selected Desktop CLI predates this option.
  const command = argv.filter((argument) => argument !== "--json");

  if (command[0] === "version" && command.includes("--verbose")) {
    return runCli(cliPath);
  }

  if (runtimePath) childEnv.ELECTRON_RUN_AS_NODE = "1";

  const result = spawnSync(
    runtimePath ?? process.execPath,
    [cliPath, ...argv],
    { stdio: "inherit", env: childEnv },
  );

  if (result.signal) {
    process.kill(process.pid, result.signal);

    return 1;
  }

  return result.status ?? 1;
}
