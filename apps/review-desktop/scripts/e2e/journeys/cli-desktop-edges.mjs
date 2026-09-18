/** The CLI against a Desktop that is not where `server.json` says it is: an
 *  incompatible protocol version, an unparseable pointer, an unreachable url
 *  and dead pids, then the launch and the open that must still work once the
 *  pointer is put back. */
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

/** Every message a broken pointer can produce (`desktop-discovery.ts:24`,
 *  `:34`, `:128`); a probe that must reach the Desktop asserts their absence. */
const POINTER_ERRORS =
  /Review Desktop uses protocol|discovery is unreadable|Review Desktop is not ready/;

/** `review info` fails here today for every caller — see "`review info
 *  --review <uuid>` always fails with `Not found.`" in the e2e bugs log. It is
 *  what a probe that got past discovery prints, so the journey uses it as the
 *  marker for "the pointer was accepted". */
const LOOKUP_ERROR = /Not found\./;

const exec = promisify(execFile);

/** The stdout of a process-listing command, with its failures kept apart from
 *  its empty answers. `pgrep` and `ps -p` exit 1 with both streams empty when
 *  nothing (or nothing still alive) matches, which is the answer this journey
 *  wants; every other failure — a rejected flag, an overflowing buffer — would
 *  otherwise be swallowed into "no stray Desktops", which passes the assertions
 *  below for the wrong reason and leaves whatever `app pick` started running.
 *  `why` names the benign reading in the error when one turns out not to be it. */
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

/** Pids of the processes running from an installed Review bundle whose
 *  environment names `home`: everything this journey could have started and
 *  nothing else. The journey's own Desktop is a bundle too, but one built in
 *  this checkout, and another session's Desktop carries another home, so
 *  neither can be mistaken for a process this journey has to clean up. */
async function installedDesktopPids(home) {
  // `open -b dev.fast.review` resolves through LaunchServices, which is free to
  // pick a bundle anywhere; the two filters below are what make this safe, so
  // this one only has to find a Review bundle at all.
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

  // `comm` is the executable path alone. Matching on it rather than on the
  // whole command line is what separates an installed bundle from the one this
  // checkout builds: every one of these processes carries this worktree's path
  // somewhere in its arguments or its environment.
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

  // `ps -E` appends the environment to the command line, for this user's own
  // processes, which is all a launch from this journey can produce.
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

  // `review info` is the CLI's only unconditional discovery read
  // (`review-info.ts:26` → `requireHealthyReviewDesktop`). `review app pick`,
  // which the brief for this journey used, cannot stand in for it:
  // `review-app.ts:49-50` runs the launcher before it reads the pointer and the
  // launcher swallows every discovery error (`review-app-launcher.ts:281-289`),
  // so none of the three messages below can reach a `pick` caller. The last
  // probe in this journey asserts that, and logs it.
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
    // Stopping before the Desktop is the whole point: the CLI must not talk to
    // a Desktop whose protocol it cannot read, and must not launch another one.
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

    // The brief edited `appPid`/`serverPid` here. Liveness is not judged by the
    // pids at all: `readHealthyReviewDesktopDiscovery` only fetches
    // `<url>/health` (`desktop-discovery.ts:97-117`), so an unreachable url is
    // what produces "not ready". Port 9 is the discard port: nothing answers.
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

    // The other half of that reading: pids the pointer claims are dead while
    // the url still answers must not be mistaken for a stale pointer.
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
    // `server.json` is written once on listen and never rewritten, so the same
    // instanceId proves the attached Desktop answered rather than a new one.
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

  // `review app pick` is probed last and against a home of its own: it launches
  // before it reads (`review-app.ts:49-50`), and a Desktop started against
  // ctx.home would take the pointer over from the one this journey is attached
  // to. `open`(1) passes the caller's environment through, so whatever this
  // starts lands in the throwaway home and never near the real `~/.dev`.
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

  // Both background promises capture rather than reject: an unhandled rejection
  // here would take the runner down before `close` ever stops the Desktop, and
  // a watcher that died silently would leave "no stray Desktop was started"
  // resting on a poll loop that stopped polling. Both are asserted below, once
  // the kill loop has had its chance to stop whatever was started.
  let watchError;

  let repairError;

  // Polled while the command runs: whatever it starts can exit on its own
  // before the command returns, and a sighting afterwards would miss it.
  const watch = (async () => {
    while (picking) {
      for (const pid of await stray()) started.add(pid);
      await sleep(250);
    }
  })().catch((error) => {
    watchError = error;
  });

  // What the assertions below rest on. Three seconds in, the unusable pointer
  // is replaced by a working one. Nothing but a CLI still going round the
  // launcher's poll loop (`review-app-launcher.ts:111-148`) can notice that, so
  // a command that goes on to reach a Desktop has shown where it spent those
  // three seconds: waiting for the pointer to fix itself rather than saying a
  // word about it. A command that had reported the pointer would already be
  // gone; one that had read the pointer once and moved on could not have seen
  // the replacement.
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
        // The journey's Desktop already holds this port; a second one on it
        // would die of the collision rather than of anything the CLI did.
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

  // Two positive readings, both of them the launcher: it picked the replaced
  // pointer up and carried on to a Desktop, or it said it could not start one.
  // `killed` is not among them — a command this journey's own timeout stopped
  // has shown nothing.
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
