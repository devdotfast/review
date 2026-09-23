/**
 * Gate between a packaged build and the R2 upload: prove the app opens a window
 * and its embedded Whiteboard server becomes ready. Run from the release workflow
 * after validate-release-artifacts.mjs.
 *
 *   node scripts/smoke-launch-packaged.mjs [--app <path to .app>] [--timeout-ms 45000]
 *
 * Two shipped releases would have been caught here and nowhere else:
 *
 *   0.0.3 — the Whiteboard server died on a missing `tsx` (a devDependency pruned by
 *           `pnpm --prod deploy`), so the window never arrived.
 *   0.0.4 — `main.ts` reached the configuration registry before bootstrapESM(),
 *           throwing `!!! NLS MISSING: 2488 !!!` into an Electron modal that
 *           blocked the main thread forever.
 *
 * Both failed *silently*: helper processes spawn, the dock icon appears, and
 * nothing else ever happens. So silence must never read as success here — the
 * check requires both a renderer process and an authenticated capabilities response from the embedded server, not merely the absence of a crash. An NSAlert-blocked main process
 * cannot create a renderer. A broken runtime can create a renderer but cannot
 * answer a desktop capabilities request.
 */
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { assertNoBlockedWhiteboardRequests } from "./whiteboard-network-policy.mjs";

const APP_DIR = path.resolve(import.meta.dirname, "..");

const PRODUCT_NAME = JSON.parse(
  readFileSync(path.join(APP_DIR, "code-oss", "product.json"), "utf8"),
).nameShort;

const DEFAULT_APP = path.join(
  APP_DIR,
  "VSCode-darwin-arm64",
  `${PRODUCT_NAME}.app`,
);

const POLL_INTERVAL_MS = 500;

/** Probe the private discovery record created by this launch, never another app. */
export async function desktopResponds(discoveryPath, appPid, timeoutMs = 2000) {
  try {
    const discovery = JSON.parse(await readFile(discoveryPath, "utf8"));
    if (
      discovery.appPid !== appPid ||
      typeof discovery.token !== "string" ||
      !discovery.token
    )
      return false;
    const url = new URL(discovery.url);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") return false;
    const response = await fetch(new URL("/sessions-api/capabilities", url), {
      headers: { "x-whiteboard-token": discovery.token },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    return response.ok && (await response.json()).desktopAvailable === true;
  } catch {
    // Discovery, the HTTP listener, and the desktop connection arrive separately.
    return false;
  }
}

const redactTokens = (text) =>
  text.replace(/("token"\s*:\s*")[^"]*/g, "$1[redacted]");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * True once this launch owns a renderer process.
 *
 * Chromium forwards `--user-data-dir` to every child, so the temp directory
 * scopes the match to our instance and cannot collide with a Review the
 * developer happens to be running.
 */
function hasRenderer(userDataDir) {
  try {
    // Match on the directory alone: a pattern starting with "--" would be read
    // as an option by BSD pgrep. The temp path is unique either way.
    const matches = execFileSync(
      "pgrep",
      [process.platform === "linux" ? "-fa" : "-fl", userDataDir],
      {
        encoding: "utf8",
      },
    );

    return matches.split("\n").some((line) => line.includes("--type=renderer"));
  } catch {
    // pgrep exits non-zero when nothing matches.
    return false;
  }
}

/** Read every main log from this fresh profile, oldest first. */
async function readMainLog(userDataDir) {
  const logsRoot = path.join(userDataDir, "logs");
  let sessions;

  try {
    sessions = await readdir(logsRoot, { withFileTypes: true });
  } catch {
    return "";
  }

  const logs = [];

  for (const session of sessions
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))) {
    try {
      logs.push(
        await readFile(path.join(logsRoot, session.name, "main.log"), "utf8"),
      );
    } catch {
      // The session can exist briefly before the main logger creates its file.
    }
  }

  return logs.join("\n");
}

// A healthy cold boot took ~25s on an M-series laptop, so the ceiling is set well
// above that: a hosted runner is slower, and the cost is only paid by a build
// that is already failing.
export async function smokeLaunch({
  app = DEFAULT_APP,
  timeoutMs = 90_000,
} = {}) {
  const applicationName =
    process.platform === "linux"
      ? JSON.parse(
          await readFile(
            path.join(app, "resources", "app", "product.json"),
            "utf8",
          ),
        ).applicationName
      : undefined;

  const binary =
    process.platform === "linux"
      ? path.join(app, applicationName)
      : path.join(app, "Contents", "MacOS", PRODUCT_NAME);

  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "review-smoke-"));

  // A launch that finds a running instance hands its arguments over and exits 0
  // without opening anything. The throwaway user-data-dir is what keeps this a
  // real boot rather than a silent no-op.
  const env = {
    ...process.env,
    ELECTRON_ENABLE_LOGGING: "1",
    DEV_WHITEBOARD_HOME: path.join(userDataDir, "whiteboard-home"),
    DEV_WHITEBOARD_IMPORT_FROM: "none",
  };
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(
    binary,
    [
      `--user-data-dir=${userDataDir}`,
      `--extensions-dir=${path.join(userDataDir, "extensions")}`,
    ],
    {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let output = "";
  let mainLog = "";
  let exited;
  let serverReady = false;
  const discoveryPath = path.join(
    env.DEV_WHITEBOARD_HOME,
    "review-desktop",
    "server.json",
  );
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  child.on("exit", (code, signal) => (exited = { code, signal }));
  child.on("error", (error) => {
    output += error.message;
    exited = { code: null, signal: null };
  });

  const fail = (message) => {
    throw new Error(
      `${message}\n--- app output ---\n${redactTokens(output.trim()) || "(no output)"}` +
        `\n--- main log ---\n${redactTokens(mainLog.trim()) || "(main log not created)"}`,
    );
  };

  try {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      mainLog = await readMainLog(userDataDir);
      const startupOutput = `${output}\n${mainLog}`;
      assertNoBlockedWhiteboardRequests(
        startupOutput.match(/https?:\/\/[^\s"'<>]+/g) ?? [],
      );

      if (exited) {
        fail(
          `packaged app exited early (code=${exited.code} signal=${exited.signal}) ` +
            `before the renderer and Whiteboard server became ready`,
        );
      }

      serverReady = await desktopResponds(
        discoveryPath,
        child.pid,
        Math.max(1, Math.min(2000, deadline - Date.now())),
      );
      if (!exited && hasRenderer(userDataDir) && serverReady) {
        console.log(
          `Packaged app opened a renderer and started the Whiteboard server in ${((timeoutMs - (deadline - Date.now())) / 1000).toFixed(1)}s: ${app}`,
        );

        return;
      }

      await sleep(POLL_INTERVAL_MS);
    }

    mainLog = await readMainLog(userDataDir);

    const missing = [
      !hasRenderer(userDataDir) && "a renderer",
      !serverReady && "an authenticated desktop capabilities response",
    ].filter(Boolean);

    fail(
      `packaged app did not produce ${missing.join(" and ")} within ${timeoutMs}ms.`,
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }

    await closed;
    await rm(userDataDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
}

async function main() {
  const { values } = parseArgs({
    options: { app: { type: "string" }, "timeout-ms": { type: "string" } },
  });

  await smokeLaunch({
    app: values.app ? path.resolve(values.app) : DEFAULT_APP,
    timeoutMs: values["timeout-ms"] ? Number(values["timeout-ms"]) : undefined,
  });
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
