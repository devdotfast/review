/**
 * One-shot PostHog cleanup for the Review project. Dry run by default:
 *
 *   node scripts/posthog/apply-insights.mjs            # print the plan
 *   node scripts/posthog/apply-insights.mjs --apply    # perform it
 *
 * Needs POSTHOG_CLI_API_KEY, POSTHOG_CLI_PROJECT_ID and POSTHOG_CLI_HOST
 * (the values ~/.posthog/credentials.json holds as token, env_id, host).
 */
import { parseArgs } from "node:util";

export const LEGACY_INSIGHTS = [
  "xXKBBHnq", "ShE8BcCY", "WIAJp6cX", "uBnJREXr", "xLA0E9yO",
  "T3CDzuLb", "4AGAFhd8", "46AVU1i1", "ZV7IyoiR", "DkCcoT9c",
];

export const DEAD_INSIGHTS = [
  "ffQBNCiq", "Zle6V9u9", "UhD8OPJx", "dq12rimg", "XFEqGBE3", "xYYhLgt1",
  "bsZ3pyy5", "mMOgADse", "TQSnzCUb", "5ztbm46L", "7SdVpvYY", "SiYV4Cgl",
  "cVPge71g", "oEDDimVL", "i2Vl5Ver", "oMdDqIHf", "OiUIdS7Y",
];

// Only the hidden AI dashboard. The starter dashboard (1780814) is left
// alone; it is not the dashboard the spec names for deletion.
export const DEAD_DASHBOARDS = [1819313];

const LEGACY_PREFIX = "progressive_review_";

const isLegacyEventsNode = (node) =>
  node && typeof node === "object" && node.kind === "EventsNode" &&
  typeof node.event === "string" && node.event.startsWith(LEGACY_PREFIX);

const stripHogql = (sql) =>
  sql
    .replace(/,\s*'progressive_review_[a-z_]+'/g, "")
    .replace(/'progressive_review_[a-z_]+'\s*,\s*/g, "");

/** A copy of `query` with every legacy series and every legacy HogQL literal removed. */
export function stripLegacySeries(query) {
  if (Array.isArray(query)) return query.filter((n) => !isLegacyEventsNode(n)).map(stripLegacySeries);

  if (query && typeof query === "object") {
    const out = {};

    for (const [key, value] of Object.entries(query))
      out[key] = key === "query" && typeof value === "string" ? stripHogql(value) : stripLegacySeries(value);

    return out;
  }

  return query;
}

export function planProjectSettings() {
  return {
    session_recording_opt_in: false,
    test_account_filters: [
      { key: "environment", type: "event", operator: "exact", value: ["production"] },
    ],
  };
}

function client() {
  const { POSTHOG_CLI_API_KEY: key, POSTHOG_CLI_PROJECT_ID: project, POSTHOG_CLI_HOST: host } = process.env;

  if (!key || !project || !host) throw new Error("POSTHOG_CLI_API_KEY, POSTHOG_CLI_PROJECT_ID and POSTHOG_CLI_HOST are required.");
  const base = `${host.replace(/\/$/, "")}/api/projects/${project}`;

  return async (method, route, body) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!response.ok) throw new Error(`${method} ${route} → ${response.status} ${await response.text()}`);

    return response.status === 204 ? undefined : response.json();
  };
}

async function main() {
  const { values } = parseArgs({ options: { apply: { type: "boolean", default: false } } });
  const api = client();
  const changes = [];

  for (const shortId of LEGACY_INSIGHTS) {
    const { results } = await api("GET", `/insights/?short_id=${shortId}`);
    const insight = results[0];

    if (!insight) {
      console.log(`skipping insight ${shortId}: not found`);
      continue;
    }

    const query = stripLegacySeries(insight.query);

    if (JSON.stringify(query) === JSON.stringify(insight.query)) continue;
    changes.push({ what: `insight ${shortId} (${insight.name})`, run: () => api("PATCH", `/insights/${insight.id}/`, { query }), diff: { before: insight.query, after: query } });
  }

  for (const shortId of DEAD_INSIGHTS) {
    const { results } = await api("GET", `/insights/?short_id=${shortId}`);

    if (!results[0] || results[0].deleted) continue;
    changes.push({ what: `delete insight ${shortId} (${results[0].name})`, run: () => api("PATCH", `/insights/${results[0].id}/`, { deleted: true }) });
  }

  for (const id of DEAD_DASHBOARDS)
    changes.push({ what: `delete dashboard ${id}`, run: () => api("PATCH", `/dashboards/${id}/`, { deleted: true }) });

  const settings = planProjectSettings();
  changes.push({ what: "project settings", run: () => api("PATCH", "/", settings), diff: settings });

  for (const change of changes) {
    console.log(`${values.apply ? "applying" : "would apply"}: ${change.what}`);

    if (change.diff) console.log(JSON.stringify(change.diff, null, 2));

    if (values.apply) await change.run();
  }

  console.log(`${changes.length} change(s)${values.apply ? " applied" : ", dry run"}`);
}

if (process.argv[1] === new URL(import.meta.url).pathname) await main();
