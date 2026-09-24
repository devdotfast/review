/**
 * Declarative health-dashboard insights. `insightPlan` is pure and tested;
 * `syncHealthDashboard` in apply-insights.mjs does the actual GET/POST/PATCH.
 *
 * `HEALTH_DASHBOARD_ID` (1985947, "Review Usage and Health") and the exact
 * names "Suspected hangs" / "Recent suspected hangs" were confirmed against
 * the live project: both insights already sit on this dashboard.
 */
import { isDeepStrictEqual } from "node:util";

export const HEALTH_DASHBOARD_ID = 1985947;

const production = [
  { key: "environment", value: ["production"], operator: "exact", type: "event" },
];

const trends = (series, extra = {}) => ({
  kind: "InsightVizNode",
  source: {
    kind: "TrendsQuery",
    series,
    properties: production,
    dateRange: { date_from: "-30d" },
    interval: "day",
    ...extra,
  },
});

const funnel = (events) => ({
  kind: "InsightVizNode",
  source: {
    kind: "FunnelsQuery",
    series: events.map((event) => ({ kind: "EventsNode", event })),
    properties: production,
    dateRange: { date_from: "-30d" },
    funnelsFilter: { funnelWindowInterval: 7, funnelWindowIntervalUnit: "day" },
  },
});

// `display` stays unset rather than `undefined` when the caller omits it:
// PostHog's stored query has no such key then, and `isDeepStrictEqual`
// treats a present-but-undefined key and a missing key as different.
const hogql = (query, display, extra = {}) => {
  const node = { kind: "DataVisualizationNode", source: { kind: "HogQLQuery", query }, ...extra };

  if (display !== undefined) node.display = display;

  return node;
};

const rate = (numerator, denominator) => hogql(`
SELECT toStartOfDay(timestamp) AS day,
       countIf(event = '${numerator}') / greatest(countIf(event = '${denominator}'), 1) AS rate
FROM events
WHERE event IN ('${numerator}', '${denominator}')
  AND properties.environment = 'production'
  AND timestamp >= now() - INTERVAL 30 DAY
GROUP BY day ORDER BY day`);

// The two events a hang or an open timeout can now be read from directly
// (see docs/superpowers/specs/2026-09-23-telemetry-quality-design.md,
// "Hangs"), in place of the old command_run_id/presentation_id gap query.
const HANG_EVENTS = "'review_hang_started', 'review_open_timeout'";

const SUSPECTED_HANGS_QUERY = hogql(
  `
SELECT count() AS suspected_hangs
FROM events
WHERE event IN (${HANG_EVENTS})
  AND properties.environment = 'production'
  AND timestamp >= now() - INTERVAL 7 DAY
`,
  "BoldNumber",
);

const RECENT_SUSPECTED_HANGS_QUERY = hogql(
  `
SELECT multiIf(event = 'review_hang_started', 'Hang', 'Open timeout') AS kind,
       properties.surface AS surface,
       timestamp AS start_time,
       dateDiff('minute', timestamp, now()) AS age_minutes,
       properties.elapsed_ms AS elapsed_ms
FROM events
WHERE event IN (${HANG_EVENTS})
  AND properties.environment = 'production'
  AND timestamp >= now() - INTERVAL 7 DAY
ORDER BY start_time DESC
LIMIT 100
`,
  "ActionsTable",
  {
    tableSettings: {
      columns: [
        { column: "kind" },
        { column: "surface" },
        { column: "start_time" },
        {
          column: "age_minutes",
          settings: { formatting: { style: "number", suffix: " min", decimalPlaces: 0.0 } },
        },
        { column: "elapsed_ms" },
      ],
    },
  },
);

export const HEALTH_INSIGHTS = [
  { name: "Health: crash rate per session", description: "review_crash over review_session_started, daily.", query: rate("review_crash", "review_session_started") },
  { name: "Health: hang rate per session", description: "review_hang_started over review_session_started, daily.", query: rate("review_hang_started", "review_session_started") },
  { name: "Health: installations affected by exceptions", description: "Distinct installs sending $exception.", query: trends([{ kind: "EventsNode", event: "$exception", math: "dau" }]) },
  { name: "Health: error bursts", description: "review_error_burst by message_hash.", query: trends([{ kind: "EventsNode", event: "review_error_burst", math: "total" }], { breakdownFilter: { breakdown: "message_hash", breakdown_type: "event" } }) },
  { name: "Health: abnormal session endings by version", description: "review_session_ended with outcome=abnormal.", query: trends([{ kind: "EventsNode", event: "review_session_ended", math: "total", properties: [{ key: "outcome", value: ["abnormal"], operator: "exact", type: "event" }] }], { breakdownFilter: { breakdown: "app_version", breakdown_type: "event" } }) },
  { name: "Health: open timeouts", description: "Reviews opened but not presented within 30 s.", query: trends([{ kind: "EventsNode", event: "review_open_timeout", math: "total" }]) },
  { name: "Health: UI stalls", description: "review_ui_stall by process.", query: trends([{ kind: "EventsNode", event: "review_ui_stall", math: "total" }], { breakdownFilter: { breakdown: "process", breakdown_type: "event" } }) },
  { name: "Health: update failures", description: "review_update_failed by error_name.", query: trends([{ kind: "EventsNode", event: "review_update_failed", math: "dau" }], { breakdownFilter: { breakdown: "error_name", breakdown_type: "event" } }) },
  { name: "Funnel: activation", description: "Install to first presented review.", query: funnel(["review_installation_created", "review_first_review_presented"]) },
  { name: "Funnel: review lifecycle", description: "Created, presented, ended.", query: funnel(["review_review_created", "review_review_presented", "review_session_ended"]) },
  { name: "Community: Discord and login", description: "Discord clicks and successful logins.", query: trends([{ kind: "EventsNode", event: "review_discord_clicked", math: "total" }, { kind: "EventsNode", event: "review_login_succeeded", math: "total" }]) },
  { name: "Suspected hangs", description: "Count of review_hang_started and review_open_timeout in the last 7 days.", query: SUSPECTED_HANGS_QUERY },
  { name: "Recent suspected hangs", description: "The last 100 review_hang_started/review_open_timeout events.", query: RECENT_SUSPECTED_HANGS_QUERY },
];

// PostHog normalises a stored query (default fields filled in, key order
// changed), so a fresh JSON.stringify comparison against what we sent is
// never idempotent. Compare structurally instead.
const same = (left, right) => isDeepStrictEqual(left, right);

export function insightPlan(existing, specs = HEALTH_INSIGHTS) {
  const plan = { create: [], update: [], unchanged: [] };

  for (const spec of specs) {
    const found = existing.find((insight) => insight.name === spec.name);

    if (!found) {
      plan.create.push(spec);
    } else if (same(found.query, spec.query) && found.dashboards.includes(HEALTH_DASHBOARD_ID)) {
      plan.unchanged.push(spec.name);
    } else {
      plan.update.push({ id: found.id, spec });
    }
  }

  return plan;
}
