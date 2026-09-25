/** The CLI against a broken instance record: bad protocol, unparseable pointer, unreachable url, dead pids, then the repair. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  readFile,
  readdir,
  readlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  createReview,
  instanceRecordPath,
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
  /Review Desktop uses protocol|discovery is unreadable|is not running\./;

/** A Desktop-side answer: a probe that must stop at the pointer may never produce one. */
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

/** Every running pid mapped to its parent, from `ps` on macOS and Linux. */
async function parentPids() {
  const stdout = await listing(
    "/bin/ps",
    ["-A", "-o", "pid=,ppid="],
    "no process is running",
  );

  const parents = new Map();

  for (const line of stdout.split("\n")) {
    const [, pid, ppid] = line.match(/^\s*(\d+)\s+(\d+)/) ?? [];

    if (pid) parents.set(Number(pid), Number(ppid));
  }

  return parents;
}

/** True when `pid` is the journey's own Desktop or one of its descendants: those are expected, not strays. */
function ownDesktop(pid, parents, desktopPid) {
  for (let at = pid; at > 1; at = parents.get(at) ?? 0)
    if (at === desktopPid) return true;

  return false;
}

/** macOS: pids from an installed Whiteboard bundle whose environment names `home`. */
async function installedMacPids(home) {
  // LaunchServices can pick a bundle anywhere, so this only has to find a bundle; the two filters below narrow it.
  const stdout = await listing(
    "/usr/bin/pgrep",
    ["-f", "(Review|Whiteboard)\\.app/Contents"],
    "no process matches",
  );

  const pids = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (!pids.length) return [];

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

  if (!installed.length) return [];

  // `ps -E` appends the environment, for this user's own processes, which is all this journey can produce.
  const environments = await listing(
    "/bin/ps",
    ["-E", "-ww", "-o", "pid=,command=", "-p", installed.join(",")],
    "every installed-bundle pid has already exited",
  );

  const owned = [];

  const belongs = new RegExp(
    `DEV_REVIEW_HOME=${home.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)}(\\s|$)`,
  );

  for (const line of environments.split("\n")) {
    const [, pid, command] = line.match(/^\s*(\d+)\s+(.*)$/) ?? [];

    if (pid && belongs.test(command)) owned.push(Number(pid));
  }

  return owned;
}

/** Linux: pids whose environment names `home` and whose executable lies outside this checkout, read from /proc. */
async function installedLinuxPids(home) {
  const owned = [];

  for (const entry of await readdir("/proc").catch(() => [])) {
    if (!/^\d+$/.test(entry)) continue;

    // Another user's process, or one that exited mid-scan, is unreadable and cannot be this journey's.
    const environ = await readFile(`/proc/${entry}/environ`, "utf8").catch(
      () => "",
    );

    if (!environ.split("\0").includes(`DEV_REVIEW_HOME=${home}`)) continue;

    const executable = await readlink(`/proc/${entry}/exe`).catch(() => "");

    // The journey's own node children (the CLI, git) carry the home too, so only a Desktop executable counts.
    // Crashpad double-forks away from its Desktop, so ancestry cannot place it; it never opens a window.
    if (
      executable &&
      !executable.startsWith(`${workspace}/`) &&
      path.basename(executable) !== path.basename(process.execPath) &&
      path.basename(executable) !== "chrome_crashpad_handler"
    )
      owned.push(Number(entry));
  }

  return owned;
}

/**
 * Pids of processes from an installed Whiteboard whose environment names `home`, leaving out the journey's own
 * Desktop tree: what this journey could have started. The CLI has no Windows launcher ("automatic launch is
 * available only on macOS and Linux"), so there is nothing to find there.
 */
async function installedDesktopPids(ctx, home) {
  if (process.platform === "win32") return new Set();

  const candidates =
    process.platform === "darwin"
      ? await installedMacPids(home)
      : await installedLinuxPids(home);

  if (!candidates.length) return new Set();

  // A packaged run's own Desktop is an installed bundle with this home, so it is excluded by ancestry, not by path.
  const parents = await parentPids();

  return new Set(
    candidates.filter((pid) => !ownDesktop(pid, parents, ctx.desktopPid())),
  );
}

