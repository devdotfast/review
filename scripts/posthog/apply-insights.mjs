/**
 * One-shot PostHog cleanup for the Review project. Dry run by default:
 *
 *   node scripts/posthog/apply-insights.mjs            # print the plan
 *   node scripts/posthog/apply-insights.mjs --apply    # perform it
 *
 * Needs POSTHOG_CLI_API_KEY, POSTHOG_CLI_PROJECT_ID and POSTHOG_CLI_HOST
 * (the values ~/.posthog/credentials.json holds as token, env_id, host).
 *
 * Legacy `progressive_review_*` series are only stripped from an insight
 * when a read-only HogQL query shows zero events for that name in the last
 * 90 days; names still seen are kept, so DAU/WAU and other insights never
 * silently lose data that is still arriving. Dashboard deletion and the
 * project-settings PATCH are both read-before-write, so a second dry run
 * after --apply reports zero changes.
 */
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";

import { z } from "zod";

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

// The HogQL/insight query tree PostHog returns has no fixed shape in this
// script; every node is parsed into one of these domain values instead of
// probed with `typeof`. `jsonLeafSchema` covers anything that is never a
// container to recurse into, `undefined` included since JSON.parse never
// produces it but a missing property read might.
const jsonLeafSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.undefined(),
]);

const isJsonLeaf = (value) => jsonLeafSchema.safeParse(value).success;

const isJsonString = (value) => z.string().safeParse(value).success;

const eventsNodeSchema = z.looseObject({
  kind: z.literal("EventsNode"),
  event: z.string(),
});

const isLegacyEventsNode = (node, keepNames) => {
  const parsed = eventsNodeSchema.safeParse(node);

  return (
    parsed.success &&
    parsed.data.event.startsWith(LEGACY_PREFIX) &&
    !keepNames.has(parsed.data.event)
  );
};

const stripHogql = (sql, keepNames) => {
  const shouldStrip = (name) => !keepNames.has(name);

  return sql
    .replace(/,\s*'(progressive_review_[a-z_]+)'/g, (whole, name) => (shouldStrip(name) ? "" : whole))
    .replace(/'(progressive_review_[a-z_]+)'\s*,\s*/g, (whole, name) => (shouldStrip(name) ? "" : whole));
};

/**
 * A copy of `query` with every legacy series and HogQL literal removed,
 * except names present in `keepNames` (events still seen in the lookback
 * window), which are left untouched.
 */
export function stripLegacySeries(query, keepNames = new Set()) {
  if (Array.isArray(query))
    return query.filter((n) => !isLegacyEventsNode(n, keepNames)).map((n) => stripLegacySeries(n, keepNames));

  if (!isJsonLeaf(query)) {
    const out = {};

    for (const [key, value] of Object.entries(query))
      out[key] = key === "query" && isJsonString(value) ? stripHogql(value, keepNames) : stripLegacySeries(value, keepNames);

    return out;
  }

  return query;
}

const groupNodeSchema = z.looseObject({
  kind: z.literal("GroupNode"),
  nodes: z.array(z.unknown()),
});

