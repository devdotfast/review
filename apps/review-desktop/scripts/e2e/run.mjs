/** Runs each journeys/*.mjs against its own Desktop and temp home; see TESTING.md. */
import { readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const journeysDir = path.join(import.meta.dirname, "journeys");

const { values } = parseArgs({
  options: {
    runtime: { type: "string" },
    app: { type: "string" },
    keep: { type: "boolean", default: false },
    journey: { type: "string" },
    list: { type: "boolean", default: false },
  },
});

const journeys = [];

for (const file of (await readdir(journeysDir))
  .filter((f) => f.endsWith(".mjs"))
  .sort())
  journeys.push(await import(path.join(journeysDir, file)));

if (values.list) {
  console.log(
    JSON.stringify(journeys.map(({ name, phase }) => ({ name, phase }))),
  );
  process.exit(0);
}

const selected = values.journey
  ? values.journey.split(",").map((name) => {
      const found = journeys.find((j) => j.name === name);

      if (!found) throw new Error(`unknown journey: ${name}`);

      return found;
    })
  : journeys.filter(
      (j) => j.phase === 1 || process.env.REVIEW_E2E_NETWORK === "1",
    );

if (!values.runtime)
  throw new Error("--runtime must name a production-installed Review package");

const runtime = await realpath(values.runtime);

const { createHarness } = await import("./harness.mjs");

const summary = [];

for (const journey of selected) {
  let ctx;

  try {
    ctx = await createHarness({
      runtime,
      app: values.app,
      keep: values.keep,
      journey: journey.name,
      ...journey.options,
    });
  } catch (caught) {
    // A journey whose Desktop never launches still owes the suite a summary.
    summary.push({
      journey: journey.name,
      status: "failed",
      checks: [],
      knownBugs: [],
      error: caught?.message ?? String(caught),
    });
    console.error(`[e2e] ${journey.name}: failed (no harness)`);
    continue;
  }

  let status = "failed";

  let error;

  try {
    await journey.run(ctx);
    status = "ok";
  } catch (caught) {
    error = caught;

    if (/^skip: /.test(caught?.message ?? "")) status = "skipped";
  } finally {
    // A renderer page error fails the journey without aborting the suite.
    if (!(await ctx.close({ success: status !== "failed" }))) status = "failed";
  }

  summary.push({
    journey: journey.name,
    status,
    root: ctx.root,
    checks: ctx.report.checks,
    knownBugs: ctx.report.knownBugs,
    error: status === "ok" ? undefined : (error?.message ?? ctx.report.error),
  });
  console.error(`[e2e] ${journey.name}: ${status} (${ctx.root})`);
}

console.log(JSON.stringify(summary, null, 2));

process.exit(summary.every((s) => s.status !== "failed") ? 0 : 1);
