/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { launchOfDump, planCrashDumps, ReviewCrashDumps, type ReviewCrashDumpsOptions } from "./reviewCrashDumps.js";

const DAY = 24 * 60 * 60 * 1000;
const now = 100 * DAY;
const dump = (file: string, mtime: number) => ({ path: file, mtime, bytes: 10 });

test("reports new dumps, discards uploaded and stale ones", () => {
  const plan = planCrashDumps({
    dumps: [dump("/d/a.dmp", now - 1000), dump("/d/old.dmp", now - 8 * DAY), dump("/d/done.dmp", now - 2000)],
    ledger: { uploaded: ["/d/done.dmp"], liveCrashesAt: [], launches: [] },
    now,
  });
  assert.deepEqual(plan.report.map((d) => d.path), ["/d/a.dmp"]);
  assert.deepEqual(plan.discard.map((d) => d.path), ["/d/old.dmp", "/d/done.dmp"]);
});

test("marks a dump covered when a live crash was recorded within ten seconds", () => {
  const plan = planCrashDumps({
    dumps: [dump("/d/a.dmp", now - 1000), dump("/d/b.dmp", now - 60_000)],
    ledger: { uploaded: [], liveCrashesAt: [now - 4000], launches: [] },
    now,
  });
  assert.deepEqual(plan.report.map((d) => [d.path, d.covered]), [["/d/a.dmp", true], ["/d/b.dmp", false]]);
});

function dumpsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-crashes-"));
  fs.mkdirSync(path.join(dir, "completed"));
  fs.writeFileSync(path.join(dir, "completed", "x.dmp"), "MDMP");
  fs.writeFileSync(path.join(dir, "completed", "x.meta"), "not a dump");
  return dir;
}

const LATER = Date.now() + DAY;

interface Posted {
  readonly url: string;
  readonly token: string | null;
  readonly body: { dump_path: string; crashed_at: number; covered: boolean; launch?: Record<string, string> };
}

/** A /crash-reports stand-in: counts what is not covered, answers with `status`. */
function setup(dir: string, options: Partial<ReviewCrashDumpsOptions> = {}, status = 200) {
  const posted: Posted[] = [];
  const dumps = new ReviewCrashDumps({
    dumpsDir: dir,
    launch: { startedAt: LATER, appSessionId: "current-launch", appVersion: "0.0.36" },
    whenConnected: async () => ({ url: "http://127.0.0.1:1", token: "t", cliVersion: "0.0.36" }),
    isTelemetryEnabled: () => true,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(String(init?.body)) as Posted["body"];
      posted.push({ url: String(url), token: new Headers(init?.headers).get("x-review-token"), body });
      return Response.json({ ok: status === 200, counted: !body.covered }, { status });
    },
    ...options,
  });
  return { posted, dumps };
}

const ledger = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, "ledger.json"), "utf8"));

test("picks the latest launch that started before the dump was written", () => {
  const launches = [
    { startedAt: 100, appSessionId: "a", appVersion: "1" },
    { startedAt: 300, appSessionId: "c", appVersion: "3" },
    { startedAt: 200, appSessionId: "b", appVersion: "2" },
  ];
  assert.equal(launchOfDump(launches, 250)?.appSessionId, "b");
  assert.equal(launchOfDump(launches, 300)?.appSessionId, "c");
  assert.equal(launchOfDump(launches, 50), undefined);
});

test("deletes dumps without reporting when telemetry is off", async () => {
  const dir = dumpsDir();
  const { posted, dumps } = setup(dir, {
    whenConnected: async () => { throw new Error("must not connect"); },
    isTelemetryEnabled: () => false,
  });
  await dumps.reconcile();
  assert.deepEqual(posted, []);
  assert.deepEqual(fs.readdirSync(path.join(dir, "completed")), ["x.meta"]);
});

test("reports a dump as the earlier launch that wrote it, then deletes it", async () => {
  const dir = dumpsDir();
  const crashedAt = Math.round(fs.statSync(path.join(dir, "completed", "x.dmp")).mtimeMs);
  fs.writeFileSync(path.join(dir, "ledger.json"), JSON.stringify({
    uploaded: [],
    liveCrashesAt: [],
    launches: [{ startedAt: crashedAt - 60_000, appSessionId: "old-launch", appVersion: "0.0.35", cliVersion: "0.0.34" }],
  }));
  const { posted, dumps } = setup(dir);
  await dumps.reconcile();
  assert.equal(posted.length, 1);
  assert.equal(posted[0].url, "http://127.0.0.1:1/crash-reports");
  assert.equal(posted[0].token, "t");
  assert.deepEqual(posted[0].body, {
    dump_path: path.join(dir, "completed", "x.dmp"),
    crashed_at: crashedAt,
    covered: false,
    launch: { app_session_id: "old-launch", app_version: "0.0.35", cli_version: "0.0.34" },
  });
  assert.deepEqual(fs.readdirSync(path.join(dir, "completed")), ["x.meta"]);
  assert.equal(ledger(dir).uploaded.length, 1);
  assert.deepEqual(ledger(dir).launches.map((launch: { appSessionId: string }) => launch.appSessionId), ["old-launch", "current-launch"]);
  assert.equal(ledger(dir).launches[1].cliVersion, "0.0.36");
});

test("sends no launch for a dump older than every recorded launch", async () => {
  const dir = dumpsDir();
  const { posted, dumps } = setup(dir);
  await dumps.reconcile();
  assert.equal(posted[0].body.launch, undefined);
});

test("keeps only the last ten launches", () => {
  const dir = dumpsDir();
  for (let launch = 0; launch < 12; launch++) {
    setup(dir, { launch: { startedAt: launch, appSessionId: `launch-${launch}`, appVersion: "0.0.36" } });
  }
  const launches = ledger(dir).launches.map((launch: { appSessionId: string }) => launch.appSessionId);
  assert.equal(launches.length, 10);
  assert.equal(launches[9], "launch-11");
});

test("marks a dump a live crash already counted as covered", async () => {
  const dir = dumpsDir();
  const first = setup(dir);
  first.dumps.recordLiveCrash(Date.now());
  const { posted, dumps } = setup(dir);
  await dumps.reconcile();
  assert.equal(posted[0].body.covered, true);
});

test("keeps a dump whose upload failed, and does not count it twice on retry", async () => {
  const dir = dumpsDir();
  const failing = setup(dir, {}, 429);
  await failing.dumps.reconcile();
  assert.deepEqual(fs.readdirSync(path.join(dir, "completed")).sort(), ["x.dmp", "x.meta"]);
  assert.equal(failing.posted[0].body.covered, false);

  const retry = setup(dir);
  await retry.dumps.reconcile();
  assert.equal(retry.posted[0].body.covered, true);
  assert.deepEqual(fs.readdirSync(path.join(dir, "completed")), ["x.meta"]);
});

test("deletes a dump the Worker can never accept", async () => {
  const dir = dumpsDir();
  const { dumps } = setup(dir, {}, 413);
  await dumps.reconcile();
  assert.deepEqual(fs.readdirSync(path.join(dir, "completed")), ["x.meta"]);
  assert.equal(ledger(dir).uploaded.length, 0);
});