/** True if any GroupNode in `value` was left with no nodes — a query PostHog would reject. */
export function hasEmptyGroup(value) {
  if (Array.isArray(value)) return value.some(hasEmptyGroup);

  if (!isJsonLeaf(value)) {
    const group = groupNodeSchema.safeParse(value);

    if (group.success && group.data.nodes.length === 0) return true;

    return Object.values(value).some(hasEmptyGroup);
  }

  return false;
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
  const origin = host.replace(/\/$/, "");

  const request = async (method, path, body, { allow404 = false } = {}) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (allow404 && response.status === 404) return null;

    if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${await response.text()}`);

    return response.status === 204 ? undefined : response.json();
  };

  return { project, request };
}

const projectPath = (project, route) => `/api/projects/${project}${route}`;

/** Event → { count, lastSeen } for every progressive_review_* name seen in the last 90 days. Read-only. */
async function legacyEventCounts({ request, project }) {
  const sql =
    "SELECT event, count(), max(timestamp) FROM events WHERE event LIKE 'progressive_review_%' AND timestamp > now() - INTERVAL 90 DAY GROUP BY event";

  const { results } = await request("POST", projectPath(project, "/query/"), { query: { kind: "HogQLQuery", query: sql } });

  return new Map(results.map(([event, count, lastSeen]) => [event, { count, lastSeen }]));
}

/** Which of /api/environments/<id>/ or /api/projects/<id>/ actually returns the settings fields. */
async function resolveSettingsRoute({ request, project }) {
  for (const kind of ["environments", "projects"]) {
    const path = `/api/${kind}/${project}/`;
    const settings = await request("GET", path, undefined, { allow404: true });

    if (settings && "session_recording_opt_in" in settings && "test_account_filters" in settings) {
      console.log(`settings route: ${path}`);

      return { path, settings };
    }
  }

  throw new Error("Neither /api/environments/<id>/ nor /api/projects/<id>/ returned session_recording_opt_in/test_account_filters.");
}

async function main() {
  const { values } = parseArgs({ options: { apply: { type: "boolean", default: false } } });
  const { project, request } = client();
  const changes = [];

  const legacyCounts = await legacyEventCounts({ request, project });
  const keepNames = new Set(legacyCounts.keys());

  for (const [name, { count, lastSeen }] of legacyCounts)
    console.log(`keeping ${name}: ${count} event(s) in the last 90 days, last seen ${lastSeen}`);

  for (const shortId of LEGACY_INSIGHTS) {
    const { results } = await request("GET", projectPath(project, `/insights/?short_id=${shortId}`));
    const insight = results[0];

    if (!insight) {
      console.log(`skipping insight ${shortId}: not found`);
      continue;
    }

    const query = stripLegacySeries(insight.query, keepNames);

    if (hasEmptyGroup(query)) {
      console.log(`skipping insight ${shortId} (${insight.name}): stripping would leave an empty group`);
      continue;
    }

    if (JSON.stringify(query) === JSON.stringify(insight.query)) continue;
    changes.push({
      what: `insight ${shortId} (${insight.name})`,
      run: () => request("PATCH", projectPath(project, `/insights/${insight.id}/`), { query }),
      diff: { before: insight.query, after: query },
    });
  }

  for (const shortId of DEAD_INSIGHTS) {
    const { results } = await request("GET", projectPath(project, `/insights/?short_id=${shortId}`));

    if (!results[0] || results[0].deleted) continue;
    changes.push({
      what: `delete insight ${shortId} (${results[0].name})`,
      run: () => request("PATCH", projectPath(project, `/insights/${results[0].id}/`), { deleted: true }),
    });
  }

  for (const id of DEAD_DASHBOARDS) {
    const dashboard = await request("GET", projectPath(project, `/dashboards/${id}/`), undefined, { allow404: true });

    if (!dashboard || dashboard.deleted) {
      console.log(`skipping dashboard ${id}: already gone`);
      continue;
    }

    changes.push({ what: `delete dashboard ${id}`, run: () => request("PATCH", projectPath(project, `/dashboards/${id}/`), { deleted: true }) });
  }

  const { path: settingsPath, settings: currentSettings } = await resolveSettingsRoute({ request, project });
  const plannedSettings = planProjectSettings();

  const settingsCurrent =
    isDeepStrictEqual(currentSettings.session_recording_opt_in, plannedSettings.session_recording_opt_in) &&
    isDeepStrictEqual(currentSettings.test_account_filters, plannedSettings.test_account_filters);

  if (settingsCurrent) console.log("skipping project settings: already current");
  else changes.push({ what: "project settings", run: () => request("PATCH", settingsPath, plannedSettings), diff: plannedSettings });

  for (const change of changes) {
    console.log(`${values.apply ? "applying" : "would apply"}: ${change.what}`);

    if (change.diff) console.log(JSON.stringify(change.diff, null, 2));

    if (values.apply) await change.run();
  }

  console.log(`${changes.length} change(s)${values.apply ? " applied" : ", dry run"}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