export async function run(ctx) {
  const review = await createReview(ctx, {
    title: TITLE,
    blocks: orderReviewBlocks,
  });

  const pointer = await instanceRecordPath(ctx.home);

  const original = await readFile(pointer, "utf8");

  // `whiteboard info` is the CLI's only unconditional discovery read; `app pick` launches before it reads and swallows these errors.
  const probe = async (contents) => {
    await writeFile(pointer, contents);

    return ctx.cliRaw(["info", "--session", review.reviewId]);
  };

  const output = (result) => `${result.stdout}${result.stderr}`;

  const NOT_RUNNING =
    /Whiteboard `stable` is not running\. Start it with `whiteboard app launch`, or pick another instance with `whiteboard instances`\. No Whiteboard is running\./;

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
      /Review Desktop discovery is unreadable at .*review-desktop[\\/]instances[\\/].*\.json\./,
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
      NOT_RUNNING,
      `an unreachable Desktop was not reported: ${output(result)}`,
    );
    assert.doesNotMatch(
      output(result),
      LOOKUP_ERROR,
      `an unreachable Desktop still answered: ${output(result)}`,
    );
    ctx.check("a stale pointer tells the user to run whiteboard app launch");

    // The other half: dead pids with a url that still answers must not read as a stale pointer.
    result = await probe(
      JSON.stringify({ ...JSON.parse(original), appPid: 1, serverPid: 1 }),
    );

    assert.doesNotMatch(
      output(result),
      POINTER_ERRORS,
      `dead pids were treated as a broken pointer: ${output(result)}`,
    );

    assert.equal(result.code, 0, `whiteboard info: ${output(result)}`);
    assert.match(
      result.stdout,
      new RegExp(review.reviewId),
      `whiteboard info named no review: ${output(result)}`,
    );
    ctx.check("dead pids in the pointer do not stop the CLI reaching Desktop");

    await writeFile(pointer, original);

    result = await ctx.cliRaw(["app", "launch"]);

    assert.equal(result.code, 0, `app launch: ${output(result)}`);
    assert.match(
      result.stdout,
      /Whiteboard Desktop is already running\./,
      `app launch did not recognise the attached Desktop: ${output(result)}`,
    );
    // The instance record is written once on listen, so the same instanceId proves the attached Desktop answered.
    assert.equal(
      JSON.parse(await readFile(pointer, "utf8")).instanceId,
      ctx.discovery.instanceId,
      "app launch replaced the pointer of the Desktop it was meant to focus",
    );
    assert.deepEqual(
      [...(await installedDesktopPids(ctx, ctx.home))],
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

  // `app pick` would launch a Desktop if it still ignored the pointer, so it gets a home of its own.
  const probeHome = path.join(ctx.root, "pick-probe-home");

  const probePointer = path.join(
    probeHome,
    "review-desktop/instances/stable.json",
  );

  await mkdir(path.dirname(probePointer), { recursive: true });
  await writeFile(
    probePointer,
    JSON.stringify({ ...JSON.parse(original), key: "stable", version: 999 }),
  );

  const stray = async () => [...(await installedDesktopPids(ctx, probeHome))];

  const picked = await ctx.cliRaw(
    ["app", "pick", "--session", review.reviewId],
    ctx.repo,
    {
      timeout: 25000,
      env: {
        HOME: probeHome,
        DEV_REVIEW_HOME: probeHome,
        // The journey's Desktop already holds this port, so a second one would die of the collision, not of the CLI.
        DEV_FAST_REVIEW_REMOTE_DEBUGGING_PORT: "",
      },
    },
  );

  const started = new Set();

  // A launch this command no longer makes can still be in flight, so the window stays open past the exit.
  for (const deadline = Date.now() + 5000; Date.now() < deadline; ) {
    for (const pid of await stray()) started.add(pid);
    await sleep(250);
  }

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
      `could not stop ${alive} started from an installed Whiteboard`,
    );
    await sleep(250);
  }

  assert.notEqual(
    picked.code,
    0,
    `app pick on an unusable pointer exited 0: ${output(picked)}`,
  );
  assert.match(
    picked.stderr,
    /Review Desktop uses protocol 999, but this Review CLI needs protocol 3\./,
    `app pick did not name the protocol mismatch: ${output(picked)}`,
  );
  assert.deepEqual(
    [...started],
    [],
    "app pick started a Desktop although it had the diagnosis in hand",
  );
  ctx.check(
    "app pick names an unusable pointer instead of going to the launcher",
  );
}
