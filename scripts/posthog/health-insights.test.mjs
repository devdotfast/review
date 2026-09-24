import assert from "node:assert/strict";
import test from "node:test";

import {
  HEALTH_DASHBOARD_ID,
  HEALTH_INSIGHTS,
  insightPlan,
} from "./health-insights.mjs";

test("creates missing insights, updates changed ones, leaves identical ones", () => {
  const [first, second] = HEALTH_INSIGHTS;

  const plan = insightPlan([
    { id: 1, name: first.name, query: first.query, dashboards: [HEALTH_DASHBOARD_ID] },
    { id: 2, name: second.name, query: { kind: "stale" }, dashboards: [] },
  ]);

  assert.deepEqual(plan.unchanged, [first.name]);
  assert.deepEqual(plan.update.map((u) => u.id), [2]);
  assert.equal(plan.create.length, HEALTH_INSIGHTS.length - 2);
});

test("every insight filters production", () => {
  for (const spec of HEALTH_INSIGHTS) {
    assert.match(JSON.stringify(spec.query), /production/, spec.name);
  }
});

test("an insight missing from the dashboard is an update, even with an identical query", () => {
  const [first] = HEALTH_INSIGHTS;

  const plan = insightPlan([
    { id: 9, name: first.name, query: first.query, dashboards: [] },
  ]);

  assert.deepEqual(plan.update.map((u) => u.id), [9]);
  assert.deepEqual(plan.unchanged, []);
});

test("key order alone does not count as a change (PostHog re-serialises stored queries)", () => {
  const [first] = HEALTH_INSIGHTS;
  const reordered = JSON.parse(JSON.stringify(first.query));
  const rekeyed = Object.fromEntries(Object.keys(reordered).reverse().map((key) => [key, reordered[key]]));

  const plan = insightPlan([
    { id: 1, name: first.name, query: rekeyed, dashboards: [HEALTH_DASHBOARD_ID] },
  ]);

  assert.deepEqual(plan.unchanged, [first.name]);
});

test("the two Suspected hangs insights are rewritten on the explicit hang/timeout events, not the old inferred-gap query", () => {
  const hangInsights = HEALTH_INSIGHTS.filter((spec) =>
    spec.name.toLowerCase().includes("suspected hangs"),
  );

  assert.deepEqual(
    hangInsights.map((spec) => spec.name).sort(),
    ["Recent suspected hangs", "Suspected hangs"],
  );

  for (const spec of hangInsights) {
    const sql = JSON.stringify(spec.query);

    assert.match(sql, /review_hang_started/, spec.name);
    assert.match(sql, /review_open_timeout/, spec.name);
    assert.doesNotMatch(sql, /command_run_id/, spec.name);
    assert.doesNotMatch(sql, /presentation_id/, spec.name);
  }
});
