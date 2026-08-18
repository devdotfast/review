/**
 * Proves, against a running app, that an error report reaches PostHog's queue
 * carrying useful text and carrying nothing of the user's.
 *
 *   node scripts/smoke-error-telemetry.mjs [--timeout-ms 120000] [--keep-log]
 *
 * Why this exists rather than only unit tests. The redaction is four layers —
 * the reporter packs the error, the loopback route hands it over, the server
 * cleans it, and the event allowlist re-checks the result — and each layer is
 * unit tested in isolation. What no unit test can show is that they are wired
 * to each other in the shipped build. During development of this feature the
 * live run caught two faults the unit tests could not:
 *
 *   1. VS Code's cleaner, configured the way VS Code configures it, deletes a
 *      known directory as a prefix. A path under the user's home directory then
 *      kept the rest — "/Users/you/work/acme-repo/plan.md" was cleaned to
 *      "/work/acme-repo/plan.md", repository name intact.
 *   2. The probe only revealed it because it used a real path under the real
 *      home directory. A fixture path would have passed.
 *
 * So this smoke deliberately builds its probes from `os.homedir()` rather than
 * from a literal, and asserts on the real user name of whoever runs it.
 *
 * Silence must never read as success: the run fails if no report arrives at
 * all, which is what a broken loopback route or a dead reporter looks like.
 *
 * Requires a built app (`pnpm --filter @dev-fast/review-desktop app:build`).
 * Not part of `pnpm test` — it launches the application.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { chromium } from "playwright";

const APP_DIR = path.resolve(import.meta.dirname, "..");
const TELEMETRY_PREFIX = "[review-telemetry]";
const SERVER_READY = /\[Review Desktop\] server ready at (https?:\/\/\S+)/;
const POLL_INTERVAL_MS = 500;

/** Tokens that must never appear in any reported event, built from this machine. */
function leakTokens(home) {
  const user = path.basename(home);
  return [user, home, "/Users", "acme-repo", "fix-oops", "hunter2"];
}

/**
 * Each case: what the app throws, and the exact message the report must carry.
 *
 * Reports are matched to cases by the digest of the message that was thrown,
 * not by arrival order. Order matching looked simpler until a run lost one
 * report and every later case failed against its neighbour's result, turning
 * one fault into six. `match` names the digest source; the engine case cannot
 * use one because the wording belongs to the JavaScript engine, so it is found
 * by its error class instead.
 */
function cases(home) {
  return [
    {
      name: "engine error keeps its message",
      throws: () => {
        const missing = undefined;
        return missing.uri;
      },
      match: { errorName: "TypeError" },
      expected: "Cannot read properties of undefined (reading 'uri')",
    },
    {
      name: "a path under the real home directory is replaced whole",
      throws: `ENOENT: no such file or directory, open '${home}/work/acme-repo/plan.md'`,
      match: { hashOf: `ENOENT: no such file or directory, open '${home}/work/acme-repo/plan.md'` },
      expected:
        "ENOENT: no such file or directory, open '<REDACTED: user-file-path>'",
    },
    {
      name: "an e-mail address is replaced",
      throws: "no account for someone@example.com",
      match: { hashOf: "no account for someone@example.com" },
      expected: "<REDACTED: Email>",
    },
    {
      name: "a token is replaced",
      throws: "rejected credential ghp_012345678901234567890123456789012345",
      match: { hashOf: "rejected credential ghp_012345678901234567890123456789012345" },
      expected: "<REDACTED: GitHub Token>",
    },
    {
      name: "a password is replaced",
      throws: "connect failed: password=hunter2",
      match: { hashOf: "connect failed: password=hunter2" },
      expected: "<REDACTED: Generic Secret>",
    },
    {
      name: "a rejected promise is reported too",
      rejects: "the review request did not complete",
      match: { hashOf: "the review request did not complete" },
      expected: "the review request did not complete",
    },
  ];
}

