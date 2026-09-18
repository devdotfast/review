/** The CLI against a broken `server.json`: bad protocol, unparseable pointer, unreachable url, dead pids, then the repair. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  createReview,
  orderReviewBlocks,
  pickReview,
  sleep,
  workspace,
} from "../harness.mjs";

export const name = "cli-desktop-edges";

export const phase = 1;

export const options = {};

const TITLE = "Order review";

/** Every message a broken pointer can produce; a probe that must reach the Desktop asserts their absence. */
const POINTER_ERRORS =
  /Review Desktop uses protocol|discovery is unreadable|Review Desktop is not ready/;

/** What a probe that got past discovery prints today, so it marks "the pointer was accepted" (a logged bug). */
const LOOKUP_ERROR = /Not found\./;

const exec = promisify(execFile);

/** The stdout of a process listing, reading only an exit-1 with both streams empty as "nothing matched". */
async function listing(command, args, why) {
  const result = await exec(command, args, {
    maxBuffer: 8 * 1024 * 1024,
  }).catch((error) => {
    if (error.code === 1 && !error.stdout?.trim() && !error.stderr?.trim())
      return { stdout: "" };

    throw new Error(
      `${command} ${args.join(" ")} failed (${why} would have exited 1 in silence): ` +
        `code ${error.code}, ${error.stderr?.trim() || error.message}`,
    );
  });

  return result.stdout;
}

/** Pids of processes from an installed Review bundle whose environment names `home`: what this journey could have started. */
async function installedDesktopPids(home) {
  // LaunchServices can pick a bundle anywhere, so this only has to find a Review bundle; the two filters below narrow it.
  const stdout = await listing(
    "/usr/bin/pgrep",
    ["-f", "Review.app/Contents"],
    "no process matches",
  );

  const pids = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (!pids.length) return new Set();

  // `comm` is the executable path alone, which is what separates an installed bundle from the one this checkout builds.
  const paths = await listing(
    "/bin/ps",
    ["-o", "pid=,comm=", "-p", pids.join(",")],
    "every listed pid has already exited",
  );

  const installed = [];

  for (const line of paths.split("\n")) {
    const [, pid, comm] = line.match(/^\s*(\d+)\s+(.*)$/) ?? [];

    if (
      pid &&
      comm.includes(".app/Contents/MacOS") &&
      !comm.startsWith(`${workspace}/`)
    )
      installed.push(pid);
  }

  if (!installed.length) return new Set();

  // `ps -E` appends the environment, for this user's own processes, which is all this journey can produce.
  const environments = await listing(
    "/bin/ps",
    ["-E", "-ww", "-o", "pid=,command=", "-p", installed.join(",")],
    "every installed-bundle pid has already exited",
  );

  const owned = new Set();

  const belongs = new RegExp(
    `DEV_REVIEW_HOME=${home.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)}(\\s|$)`,
  );

  for (const line of environments.split("\n")) {
    const [, pid, command] = line.match(/^\s*(\d+)\s+(.*)$/) ?? [];

    if (pid && belongs.test(command)) owned.add(Number(pid));
  }

  return owned;
}

