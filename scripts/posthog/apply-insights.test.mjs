import assert from "node:assert/strict";
import { test } from "node:test";

import { hasEmptyGroup, planProjectSettings, stripLegacySeries } from "./apply-insights.mjs";

test("drops progressive_review_* series from a trends query, including nested groups", () => {
  const query = {
    kind: "TrendsQuery",
    series: [
      { kind: "EventsNode", event: "review_app_opened", math: "dau" },
      { kind: "EventsNode", event: "progressive_review_app_opened", math: "dau" },
      {
        kind: "GroupNode",
        nodes: [
          { kind: "EventsNode", event: "review_installation_created" },
          { kind: "EventsNode", event: "progressive_review_installation_created" },
        ],
      },
    ],
  };

  assert.deepEqual(stripLegacySeries(query), {
    kind: "TrendsQuery",
    series: [
      { kind: "EventsNode", event: "review_app_opened", math: "dau" },
      { kind: "GroupNode", nodes: [{ kind: "EventsNode", event: "review_installation_created" }] },
    ],
  });
  assert.equal(query.series.length, 3, "the input is not mutated");
});

test("removes legacy names from a HogQL IN list", () => {
  const query = {
    kind: "DataVisualizationNode",
    source: {
      kind: "HogQLQuery",
      query:
        "SELECT count() FROM events WHERE event IN ('review_app_opened', 'progressive_review_app_opened', 'progressive_review_session_started', 'review_session_started')",
    },
  };

  assert.equal(
    stripLegacySeries(query).source.query,
    "SELECT count() FROM events WHERE event IN ('review_app_opened', 'review_session_started')",
  );
});

test("keeps a legacy series whose event is still seen, strips the rest", () => {
  const keepNames = new Set(["progressive_review_installation_created"]);

  const query = {
    kind: "TrendsQuery",
    series: [
      { kind: "EventsNode", event: "progressive_review_app_opened", math: "dau" },
      { kind: "EventsNode", event: "progressive_review_installation_created", math: "dau" },
    ],
  };

  assert.deepEqual(stripLegacySeries(query, keepNames), {
    kind: "TrendsQuery",
    series: [{ kind: "EventsNode", event: "progressive_review_installation_created", math: "dau" }],
  });
});

test("keeps a legacy name in a HogQL IN list when it is still seen", () => {
  const keepNames = new Set(["progressive_review_session_started"]);

  const query = {
    kind: "DataVisualizationNode",
    source: {
      kind: "HogQLQuery",
      query:
        "SELECT count() FROM events WHERE event IN ('review_app_opened', 'progressive_review_app_opened', 'progressive_review_session_started', 'review_session_started')",
    },
  };

  assert.equal(
    stripLegacySeries(query, keepNames).source.query,
    "SELECT count() FROM events WHERE event IN ('review_app_opened', 'progressive_review_session_started', 'review_session_started')",
  );
});

test("stripping never leaves a GroupNode with no nodes", () => {
  const query = {
    kind: "TrendsQuery",
    series: [
      {
        kind: "GroupNode",
        name: "All legacy",
        nodes: [
          { kind: "EventsNode", event: "progressive_review_app_opened" },
          { kind: "EventsNode", event: "progressive_review_session_started" },
        ],
      },
    ],
  };

  const stripped = stripLegacySeries(query);

  assert.deepEqual(stripped.series[0].nodes, []);
  assert.equal(hasEmptyGroup(stripped), true, "the caller must detect and refuse this result");
  assert.equal(hasEmptyGroup(query), false, "the original query has no empty group");
});

test("adds the non-production environment filter beside the existing test-account filters, once", () => {
  const cohort = { key: "id", type: "cohort", operator: "not_in", value: 388195 };
  const planned = planProjectSettings([cohort]);

  assert.equal(planned.session_recording_opt_in, false);
  assert.deepEqual(planned.test_account_filters, [
    cohort,
    { key: "environment", type: "event", operator: "is_not", value: ["ci", "internal", "e2e", "smoke"] },
  ]);
  assert.deepEqual(planProjectSettings(planned.test_account_filters).test_account_filters, planned.test_account_filters);
});