/** Must match hashErrorMessage in packages/progressive-review/src/error-telemetry.ts. */
function digestOf(message) {
  return createHash("sha256").update(message, "utf8").digest("hex").slice(0, 16);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every telemetry event the embedded server printed to the debug sink. */
async function readSentEvents(logPath) {
  let log;
  try {
    log = await readFile(logPath, "utf8");
  } catch {
    return [];
  }
  const events = [];
  for (const line of log.split("\n")) {
    const at = line.indexOf(TELEMETRY_PREFIX);
    if (at < 0) continue;
    try {
      events.push(JSON.parse(line.slice(at + TELEMETRY_PREFIX.length).trim()));
    } catch {
      // A partially flushed line; the next poll sees it whole.
    }
  }
  return events;
}

async function waitFor(check, timeoutMs, describe) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${describe}.`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

export async function smokeErrorTelemetry({
  timeoutMs = 120_000,
  keepLog = false,
} = {}) {
  const home = os.homedir();
  const root = await mkdtemp(path.join(os.tmpdir(), "review-tel-smoke-"));
  // NOT under os.tmpdir(): macOS puts that in /var/folders/<long>/T, and
  // Electron builds a unix socket under the state root whose path must stay
  // within 103 characters. Over the limit the app never claims its instance
  // and never starts, which reads as "the server never became ready".
  const stateRoot = await mkdtemp("/tmp/rvw-");
  const logPath = path.join(root, "app.log");
  const debugPort = 9200 + Math.floor(process.pid % 300);
  const probes = cases(home);
  const failures = [];
  let child;

  try {
    const log = await import("node:fs").then(({ createWriteStream }) =>
      createWriteStream(logPath),
    );
    child = spawn("bash", [path.join(APP_DIR, "scripts", "run.sh")], {
      cwd: APP_DIR,
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        // Isolate completely: a shared review home would publish into the
        // developer's real store, and a shared state root hands the launch to
        // an already-running Review instead of booting one.
        DEV_REVIEW_HOME: path.join(root, "home"),
        DEV_FAST_REVIEW_DESKTOP_STATE_ROOT: stateRoot,
        // Print events instead of sending them to the vendor.
        DEV_FAST_REVIEW_TELEMETRY_DEBUG: "1",
        DEV_FAST_REVIEW_REMOTE_DEBUGGING_PORT: String(debugPort),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.pipe(log);
    child.stderr.pipe(log);

    await waitFor(
      async () => SERVER_READY.test(await readFile(logPath, "utf8").catch(() => "")),
      timeoutMs,
      "the embedded Review server to become ready",
    );
    const browser = await waitFor(
      () =>
        chromium
          .connectOverCDP(`http://127.0.0.1:${debugPort}`)
          .catch(() => undefined),
      timeoutMs,
      "the renderer to accept a debugger connection",
    );

    const context = browser.contexts()[0];
    const page =
      context.pages().find((candidate) => candidate.url().includes("workbench")) ??
      context.pages()[0];
    if (!page) throw new Error("The app opened no window to drive.");

    // The debugger accepts a connection before the window installs its error
    // handlers, so the first probe can be thrown into a window that is not
    // listening yet and simply vanish. Throw a warm-up error and wait for it to
    // come back; only then is the window known to be reporting. Without this
    // the run is flaky, and a flaky privacy check is one people learn to ignore.
    const warmUp = "review error telemetry smoke warm-up";
    await waitFor(
      async () => {
        await page.evaluate((message) => {
          setTimeout(() => {
            throw new Error(message);
          }, 0);
        }, warmUp);
        await sleep(1200);
        const sent = await readSentEvents(logPath);
        return sent.some(
          (event) => event.properties?.message_hash === digestOf(warmUp),
        );
      },
      timeoutMs,
      "the window to start reporting errors",
    );
    const warmUpCount = (await readSentEvents(logPath)).length;

    for (const probe of probes) {
      // Each error is thrown from a timer so it reaches the window's own
      // handlers exactly as a real fault would, rather than returning to the
      // debugger as a rejected evaluation.
      if (probe.rejects) {
        await page.evaluate((message) => {
          setTimeout(() => void Promise.reject(new Error(message)), 0);
        }, probe.rejects);
      } else if (typeof probe.throws === "string") {
        await page.evaluate((message) => {
          setTimeout(() => {
            throw new Error(message);
          }, 0);
        }, probe.throws);
      } else {
        await page.evaluate(`setTimeout(() => { (${probe.throws})(); }, 0)`);
      }
      // The window drops a repeat of the same message inside one second.
      await sleep(1200);
    }
    await browser.close();

    // Only the reports raised after the warm-up belong to the probes.
    const reportsSinceWarmUp = async () =>
      (await readSentEvents(logPath))
        .slice(warmUpCount)
        .filter((event) => event.event === "review_client_error");

    const events = await waitFor(
      async () => {
        const sent = await reportsSinceWarmUp();
        return sent.length >= probes.length ? sent : undefined;
      },
      30_000,
      `all ${probes.length} error reports to reach the server`,
    ).catch(async (error) => {
      const sent = await reportsSinceWarmUp();
      failures.push(
        `${error.message} Only ${sent.length} of ${probes.length} arrived.`,
      );
      return sent;
    });

    for (const probe of probes) {
      const report = events.find((event) =>
        probe.match.errorName
          ? event.properties?.error_name === probe.match.errorName
          : event.properties?.message_hash === digestOf(probe.match.hashOf),
      );
      if (!report) {
        failures.push(`${probe.name}: no report arrived for it`);
        continue;
      }
      const message = report.properties?.message;
      if (message !== probe.expected) {
        failures.push(
          `${probe.name}: expected ${JSON.stringify(probe.expected)}, got ${JSON.stringify(message)}`,
        );
      }
    }

    // The blanket check. Every event, every property, no exceptions.
    const serialized = JSON.stringify(events);
    for (const token of leakTokens(home)) {
      if (serialized.includes(token)) {
        failures.push(`a report leaked ${JSON.stringify(token)}`);
      }
    }

    // Every report must still carry the fields that make it useful.
    for (const event of events) {
      const { error_process, error_name, message_hash } = event.properties ?? {};
      if (!error_process || !error_name || !message_hash) {
        failures.push(
          `a report was missing its identifying fields: ${JSON.stringify(event.properties)}`,
        );
      }
    }

    return { events, failures, logPath };
  } finally {
    child?.kill("SIGKILL");
    await sleep(1000);
    await rm(stateRoot, { recursive: true, force: true });
    if (!keepLog) await rm(root, { recursive: true, force: true });
  }
}

const { values } = parseArgs({
  options: {
    "timeout-ms": { type: "string" },
    "keep-log": { type: "boolean" },
  },
});

const result = await smokeErrorTelemetry({
  timeoutMs: values["timeout-ms"] ? Number(values["timeout-ms"]) : undefined,
  keepLog: values["keep-log"] ?? false,
});

console.log(`Reports received: ${result.events.length}`);
for (const event of result.events) {
  console.log(
    `  ${event.properties?.error_process}/${event.properties?.error_name}: ${JSON.stringify(event.properties?.message)}`,
  );
}
if (result.failures.length > 0) {
  console.error(`\nFAIL (${result.failures.length}):`);
  for (const failure of result.failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("\nOK: every report carried usable text and no user content.");
