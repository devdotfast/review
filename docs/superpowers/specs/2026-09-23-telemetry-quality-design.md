# Review telemetry quality: design

Date: 2026-09-23. Audited against origin/main `5fe31439c` and PostHog project
`dev.fast` (id 492396). Findings and rerunnable queries are summarised in the
session memory `telemetry-audit-2026-09-23`.

## Goal

Make Review's telemetry trustworthy for four questions, in this order:

1. Is the app healthy? Crashes, hangs, errors, failed updates, per install and
   per version.
2. How many real installs do we have, and how many reach a first review?
3. What happens inside a review: authored, opened, presented, diffs, scratchpad,
   abandoned.
4. Who is engaging: GitHub login, Discord, bug reports.

Ship it in two Review PRs. Keep the DAU/WAU insights working throughout.

## Decisions already made

- Two Review PRs maximum. A small companion change to the bug-report Worker
  (Fix-Fast/dev) accepts minidumps; it is not one of the two.
- Errors go to PostHog error tracking as `$exception`. The custom
  `review_client_error` keeps sending for one release so the existing
  "Installations affected by UI errors" insight does not go dark, then it is
  removed.
- Crashes are both counted (a `review_crash` event per crash, so dashboards can
  show crash rate per session even when no dump exists) and uploaded (the
  Electron minidump goes to the bug-report Worker).
- GitHub login aliases the installation id to an HMAC of the GitHub user id.
  The login itself never leaves the machine.
- Preview gets its own installation identity, and every event carries
  `channel`.
- Existing dashboards may change when there is a reason. DAU and WAU keep
  their event names and their `ci=false AND internal=false` filters working.

## Envelope: common properties on every event

Every event from every process carries this envelope. Today two events
(`review_bug_report`, `review_telemetry_dropped`) carry none of it, and the
rest carry an older, inconsistent subset.

| Property | Values | Source |
|---|---|---|
| `app_version` | Desktop semver, or absent for the standalone CLI | `productService.reviewVersion`, passed to the server as today |
| `cli_version` | review package semver | `readReviewPackageVersion` (replaces the constant `version: "0.0.1"`) |
| `channel` | `stable`, `preview`, `dev` | `product.json` `quality` stamped at release; `dev` for unpackaged runs |
| `environment` | `production`, `ci`, `internal`, `e2e`, `smoke` | see below |
| `surface` | `desktop`, `cli`, `headless`, `mcp`, `api` | set by the host that constructs `ReviewTelemetry` |
| `ci`, `internal` | booleans, unchanged | kept so the existing DAU/WAU, installs and activation insights keep working |
| `platform`, `arch`, `node_major`, `os_version` | as today plus `os_version` | `os.release()` |
| `app_session_id` | one uuid per Desktop launch | minted once in Electron main and passed to the server and renderer; the canvas and main no longer mint their own |
| `$process_person_profile` | `false` until the install is aliased to a GitHub identity | the batch client |

`environment` derivation, first match wins: `smoke` when
`DEV_FAST_REVIEW_TELEMETRY_ENV=smoke` (the smoke scripts set it), `e2e` when the
e2e harness sets the same variable, `ci` when `CI` is truthy, `internal` when
the workspace check or the persisted `internal:true` flag is set, else
`production`. The dev Desktop build writes `internal:true` into the telemetry
config on first run, which nothing does today. Fake version strings such as
`deploy-smoke-1045` stop being the way to spot test traffic.

`product` and `package` are removed. `version` is removed after one release of
sending both it and `cli_version`.

## Identity

- `distinct_id` stays the random installation id.
- Preview reads and writes `telemetry/progressive-review.preview.json`; stable
  keeps `telemetry/progressive-review.json` untouched, so no existing stable
  install changes identity. The two channels therefore count as separate
  installs, which is the chosen behaviour.
- On GitHub login success the server sends `$create_alias` with
  `alias = "gh_" + HMAC(namespace, github user id)`, using the same keyed
  hashing scheme as `review_id`, and sets `$process_person_profile: true` from
  then on. No login, email or name is sent. Logout does not un-alias; PostHog
  cannot.
- The privacy and telemetry docs are updated to say: installs are anonymous
  until GitHub login; after login, installs by the same GitHub account are
  linked by a keyed hash.

## Reliability signals

**Session lifecycle, restored.** PR #325 removed the only callers. The JSON
review runtime emits:

- `review_session_started{review_id, presentation_id, source_kind, agent_kind}`
  when a review opens in the Desktop.
- `review_review_presented{review_id, presentation_id, load_ms}` when the
  canvas signals ready. `load_ms` is opened-to-presented.
- `review_session_ended{review_id, outcome, duration_ms}` with `outcome` in
  `closed`, `dismissed`, `deleted`, `app_quit`, `abnormal`.

`session_ended` coverage (5% today) is fixed three ways: a `keepalive` beacon
on `pagehide`, a main-process quit hook that flushes the server queue, and an
on-disk marker per open session that the next launch reconciles into
`session_ended{outcome:"abnormal"}`. The abnormal count is the crash-or-hang
floor even when no other signal fires.

**Crashes.** Electron main listens to `render-process-gone`,
`child-process-gone` and the supervisor's server-process exit, and emits
`review_crash{process, reason, exit_code, uptime_ms, review_id?}`. The Electron
`crashReporter` starts with `uploadToServer: false` and a Review-owned dump
directory. On the next launch main lists new dumps, emits one `review_crash`
per dump with `source: "minidump"` if no live event already covered it, and
uploads each dump as a multipart part to a new bug-report Worker endpoint
`/api/v2/crashes` with the envelope as metadata. Dumps are deleted after a
successful upload or after 7 days.

