import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);

const e2eDir = path.join(import.meta.dirname, "e2e");

const journeysDir = path.join(e2eDir, "journeys");

const journeyNames = async () =>
  (await readdir(journeysDir))
    .filter((f) => f.endsWith(".mjs"))
    .map((f) => f.slice(0, -4))
    .sort();

test("every journey module exports name, phase and run", async () => {
  const names = await journeyNames();
  assert.ok(names.length >= 3);

  for (const name of names) {
    const journey = await import(path.join(journeysDir, `${name}.mjs`));
    assert.equal(journey.name, name, `${name} name matches basename`);
    assert.ok([1, 2].includes(journey.phase), `${name} declares phase`);
    assert.ok(journey.run instanceof Function, `${name} exports run`);
  }
});

test("run.mjs --list prints journeys without launching anything", async () => {
  const { stdout } = await exec(process.execPath, [
    path.join(e2eDir, "run.mjs"),
    "--list",
  ]);

  assert.deepEqual(
    JSON.parse(stdout).map((j) => j.name),
    await journeyNames(),
  );
});

test("run.mjs rejects an unknown --journey", async () => {
  await assert.rejects(
    exec(process.execPath, [
      path.join(e2eDir, "run.mjs"),
      "--runtime",
      "/nonexistent",
      "--journey",
      "nope",
    ]),
    /unknown journey: nope/,
  );
});
