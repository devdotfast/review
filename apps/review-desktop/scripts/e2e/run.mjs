/**
 * Runs each scripts/e2e/journeys/*.mjs against its own Desktop and temp home.
 *
 * Manual suite; nothing in CI runs it. Each journey launches Review Desktop once
 * with an isolated review home, profile, port and temp root, drives it through
 * the JSON review API, the installed CLI and Playwright over CDP, and writes
 * report.json, app.log and failure screenshots under the temp root
 * (/tmp/review-e2e-<journey>-* on macOS, $TMPDIR/... elsewhere).
 *
 *   node apps/review-desktop/scripts/e2e/run.mjs --runtime <staged package> [--journey a,b] [--list] [--keep] [--app /path/Review.app]
 *
 * --runtime is a production install of the CLI, not this checkout. Stage one:
 *
 *   pnpm --filter @dev.fast/review-desktop app:build
 *   (cd packages/review && pnpm pack --pack-destination /tmp/review-pack)
 *   mkdir -p /tmp/review-runtime && (cd /tmp/review-runtime && npm init -y >/dev/null && npm install --omit=dev /tmp/review-pack/dev.fast-review-*.tgz)
 *   export REVIEW_E2E_RUNTIME=/tmp/review-runtime/node_modules/@dev.fast/review
 *
 * Phase-1 journeys run offline after a one-time network fetch of the curated
 * VSIX cache (lsp-python is the journey that fills it). Phase-2 journeys
 * (lsp-go, lsp-rust) download toolchains and only run with REVIEW_E2E_NETWORK=1.
 * In development mode each journey re-invokes curated-extensions.mjs through
 * run.sh, so this checkout's code-oss/extensions ends up holding the last
 * journey's selection; `node scripts/curated-extensions.mjs --only=all` restores it.
 *
 * Product bugs the suite finds live in KNOWN_BUGS.md next to this file.
 */
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
    // A Desktop that never launches or never attaches fails its own journey; the
    // ones after it still deserve a run and the suite still owes a summary.
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