export async function run(ctx) {
  const review = await createReview(ctx, {
    title: TITLE,
    blocks: orderReviewBlocks,
  });

  const pointer = path.join(ctx.home, "review-desktop/server.json");

  const original = await readFile(pointer, "utf8");

  // `review info` is the CLI's only unconditional discovery read; `app pick` launches before it reads and swallows these errors.
  const probe = async (contents) => {
    await writeFile(pointer, contents);

    return ctx.cliRaw(["info", "--review", review.reviewId]);
  };

  const output = (result) => `${result.stdout}${result.stderr}`;

  try {
    let result = await probe(
      JSON.stringify({ ...JSON.parse(original), version: 999 }),
    );

    assert.notEqual(
      result.code,
      0,
      `a protocol mismatch exited 0: ${output(result)}`,
    );
    assert.match(
      result.stderr,
      /Review Desktop uses protocol 999, but this Review CLI needs protocol 3\./,
      `a protocol mismatch was not named: ${output(result)}`,
    );
    assert.match(
      result.stderr,
      /Update Review and Review Desktop to compatible versions, then try again\./,
      `a protocol mismatch named no fix: ${output(result)}`,
    );
    // Stopping before the Desktop is the point: no talking to an unreadable protocol, and no second launch.
    assert.doesNotMatch(
      output(result),
      LOOKUP_ERROR,
      `a protocol mismatch still reached the Desktop: ${output(result)}`,
    );
    ctx.check("protocol mismatch names the fix instead of launching");

    result = await probe("{not json");

    assert.notEqual(
      result.code,
      0,
      `a malformed pointer exited 0: ${output(result)}`,
    );
    assert.match(
      result.stderr,
      /Review Desktop discovery is unreadable at .*review-desktop\/server\.json\./,
      `a malformed pointer was not named: ${output(result)}`,
    );
    assert.match(
      result.stderr,
      /Restart Review Desktop and try again\./,
      `a malformed pointer named no fix: ${output(result)}`,
    );
    assert.doesNotMatch(
      output(result),
      LOOKUP_ERROR,
      `a malformed pointer still reached the Desktop: ${output(result)}`,
    );
    ctx.check("a malformed pointer is reported, not ignored");

    // Liveness is judged by fetching `<url>/health`, not by the pids; port 9 is the discard port, so nothing answers.
    result = await probe(
      JSON.stringify({ ...JSON.parse(original), url: "http://127.0.0.1:9" }),
    );

    assert.notEqual(
      result.code,
      0,
      `an unreachable Desktop exited 0: ${output(result)}`,
    );
    assert.match(
      result.stderr,
      /Review Desktop is not ready\. Run `review app launch`, then retry `review info`\./,
      `an unreachable Desktop was not reported: ${output(result)}`,
    );
    assert.doesNotMatch(
      output(result),
      LOOKUP_ERROR,
      `an unreachable Desktop still answered: ${output(result)}`,
    );
    ctx.check("a stale pointer tells the user to run review app launch");

    // The other half: dead pids with a url that still answers must not read as a stale pointer.
    result = await probe(
      JSON.stringify({ ...JSON.parse(original), appPid: 1, serverPid: 1 }),
    );

    assert.doesNotMatch(
      output(result),
      POINTER_ERRORS,
      `dead pids were treated as a broken pointer: ${output(result)}`,
    );

    if (result.code === 0) {
      assert.match(
        result.stdout,
        new RegExp(review.reviewId),
        `review info named no review: ${output(result)}`,
      );
      ctx.check(
        "dead pids in the pointer do not stop the CLI reaching Desktop",
      );
    } else {
      // Only the logged bug may pass; any other failure is a new one.
      assert.match(
        output(result),
        LOOKUP_ERROR,
        `review info failed for an unlogged reason: ${output(result)}`,
      );
      await ctx.knownBug(
        "`review info --review <uuid>` always fails with `Not found.`",
      );
      ctx.check(
        "dead pids in the pointer do not stop the CLI reaching Desktop " +
          "(which then fails on its own known bug)",
      );
    }

    await writeFile(pointer, original);

    result = await ctx.cliRaw(["app", "launch"]);

    assert.equal(result.code, 0, `app launch: ${output(result)}`);
    assert.match(
      result.stdout,
      /Review Desktop is already running\./,
      `app launch did not recognise the attached Desktop: ${output(result)}`,
    );
    // `server.json` is written once on listen, so the same instanceId proves the attached Desktop answered.
    assert.equal(
      JSON.parse(await readFile(pointer, "utf8")).instanceId,
      ctx.discovery.instanceId,
      "app launch replaced the pointer of the Desktop it was meant to focus",
    );
    assert.deepEqual(
      [...(await installedDesktopPids(ctx.home))],
      [],
      "app launch started a Desktop from /Applications although one was attached",
    );
    await pickReview(ctx, review.reviewId);
    await review.canvas
      .getByRole("heading", { name: TITLE, exact: true })
      .waitFor();
    ctx.check("app launch with Desktop already running is idempotent");
  } finally {
    await writeFile(pointer, original);
  }

  // `app pick` launches before it reads, so it gets a home of its own rather than take this journey's pointer over.
  const probeHome = path.join(ctx.root, "pick-probe-home");

  const probePointer = path.join(probeHome, "review-desktop/server.json");

  await mkdir(path.dirname(probePointer), { recursive: true });
  await writeFile(
    probePointer,
    JSON.stringify({ ...JSON.parse(original), version: 999 }),
  );

  const stray = async () => [...(await installedDesktopPids(probeHome))];

  const started = new Set();

  let picking = true;

  // Both background promises capture rather than reject: an unhandled rejection would kill the runner before `close` runs.
  let watchError;

  let repairError;

  // Polled while the command runs: whatever it starts can exit before the command returns.
  const watch = (async () => {
    while (picking) {
      for (const pid of await stray()) started.add(pid);
      await sleep(250);
    }
  })().catch((error) => {
    watchError = error;
  });

  // Three seconds in the unusable pointer is repaired; only a CLI still in the launcher's poll loop can notice that.
  const repair = (async () => {
    await sleep(3000);

    if (picking) await writeFile(probePointer, original);
  })().catch((error) => {
    repairError = error;
  });

  const picked = await ctx
    .cliRaw(["app", "pick", "--review", review.reviewId], ctx.repo, {
      timeout: 25000,
      env: {
        HOME: probeHome,
        DEV_REVIEW_HOME: probeHome,
        // The journey's Desktop already holds this port, so a second one would die of the collision, not of the CLI.
        DEV_FAST_REVIEW_REMOTE_DEBUGGING_PORT: "",
      },
    })
    .finally(() => {
      picking = false;
    });

  await watch;
  await repair;

  // Killed before anything is asserted so a failure cannot leave a stray app.
  const killDeadline = Date.now() + 30000;

  for (let alive = await stray(); alive.length; alive = await stray()) {
    for (const pid of alive) {
      started.add(pid);

      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* Already gone. */
      }
    }

    assert.ok(
      Date.now() < killDeadline,
      `could not stop ${alive} started from an installed Review bundle`,
    );
    await sleep(250);
  }

  assert.equal(
    watchError,
    undefined,
    `the stray-Desktop watcher failed, so nothing below knows what app pick started: ${watchError?.message}`,
  );
  assert.equal(
    repairError,
    undefined,
    `the probe pointer was never repaired, so app pick was never given a usable one: ${repairError?.message}`,
  );
  assert.doesNotMatch(
    output(picked),
    POINTER_ERRORS,
    `app pick reported the pointer error after all: ${output(picked)}`,
  );

  // Two positive readings, both the launcher; `killed` is not one, since a command this timeout stopped has shown nothing.
  const wentToTheLauncher =
    /Could not launch Review Desktop/.test(output(picked)) ||
    (!picked.killed &&
      /Review Desktop is showing|Review or version not found\.|Not found\./.test(
        output(picked),
      ));

  assert.ok(
    wentToTheLauncher,
    "app pick neither reported the pointer error nor went to the launcher, " +
      `so this journey no longer knows what it did: ${output(picked)}`,
  );
  await ctx.knownBug(
    "`review app pick` goes to the launcher instead of reporting an unusable pointer",
  );
  ctx.check(
    "app pick waits in the launcher instead of naming a protocol mismatch" +
      `${started.size ? ", and starts a Desktop of its own" : ""} (known bug)`,
  );
}
