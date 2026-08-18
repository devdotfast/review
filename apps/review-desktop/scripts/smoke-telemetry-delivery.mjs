/**
 * Proves an error report survives the last leg: the durable queue on disk, the
 * flush, and the HTTP request to the analytics vendor.
 *
 *   node scripts/smoke-telemetry-delivery.mjs [--timeout-ms 120000]
 *
 * Why this is separate from smoke-error-telemetry.mjs. That one runs with
 * DEV_FAST_REVIEW_TELEMETRY_DEBUG=1, and the debug sink PRINTS events instead of
 * sending them. So it proves everything up to the sink and nothing after it: a
 * report could be shaped perfectly and still never leave, or leave with a
 * different payload than the sink displayed.
 *
 * This one sends for real, to a local endpoint standing in for the vendor
 * (PROGRESSIVE_REVIEW_POSTHOG_HOST), and asserts on the exact bytes of the
 * batch request. Nothing reaches the real project.
 *
 * What only this can catch: an event that the queue rejects as unserializable,
 * a property the transport drops on the way, a flush that never runs, and a
 * queue file that is never deleted after a successful send — which would mean
 * the same report is sent again on every launch, forever.
 *
 * Requires a built app. Not part of `pnpm test` — it launches the application.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { chromium } from "playwright";

const APP_DIR = path.resolve(import.meta.dirname, "..");
const SERVER_READY = /\[Review Desktop\] server ready at (https?:\/\/\S+)/;
const POLL_INTERVAL_MS = 500;
// posthog-capture-client.ts waits this long before its first flush.
const FLUSH_WINDOW_MS = 20_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Stands in for the vendor's batch endpoint and records what it receives. */
async function startCaptureEndpoint() {
  const batches = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      batches.push({ url: request.url, body });
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"status":1}');
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    batches,
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
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

