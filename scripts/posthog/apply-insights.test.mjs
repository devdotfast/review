import assert from "node:assert/strict";
import { test } from "node:test";

import { stripLegacySeries } from "./apply-insights.mjs";

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
