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

test("session endings (reloads excluded) only treats an app_quit as a possible reload, correlated by app_session_id within 60s, and drops the match via an anti-join", () => {
  const insight = HEALTH_INSIGHTS.find(
    (spec) => spec.name === "Health: session endings by outcome (reloads excluded)",
  );

  const sql = insight.query.source.query;

  // Only app_quit endings are ever checked against a following session start;
  // other outcomes (dismissed, deleted, abnormal, ...) can never be misread
  // as a reload and are passed through untouched.
  assert.match(sql, /WHERE\s+q\.outcome = 'app_quit'/);
  // The reload window is exactly the accepted 60s product window.
  assert.match(sql, /INTERVAL 60 SECOND/);
  // Correlated by app_session_id (the reload keeps the same app session), not
  // by review or presentation id.
  assert.match(sql, /s\.properties\.app_session_id = q\.app_session_id/);
  assert.doesNotMatch(sql, /presentation_id/);
  // A matched reload is dropped from the result (anti-join), not relabelled.
  assert.match(sql, /LEFT JOIN reloads[\s\S]*WHERE\s+reloads\.app_session_id IS NULL/);
});

test("the lifecycle funnel's terminal step excludes app_quit outcomes (a reload, or an uninformative close, neither of which is a finished review)", () => {
  const insight = HEALTH_INSIGHTS.find((spec) => spec.name === "Funnel: review lifecycle");
  const steps = insight.query.source.series;
  const terminal = steps.at(-1);

  assert.equal(terminal.event, "review_session_ended");
  assert.deepEqual(terminal.properties, [
    { key: "outcome", value: ["app_quit"], operator: "is_not", type: "event" },
  ]);
  // The other two steps are untouched plain events.
  assert.deepEqual(
    steps.slice(0, 2).map((step) => step.event),
    ["review_review_created", "review_review_presented"],
  );
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
