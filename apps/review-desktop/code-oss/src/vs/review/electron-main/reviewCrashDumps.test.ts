/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { planCrashDumps, ReviewCrashDumps, type ReviewCrashDumpsOptions } from "./reviewCrashDumps.js";

const DAY = 24 * 60 * 60 * 1000;
const now = 100 * DAY;
const dump = (file: string, mtime: number) => ({ path: file, mtime, bytes: 10 });

test("reports new dumps, discards uploaded and stale ones", () => {
  const plan = planCrashDumps({
    dumps: [dump("/d/a.dmp", now - 1000), dump("/d/old.dmp", now - 8 * DAY), dump("/d/done.dmp", now - 2000)],
    ledger: { uploaded: ["/d/done.dmp"], liveCrashesAt: [] },
    now,
  });
  assert.deepEqual(plan.report.map((d) => d.path), ["/d/a.dmp"]);
  assert.deepEqual(plan.discard.map((d) => d.path), ["/d/old.dmp", "/d/done.dmp"]);
});

test("marks a dump covered when a live crash was recorded within ten seconds", () => {
  const plan = planCrashDumps({
    dumps: [dump("/d/a.dmp", now - 1000), dump("/d/b.dmp", now - 60_000)],
    ledger: { uploaded: [], liveCrashesAt: [now - 4000] },
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

function setup(dir: string, options: Partial<ReviewCrashDumpsOptions> = {}) {
  const captured: Array<[string, Record<string, string | number | boolean>]> = [];
  const posted: Array<{ url: string; body: unknown; token: string | null }> = [];
  const dumps = new ReviewCrashDumps({
    dumpsDir: dir,
    whenConnected: async () => ({ url: "http://127.0.0.1:1", token: "t" }),
    isTelemetryEnabled: () => true,
    capture: (name, properties) => captured.push([name, properties]),
    fetchImpl: async (url, init) => {
      posted.push({ url: String(url), body: JSON.parse(String(init?.body)), token: new Headers(init?.headers).get("x-review-token") });
      return new Response("{}", { status: 200 });
    },
    ...options,
  });
  return { captured, posted, dumps };
}

test("deletes dumps without reporting when telemetry is off", async () => {
  const dir = dumpsDir();
  const { captured, dumps } = setup(dir, {
    whenConnected: async () => { throw new Error("must not connect"); },
    isTelemetryEnabled: () => false,
  });
  await dumps.reconcile();
  assert.deepEqual(captured, []);
  assert.deepEqual(fs.readdirSync(path.join(dir, "completed")), ["x.meta"]);
});

test("counts and uploads a new dump through the server, then deletes it", async () => {
  const dir = dumpsDir();
  const { captured, posted, dumps } = setup(dir);
  const crashedAt = Math.round(fs.statSync(path.join(dir, "completed", "x.dmp")).mtimeMs);
  await dumps.reconcile();
  assert.deepEqual(captured, [["crash", { process: "unknown", reason: "minidump", source: "minidump" }]]);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].url, "http://127.0.0.1:1/crash-reports");
  assert.equal(posted[0].token, "t");
  assert.deepEqual(posted[0].body, {
    dump_path: path.join(dir, "completed", "x.dmp"),
    crashed_at: crashedAt,
    covered: false,
  });
  assert.deepEqual(fs.readdirSync(path.join(dir, "completed")), ["x.meta"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "ledger.json"), "utf8")).uploaded.length, 1);
});

test("does not count a dump a live crash already counted", async () => {
  const dir = dumpsDir();
  const first = setup(dir);
  first.dumps.recordLiveCrash(Date.now());
  const { captured, posted, dumps } = setup(dir);
  await dumps.reconcile();
  assert.deepEqual(captured, []);
  assert.equal((posted[0].body as { covered: boolean }).covered, true);
});

test("keeps a dump whose upload failed, and does not count it twice on retry", async () => {
  const dir = dumpsDir();
  const failing = setup(dir, { fetchImpl: async () => new Response("slow down", { status: 429 }) });
  await failing.dumps.reconcile();
  assert.deepEqual(fs.readdirSync(path.join(dir, "completed")).sort(), ["x.dmp", "x.meta"]);
  assert.equal(failing.captured.length, 1);

  const retry = setup(dir);
  await retry.dumps.reconcile();
  assert.deepEqual(retry.captured, []);
  assert.equal(retry.posted.length, 1);
  assert.deepEqual(fs.readdirSync(path.join(dir, "completed")), ["x.meta"]);
});