**Hangs.** Three explicit signals replace the inferred query:

- `review_hang_started` and `review_hang_ended{duration_ms}` from the window
  `unresponsive` and `responsive` events in main.
- `review_ui_stall{duration_ms, process, phase}` from an event-loop-lag watchdog
  in the workbench renderer and the canvas, threshold 2 s, capped at 5 per
  session.
- `review_open_timeout{review_id, elapsed_ms}` from the server when a session
  starts and no `presented` arrives within 30 s.

The "Suspected hangs" HogQL insights are rewritten on top of these.

**Errors.** Every process that today calls `review_client_error` also sends a
PostHog `$exception` with `$exception_list` built from the existing sanitised
`message`, `message_hash` and `frames`, plus the envelope. The server utility
process gains `uncaughtException` and `unhandledRejection` handlers reporting
`error_process: "server"`, which is already allowlisted. A per-session cap of
5 reports per `message_hash` replaces the flat 30-per-session cap; hitting it
sends one `review_error_burst{message_hash, suppressed}` so one loop cannot
count as thousands of errors.

**Startup.** `review_app_ready{duration_ms}` from the existing startup trace.

## Install and activation

- `review_installation_created` fires from the Desktop host on first run and
  from headless start, not only from CLI command hooks. It is once per
  installation id: the `installationCreatedSent` flag is written before the
  event is queued, and the root cause of the 43 repeat sends is fixed as part
  of this.
- `review_first_review_presented` fires once per installation id, on the first
  `presented`. The activation funnel becomes a single event.
- Headless carries `surface: "headless"`. Install and activation insights
  filter `surface in (desktop, cli)`; usage insights include it.

## Review lifecycle and engagement

New allowlisted events, all with `review_id`:

- `review_review_created{via: cli|api|mcp, agent_kind, files, commits, blocks}`
- `review_review_published`, `review_review_shared`, `review_review_revoked`
- `review_authoring_completed{duration_ms, agent_kind}` measured from created to
  published for agent-authored reviews; CLI `command_*` timings stay as they
  are.
- `review_mcp_tool_called{tool, ok, duration_ms}`
- `review_diff_opened{kind: commit|file|structural, via}` and
  `review_diff_viewed{duration_ms}`
- `review_scratchpad_opened`
- `review_setting_changed` gains `setting: structural_diff` and `theme`.
- `review_discord_clicked{via: topbar|dialog|docs}`,
  `review_discord_dialog_shown`, `review_discord_dialog_dismissed`.
- `review_login_started`, `review_login_succeeded`, `review_login_failed{reason}`.
- Allowlist drift fixed: `peek_opened{via: call_stack_frame}` accepted;
  `peek_resolved` and `peek_resolve_failed` emitted; `map.*` commands mapped to
  command paths; `review_review_dismissed`, `restored`, `deleted` emitted from
  Home.

## PR split

**PR 1: telemetry contract.** Everything the dashboards already assume, made
true, and shipped before 0.0.34 stable.

- Envelope, `environment`, `channel`, `surface`, preview identity, single
  `app_session_id`, envelope on bug report and dropped events.
- Restored session lifecycle events with the coverage fixes.
- Install event from Desktop and headless, once per id;
  `first_review_presented`.
- Contract test in CI: one e2e journey run with the debug sink, asserting the
  exact event names and envelope keys. This is what makes a repeat of #325
  fail CI instead of failing the dashboard.
- PostHog: a `scripts/posthog/apply-insights.mjs` that rewrites the 8 legacy
  `progressive_review_*` insights to the current names, deletes the 17 dead
  insights and the hidden AI dashboard, disables replay, and sets the
  project test-account filter to `environment != production`. DAU and WAU
  keep their current definitions.
- `docs/telemetry.md` and `docs/privacy.md` regenerated from the allowlist and
  brought in line with the code.

**PR 2: reliability and engagement.** New signals.

- `$exception`, `review_crash` with minidump upload, hang signals, server
  handlers, error bursts, `app_ready`.
- Review lifecycle, diff, scratchpad, Discord, login and MCP events.
- GitHub alias.
- Health dashboard rebuilt by the same script: installs and activation,
  reliability (crash rate per session, hang rate, error-affected installs,
  bursts), review funnel, update health, community.

Companion, outside the count: bug-report Worker `/api/v2/crashes` in
Fix-Fast/dev, landed before PR 2 ships.

## Testing

- Unit: allowlist and envelope tests in `packages/review/src`, main-process
  crash and hang listeners in the fork, session-marker reconciliation.
- Contract: the CI e2e journey with `DEV_FAST_REVIEW_TELEMETRY_DEBUG` asserting
  the event set, run in the existing e2e workflow.
- Smoke: the two existing delivery smoke scripts run in the release workflow
  against the packaged app with `environment: smoke`.
- PostHog: the apply script is idempotent and dry-runs by default.

## Out of scope

- Session replay in the Desktop.
- Linking marketing-site emails to installs. The app never collects an email;
  that link needs a download token carried through the installer and is a
  separate decision.
- Windows and Linux update telemetry beyond what the updater already reports.
- Feature flags and experiments.