export async function smokeTelemetryDelivery({ timeoutMs = 120_000 } = {}) {
  const home = os.homedir();
  const root = await mkdtemp(path.join(os.tmpdir(), "review-delivery-smoke-"));
  // NOT under os.tmpdir(): macOS puts that in /var/folders/<long>/T, and Electron
  // builds a unix socket under the state root whose path must stay within 103
  // characters. Over the limit the app fails to claim its instance and never
  // starts, which reads as "the server never became ready".
  const stateRoot = await mkdtemp("/tmp/rvw-");
  const reviewHome = path.join(root, "home");
  const logPath = path.join(root, "app.log");
  const debugPort = 9500 + Math.floor(process.pid % 300);
  const thrown = `ENOENT: no such file or directory, open '${home}/work/acme-repo/plan.md'`;
  const digest = createHash("sha256")
    .update(thrown, "utf8")
    .digest("hex")
    .slice(0, 16);
  const failures = [];
  const capture = await startCaptureEndpoint();
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
        DEV_REVIEW_HOME: reviewHome,
        DEV_FAST_REVIEW_DESKTOP_STATE_ROOT: stateRoot,
        DEV_FAST_REVIEW_REMOTE_DEBUGGING_PORT: String(debugPort),
        // Send for real, but to us. Note there is deliberately NO
        // DEV_FAST_REVIEW_TELEMETRY_DEBUG here: the sink would suppress the
        // send and this smoke would prove nothing.
        PROGRESSIVE_REVIEW_POSTHOG_HOST: capture.origin,
        PROGRESSIVE_REVIEW_POSTHOG_KEY: "phc_smoke_local_only",
        // The opt-out rules treat a test environment as opted out, and this
        // script may well be run from one.
        NODE_ENV: "development",
        VITEST: undefined,
        DO_NOT_TRACK: undefined,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.pipe(log);
    child.stderr.pipe(log);

    await waitFor(
      async () =>
        SERVER_READY.test(await readFile(logPath, "utf8").catch(() => "")),
      timeoutMs,
      "the embedded Review server to become ready",
    ).catch(async (error) => {
      const log = await readFile(logPath, "utf8").catch(() => "(no log)");
      throw new Error(
        `${error.message}\nLast lines of the app log:\n${log.split("\n").slice(-25).join("\n")}`,
      );
    });
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
      context
        .pages()
        .find((candidate) => candidate.url().includes("workbench")) ??
      context.pages()[0];
    if (!page) throw new Error("The app opened no window to drive.");

    const throwInWindow = (message) =>
      page.evaluate((text) => {
        setTimeout(() => {
          throw new Error(text);
        }, 0);
      }, message);

    // The window installs its error handlers slightly after the debugger
    // accepts a connection, so the probe cannot simply be thrown once and
    // awaited — it can land before anything is listening. Retry a WARM-UP
    // message until it is delivered, which proves the whole path is live, and
    // only then throw the probe exactly once.
    //
    // Throwing the probe itself in the retry loop is what an earlier version
    // did, and it queued several copies of the same report, which then looked
    // like the queue failing to drain. The probe must be thrown once so that
    // "still queued" can only mean the delivered file was not deleted.
    const warmUp = "review telemetry delivery smoke warm-up";
    await waitFor(
      async () => {
        await throwInWindow(warmUp);
        await sleep(2500);
        return capture.batches.some((entry) => entry.body.includes(warmUp));
      },
      FLUSH_WINDOW_MS + timeoutMs,
      "the delivery path to become live",
    );

    await throwInWindow(thrown);
    const batch = await waitFor(
      async () => capture.batches.find((entry) => entry.body.includes(digest)),
      FLUSH_WINDOW_MS,
      "the report to be flushed to the analytics endpoint",
    );
    await browser.close();
    // Give the transport one more flush window: a queue file is deleted after
    // its batch succeeds, so checking immediately can race that delete.
    await sleep(8000);

    if (!batch.url.startsWith("/batch/")) {
      failures.push(`the batch went to ${batch.url}, expected /batch/`);
    }
    const payload = JSON.parse(batch.body);
    const event = payload.batch?.find(
      (entry) => entry.properties?.message_hash === digest,
    );
    if (!event) {
      failures.push("the flushed batch held no report with our digest");
      return { failures, batch, root };
    }
    if (event.event !== "review_client_error") {
      failures.push(`the event was named ${event.event}`);
    }
    if (!payload.api_key) failures.push("the batch carried no api key");
    if (!event.properties?.distinct_id) {
      failures.push("the event carried no installation identifier");
    }
    if (
      event.properties?.message !==
      "ENOENT: no such file or directory, open '<REDACTED: user-file-path>'"
    ) {
      failures.push(
        `the delivered message was ${JSON.stringify(event.properties?.message)}`,
      );
    }
    for (const required of ["error_process", "error_name", "app_version"]) {
      if (!event.properties?.[required]) {
        failures.push(`the delivered event lost ${required}`);
      }
    }

    // The leak check runs on the bytes that actually left the process, which is
    // the only place it finally counts.
    for (const token of [path.basename(home), home, "acme-repo", "/Users"]) {
      if (batch.body.includes(token)) {
        failures.push(`the request body leaked ${JSON.stringify(token)}`);
      }
    }

    // A queue file that survives its own successful send would be re-sent on
    // every launch, forever. Only OUR event is checked: the app emits other
    // telemetry throughout the run, and anything queued in the last few seconds
    // is simply waiting for the next flush, which is not a fault.
    const queueDir = path.join(reviewHome, "telemetry", "events");
    const queued = await readdir(queueDir).catch(() => []);
    const stillQueued = [];
    for (const name of queued.filter((entry) => entry.endsWith(".json"))) {
      const body = await readFile(path.join(queueDir, name), "utf8").catch(
        () => "",
      );
      if (body.includes(digest)) stillQueued.push(name);
    }
    if (stillQueued.length > 0) {
      failures.push(
        `the delivered report is still queued and would be sent again: ${stillQueued.join(", ")}`,
      );
    }

    return {
      failures,
      event,
      batchCount: capture.batches.length,
      otherQueued: queued.length - stillQueued.length,
      root,
    };
  } finally {
    child?.kill("SIGKILL");
    await sleep(1000);
    await capture.close();
    await rm(root, { recursive: true, force: true });
    await rm(stateRoot, { recursive: true, force: true });
  }
}

const { values } = parseArgs({ options: { "timeout-ms": { type: "string" } } });
const result = await smokeTelemetryDelivery({
  timeoutMs: values["timeout-ms"] ? Number(values["timeout-ms"]) : undefined,
});

console.log(`Batches received: ${result.batchCount}`);
console.log(`Other events still awaiting the next flush: ${result.otherQueued}`);
console.log(`Delivered event: ${JSON.stringify(result.event, null, 2)}`);
if (result.failures.length > 0) {
  console.error(`\nFAIL (${result.failures.length}):`);
  for (const failure of result.failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("\nOK: the report reached the analytics endpoint intact and clean.");
