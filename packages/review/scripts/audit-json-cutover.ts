import { migrateJsonReviews } from "../src/review-import/json-cutover";

const home = process.argv[2];

if (!home)
  throw new Error("Usage: tsx scripts/audit-json-cutover.ts <review-home>");

const report = await migrateJsonReviews({
  home,
  dryRun: true,
  log: console.error,
});

console.log(JSON.stringify(report, null, 2));

process.exitCode = report.errors.length ? 1 : 0;
