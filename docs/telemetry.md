# Telemetry

Review collects a small amount of anonymous usage and reliability data. We use
it to learn which parts of Review are useful and where the app is failing.

This page is the complete public contract for Review Desktop and CLI telemetry.
For a shorter overview of all product data, including local files, coding
agents, and bug reports, see [Privacy](privacy.md).

Last checked against this repository: 2026-09-24.

## The short version

- Anonymous telemetry is on by default and can be turned off at any time.
- Review records actions such as opening a review, changing tabs, using code
  navigation, or completing a CLI command. Values are limited to fixed
  categories, booleans, counts, durations, versions, and opaque identifiers.
- Passive telemetry never includes your code, diffs, file paths, repository
  name, Review title, refs, revision hashes, raw Review UUID, coding-agent
  session ID, Review text, prompts, or model output.
- Review uses a random installation ID, never your email, username, hostname,
  or a hardware identifier. Events carry `$process_person_profile: false`
  until you sign in with GitHub; after that PostHog keeps a person profile
  linking every installation signed into the same account.
- Product errors may include a cleaned error message and Review-only stack
  frames. Paths, web and email addresses, and recognizable secrets are removed
  on your machine before the event is accepted.
- Sending a bug report is a separate, explicit action. You see and control its
  attachments before anything is uploaded.

Review sends anonymous telemetry to PostHog. PostHog may derive a coarse
location during ingestion; our project discards the source IP.

## Turn telemetry off

In Review Desktop, open **Preferences → Settings** and disable **Share
anonymous usage data**. The setting controls both Review Desktop and the Review
CLI on that installation. Disabling it also clears any queued events that have
not been sent.

For a single command, a shell, or a headless environment, set `DO_NOT_TRACK`:

```sh
DO_NOT_TRACK=1 review info
```

Review also honors these variables when their value is `1` or `true`:

- `DO_NOT_TRACK`
- `DNT`
- `PROGRESSIVE_REVIEW_TELEMETRY_DISABLED`
- `DEV_FAST_TELEMETRY_DISABLED`
- `DEV_FAST_PROGRESSIVE_REVIEW_TELEMETRY_DISABLED`
- `DEV_FAST_REVIEW_TELEMETRY_DISABLED`

Tests also turn telemetry off with `VITEST=1` or `NODE_ENV=test`.

An explicit bug report is still sent if you choose **Send** in the bug-report
dialog. Bug reports do not pass through the passive telemetry system.

## What Review collects

| Category        | Examples                                                  | What is not included                                            |
| --------------- | --------------------------------------------------------- | --------------------------------------------------------------- |
| App usage       | A review opened, a tab viewed, a map expanded             | Review text, code, paths, or repository details                 |
| CLI usage       | Command category, success or failure, duration            | Command arguments, refs, process output, or exception text      |
| Code navigation | Feature category, language category, editor surface       | Symbols, declarations, search text, or source code              |
| Extensions      | An allowlisted extension ID, install outcome and duration | Extension version, configuration, or extension data             |
| Review outcome  | Dismiss, restore, or delete                               | Review text or reviewer identity                                |
| Reliability     | Error class, cleaned message, Review-only stack frames    | User paths, repository frames, secrets, or authored Review text |

Every event is checked against an allowlist on your machine. Unknown events,
unknown properties, and values outside their allowed categories are dropped.
The full event-by-event list begins at [Event reference](#event-reference).

## Identity and storage

On first use, Review creates a random installation UUID and stores it at
`${DEV_REVIEW_HOME:-~/.dev}/telemetry/progressive-review.json`. It does not call
PostHog's `identify()` API. Every event, including `review_telemetry_dropped`,
carries `$process_person_profile: false` — a personless event PostHog never
attaches to a profile — until the installation is linked to a GitHub account.

**Account alias.** After a successful GitHub sign-in in Review Desktop, Review
sends one `$create_alias{alias, $process_person_profile: true}` linking the
installation ID to `gh_` plus 16 bytes of a namespaced HMAC of the signed-in
account id. The account id, login, and email never leave the machine, and the
hash cannot be reversed. From then on this installation's events carry
`$process_person_profile: true`, so PostHog keeps one person profile joining
every installation aliased to that account. Only the first account signed
into an installation is aliased; a later sign-in to a different account sends
nothing, and signing out does not remove the link. `review login` from the
CLI aliases the same way, but only Desktop sign-in sends the
`review_login_started|succeeded|failed` funnel below.

Review Desktop Preview keeps a separate installation id in
`telemetry/progressive-review.preview.json`. The standalone CLI always uses the
stable id.

Pending events are kept in a local queue under
`${DEV_REVIEW_HOME:-~/.dev}/telemetry/events`. The queue holds at most 1,000
events, retries temporary failures, and deletes events after seven days. Each
event keeps one random `uuid` across retries, so PostHog ingests a resent event
once, and its `timestamp` is when it happened, not when it was sent. A
`review_telemetry_dropped` count is queued the same way, so a resent count lands
once too.
Telemetry is best-effort and never blocks Review from working.

Three identifiers support exact lifecycle correlation without PostHog identity
or group profiles:

- `command_run_id` is a new random UUID for each CLI invocation.
- `review_id` is `rv_` plus 128 bits of a namespaced HMAC of the Review UUID.
- `presentation_id` is `pr_` plus 128 bits of a namespaced HMAC of the Desktop
  Review-session ID.

The HMAC key is the random installation ID. The same Review therefore has a
stable `review_id` only on one installation; copying it to another installation
produces a different value. The raw Review UUID and Desktop Review-session ID
are used only inside the local server and never reach the capture client.

Review Desktop disables the built-in Microsoft telemetry inherited from Code -
OSS. A hardening test enforces that rule.

## How events leave the app

The canvas and desktop window do not connect directly to PostHog. They send
events to Review's local server, which checks the allowlist before adding an
event to the queue. The CLI uses the same queue and transport.

```text
Review Desktop ──┐
Review canvas  ──┼─→ local allowlist ─→ disk queue ─→ PostHog
Review CLI     ──┘
```

User-initiated bug reports take a separate path:

```text
Review ─→ local Review server ─→ bug.dev.fast ─→ private Cloudflare R2
                                      └─→ attachment-free PostHog metadata
```

## Inspect events during development

Set `DEV_FAST_REVIEW_TELEMETRY_DEBUG` to `1` or `true` to see the events that
Review emits. Review then prints one line for each event to stderr:

```
[review-telemetry] {"event":"review_command_succeeded","distinctId":"…","properties":{…}}
```

The sink replaces PostHog. Review sends nothing to PostHog while the switch is
on. Set the variable before you start Review Desktop, because most events come
from the local server, not from the CLI.

The sink ignores the opt-out rules above, because the sink does not send the
events. The sink also does not record the `review_installation_created` event as
sent, so the real event still goes out on the next normal run.

## Event reference

### Common properties

Every event from the Review telemetry API includes these properties:

| Property         | Value                                                              |
| ---------------- | ------------------------------------------------------------------ |
| `cli_version`    | Review CLI package version (`version` repeats it for one release)  |
| `app_version`    | Review Desktop release version; absent for the standalone CLI      |
| `channel`        | `stable`, `preview`, or `dev` for an unpackaged build              |
| `environment`    | `production`, `ci`, `internal`, `e2e`, or `smoke`                  |
| `surface`        | `desktop`, `cli`, `headless`, `mcp`, or `api`                      |
| `node_major`     | Node major version                                                 |
| `platform`       | Node platform enum                                                 |
| `arch`           | Node architecture enum                                             |
| `os_version`     | Kernel release string                                              |
| `ci`             | Boolean                                                            |
| `internal`       | Boolean for a dev.fast workspace build or a stored internal marker |
| `app_session_id` | One UUIDv7 per Desktop launch, shared by every Desktop process     |
| `install_age_days` | Whole days since this installation id was created (for an install older than this field, since the first run that recorded it) |
| `$session_id`    | The same id as `app_session_id`, so PostHog groups a launch's events into one session; absent when the id is not a UUIDv7 |
| `$process_person_profile` | `false` until this installation is aliased to a GitHub account (see "Identity and storage"), then `true` |

`environment` is the first that applies: `smoke` or `e2e` (test harness), `ci`
(`CI` set), `internal`, `production`.

UI events also include `source: review_app`.

Review-scoped events can also include `review_id`. Events routed through a
specific Desktop Review session can include both `review_id` and
`presentation_id`. Global main-process and renderer errors remain unscoped;
Review does not guess which open Review caused them.

`review_telemetry_dropped` carries the envelope of the process that dropped the
events.

### CLI and lifecycle events

| Event                            | Additional properties                                     | When                                              |
| --------------------------------- | ---------------------------------------------------------- | --------------------------------------------------- |
| `review_installation_created`     | None                                                        | The first enabled Review use                        |
| `review_command_started`          | `command_path`, `command_run_id`, `agent_kind`              | A public CLI handler is about to run                |
| `review_command_succeeded`        | `command_path`, `command_run_id`, `exit_code`, `duration_ms`, and closed command flags | A public CLI command succeeds       |
| `review_command_failed`           | The success properties plus `error_name` and `error_category` closed enums | A public CLI command fails          |
| `review_session_started`          | `review_id`, `presentation_id`, `app_session_id`            | A review opens in the Desktop canvas                |
| `review_review_presented`         | `load_ms`, `review_id`, `presentation_id`                   | The canvas signals ready                            |
| `review_first_review_presented`   | `review_id`, `presentation_id`                              | The first presented review on this installation     |
| `review_session_ended`            | `outcome`, `duration_ms`, `review_id`, `presentation_id`    | The review closes; see outcomes below               |
| `review_review_reaped`            | `retention_days`                                            | Retention deletes a dismissed review                |
| `review_telemetry_dropped`        | `reason`, `count`                                           | The queue drops one or more events                  |
| `review_crash`                    | `process` in `renderer`, `gpu`, `utility`, `server`, `unknown`; `reason` (≤40 chars); `exit_code`; `uptime_ms`; `source` in `live`, `minidump` | A Review process dies, or an uncovered dump is found on the next launch |
| `review_hang_started`             | None                                                        | A Desktop window stops responding                    |
| `review_hang_ended`               | `duration_ms`                                               | The window responds again, its process dies, or it closes |
| `review_ui_stall`                 | `duration_ms`; `process` in `renderer`, `canvas` (`canvas` is allowlisted but not sent — it shares the workbench thread); `phase` in `startup`, `running` | The main thread lags 2 seconds or more behind a timer tick; capped at 5 per session |
| `review_app_ready`                | `duration_ms`                                                | The workbench restores, timed from the startup trace; once per Desktop launch |
| `review_error_burst`              | `message_hash`, `suppressed`                                 | A `review_client_error` passes 5 reports for one message in one session; see "Error reports" |
| `review_open_timeout`             | `elapsed_ms`, `review_id`, `presentation_id`                 | A session starts and no presented or ended event follows within 30 seconds |
| `review_review_created`           | `via` in `api`, `mcp`, `other`; `kind` in `review`, `scratchpad`; `blocks`; optional `agent_kind` | A review or scratchpad is created; `via` is `other` for Desktop's own UI |
| `review_review_published`         | `version`                                                    | A review is published for sharing                    |
| `review_review_revoked`           | None                                                         | A share link is revoked                               |
| `review_authoring_completed`      | `duration_ms`; optional `agent_kind`                         | The first publish of a review created via `api` or `mcp`, timed from its creation |
| `review_mcp_tool_called`          | `tool`; `via` in `api`, `mcp`; `ok`; `duration_ms`           | An agent calls a Review authoring tool                |
| `review_login_started`            | None                                                          | Desktop GitHub sign-in begins                         |
| `review_login_succeeded`          | None                                                          | Desktop GitHub sign-in finishes                       |
| `review_login_failed`             | `reason` in `did_not_finish`, `error`                        | Desktop GitHub sign-in fails                          |
| `$exception`                      | Same fields as `review_client_error`, in PostHog's error-tracking shape | Sent alongside every `review_client_error`, for one release |
| `$create_alias`                   | `alias`, `$process_person_profile: true`                     | The first GitHub sign-in on this installation; see "Identity and storage" |

`review_session_started` also carries `source_kind`, which the server sets from
the opened review. `agent_kind` is allowlisted but not yet sent.

| `outcome`   | Meaning                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `closed`    | The tab closed or another review replaced it                                                                                                |
| `dismissed` | The open review was dismissed while its session was active                                                                                  |
| `deleted`   | The open review was deleted while its session was active                                                                                    |
| `app_quit`  | The Desktop quit, or reloaded, with the review open                                                                                          |
| `abnormal`  | The Desktop died with the review open. Sent by the next launch, without `duration_ms`, with the dead launch's envelope and `app_session_id` |

`command_path` is a closed enum for all public commands. It includes `help`,
`version`, `app.launch`, `app.pick`, `info`, `instances`, `instances.use`,
`instances.clear`, `connect`, `migrate.apply`,
`map.open`, `map.check`, `map.prune`, `map.push`, `map.fetch`, `login`,
`logout`, `whoami`, `trace.store.create`, `trace.store.delete`,
`trace.store.info`, `trace.install`, `trace.allow`, `trace.deny`,
`trace.storage.use`, `trace.config.migrate`, `api`, `mcp`, `server.start`, and
`invalid`. Review sends no arguments, refs, tokens, or storage credentials.
`surface` is `headless` for `server.start`, `mcp` for `mcp`, `api` for `api`,
and `cli` otherwise, on every event the command's process sends.

The `command`, `subcommand`, `mode`, `has_base_ref`, `has_head_ref`, and
`force` flags accompany only `map.*` commands.

The CLI writes `review_command_started` to the disk queue before entering the
command handler. The queue normally begins its background flush after five
seconds; Review does not wait for network delivery before starting the command.

Error names and categories are closed enums. A failed command sends no exception
message, stack, path, process output, project identifier, or remediation text.
Only the `review_client_error` and `review_update_failed` events carry message
text, and only as described in "Error reports".

- Error names: `usage_error`, `review_not_found`, `review_state_error`,
  `repository_error`, `desktop_connection_error`, `network_error`,
  `storage_error`, `index_error`, `process_error`, and `unexpected_error`.
- Error categories: `user_input`, `local_state`, `dependency`, `transport`, and
  `internal`.
- Queue drop reasons: `queue_full`, `expired`, `corrupt`,
  `permanent_rejection`, and `storage_failure`.
- Session sources: `worktree`, `commits`, and `scratchpad`. Agent kinds are
  `codex`, `claude`, `pi`, and `other`.

### Desktop and canvas events

The server checks all properties in this table against
`packages/review/src/ui-telemetry-events.ts`. Session lifecycle events are
listed under [CLI and lifecycle events](#cli-and-lifecycle-events).

| Event                             | Additional properties                                                                                                                                          | When                                         |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `review_app_opened`               | None                                                                                                                                                           | The canvas app opens                         |
| `review_tab_viewed`               | `tab` in review, commits, map, files; `duration_ms`; `reason` in tab_change, visibility_hidden, pagehide, unmount                                              | A tab dwell period ends                      |
| `review_diff_viewed`              | `duration_ms`                                                                                                                                                  | A files tab dwell period ends; the server derives it from `review_tab_viewed`, the canvas does not send it |
| `review_peek_opened`              | `via` in prose_link, diagram, map, db_lens, call_stack_frame                                                                                                   | A user opens a code peek                     |
| `review_peek_resolved`            | `root_kind` in range                                                                                                                                            | A code peek resolves                         |
| `review_peek_resolve_failed`      | `root_kind` in range                                                                                                                                            | A code peek does not resolve                 |
| `review_diff_opened`              | `kind` in commit, file, structural; `via` in topbar, lens, locate                                                                                              | A user opens a diff view                     |
| `review_scratchpad_opened`        | None                                                                                                                                                           | The one scratchpad document opens            |
| `review_discord_clicked`          | `via` in topbar, dialog, docs                                                                                                                                 | A user clicks a Discord invite               |
| `review_discord_dialog_shown`     | None                                                                                                                                                           | The community invite dialog opens            |
| `review_discord_dialog_dismissed` | None                                                                                                                                                           | The community invite dialog closes unaccepted |
| `review_review_shared`            | None                                                                                                                                                           | A user copies a review's share link          |
| `review_review_deleted`           | `via` in home                                                                                                                                                  | A user deletes a stored review from Home     |
| `review_tour_started`             | `steps`                                                                                                                                                        | A user starts a tour                         |
| `review_tour_step_advanced`       | `step`, `steps`                                                                                                                                                | A user moves to the next tour step           |
| `review_tour_abandoned`           | `step`, `steps`                                                                                                                                                | A user closes an incomplete tour             |
| `review_tour_completed`           | `steps`                                                                                                                                                        | A user completes a tour                      |
| `review_map_expanded`             | `level` in system, container, component, code                                                                                                                  | A user expands a map element                 |
| `review_commit_expanded`          | `expanded`                                                                                                                                                     | A user expands or collapses a commit         |
| `review_commit_diff_opened`       | `via` in row, file, footer                                                                                                                                     | A user opens a commit diff                   |
| `review_source_tree_opened`       | `via` in topbar, home                                                                                                                                          | A user opens the source tree                 |
| `review_client_error`             | See "Error reports"                                                                                                                                            | A part of Review reports an error            |
| `review_update_started`           | Random `update_attempt_id`, `target_version`                                                                                                                   | An update is downloaded and ready to install |
| `review_update_completed`         | Start properties plus `duration_ms`                                                                                                                            | The downloaded target launches after restart |
| `review_update_failed`            | `phase` in check, download, install; `message_source` in electron, request, shipit, fallback; optional start properties and `duration_ms`; see "Error reports" | An update check, download, or install fails  |
| `review_bug_report_dialog_opened` | None                                                                                                                                                           | A user opens the bug report dialog           |
| `review_bug_report_cancelled`     | None                                                                                                                                                           | A user closes the dialog without a report    |
| `review_bug_report_send_failed`   | Short `error_name`                                                                                                                                             | A bug report request fails                   |
| `review_setting_changed`          | `setting` in telemetry_enabled, keymap, dismissed_retention_days, software_map_enabled, scratchpad_enabled, diffr_config, structural_diff, theme; `enabled`; `value` in dark, light, system (theme only) | A user changes a Review setting              |
| `review_review_opened`            | `via` in home, cli, other                                                                                                                                      | A user opens a review                        |
| `review_home_empty_state_viewed`  | None                                                                                                                                                           | The empty Home state opens                   |

The canvas emits `review_review_dismissed`, `review_review_restored`, and
`review_review_deleted` from Home's actions. `review_review_dismissed`'s `via`
is `home` today; `review_topbar` is allowlisted but not yet sent.
`review_review_restored`'s `via` is `home` in the current build; `open` — the
implicit undo, where opening a dismissed review brings it back — is
allowlisted but not yet sent.

## Hangs and stalls

Three explicit signals replace the old inferred gap queries:

- `review_hang_started` and `review_hang_ended{duration_ms}`, from Electron's
  window `unresponsive` and `responsive` events.
- `review_ui_stall{duration_ms, process, phase}`, from a main-thread timer-lag
  watchdog in the workbench, threshold 2 seconds, capped at 5 per session.
- `review_open_timeout{elapsed_ms}`, from the server when a review session
  starts and no `review_review_presented` or `review_session_ended` follows
  within 30 seconds.

A Desktop session that never ends cleanly still arrives as
`review_session_ended{outcome:"abnormal"}`: Review records open sessions under
`${DEV_REVIEW_HOME:-~/.dev}/telemetry`, and the next launch reports any its
predecessor left open. A workbench reload also ends its session with
`outcome:"app_quit"`, the same as quitting; the health dashboard's session and
lifecycle insights drop an `app_quit` immediately followed by a new session in
the same `app_session_id`, so a reload is never counted as a failure.

### Workbench events

| Event                             | Additional properties                                                                                                                                                                                                                       | When                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `review_lsp_used`                 | `feature` in hover, goto_definition, peek_definition, goto_type_definition, goto_implementation, references, rename, format, code_action, symbol_search; `via` in command, mouse; `language`; `editor_kind` in files_tab, inline_peek, diff | A user invokes an LSP feature           |
| `review_ls_activated`             | `group` in python, go, rust, swift, csharp; `ok`                                                                                                                                                                                            | A language server activation check ends |
| `review_extension_installed`      | Allowlisted `extension_id`; `trigger` in user, auto_upgrade, startup_seed, keymap, rollback; `cached`; `duration_ms`                                                                                                                        | An optional extension installs          |
| `review_extension_install_failed` | Allowlisted `extension_id`; allowlisted `trigger`; `phase` in download, install                                                                                                                                                             | An optional extension install fails     |
| `review_extension_enabled`        | Allowlisted `extension_id`; allowlisted `trigger`                                                                                                                                                                                           | Review enables an optional extension    |
| `review_extension_disabled`       | Allowlisted `extension_id`; allowlisted `trigger`                                                                                                                                                                                           | Review disables an optional extension   |
| `review_extension_uninstalled`    | Allowlisted `extension_id`; allowlisted `trigger`                                                                                                                                                                                           | Review uninstalls an optional extension |

The `language` property is one of typescript, javascript, python, go, rust,
swift, csharp, json, css, html, markdown, yaml, toml, shell, sql, or other.
The allowlisted extension identifiers are `vscodevim.vim`,
`tuttieee.emacs-mcx`, `ms-python.python`, `astral-sh.ty`,
`charliermarsh.ruff`, `golang.go`, `rust-lang.rust-analyzer`,
`swiftlang.swift-vscode`, `llvm-vs-code-extensions.lldb-dap`,
`muhammad-sammy.csharp`, and `ms-dotnettools.vscode-dotnet-runtime`. Review
does not send an extension version.

## Error reports

Review reports its own failures so that a defect that only happens on your
machine can still be found and fixed. Four parts of Review report an error: the
app window, the canvas, the background process, and a crash that happens before
Review can start. The canvas shares the app window, so an uncaught error there
is reported once, by the app window; the canvas reports only errors it catches
itself.

Every `review_client_error` also sends the same fields as a PostHog
`$exception`, so PostHog's error tracking and the custom event agree;
`review_client_error` keeps sending for one release, then is removed. The
server keeps a per-session budget of 5 reports for one `message_hash`; past that,
Review sends one `review_error_burst{message_hash, suppressed}` in its place
and drops the rest, so one repeating error cannot count as thousands.

Review sends these properties with the `review_client_error` event. A
`review_update_failed` event uses the same server-side message cleaning and
fingerprinting, plus the closed update phase and message-source fields above.
Install failures read at most 64 KiB appended to ShipIt's stderr log after the
matching update was staged. Review extracts only the last NSError summary (or
the fixed retry-exhausted line); it neither stores nor uploads the raw log.

| Property        | Value                                                                                |
| --------------- | ------------------------------------------------------------------------------------ |
| `error_process` | Which part of Review failed: `main`, `renderer`, `canvas`, or `server`               |
| `error_source`  | Which handler caught it, from a closed list                                          |
| `error_name`    | The error class name, such as `TypeError`. Identifier characters only, 40 at most    |
| `component`     | A fixed Review component name, when the reporter has one. Identifier characters only |
| `message`       | The error message, cleaned. See below                                                |
| `message_hash`  | A fingerprint of the original message. See below                                     |
| `frames`        | Up to 10 stack lines, all inside the Review program. See below                       |

**Review cleans the message before it sends it.** The cleaner replaces each of
these with a marker that names what it removed, such as
`<REDACTED: user-file-path>`:

- any file path, on macOS, Linux, or Windows,
- your home directory and your temporary directory, which are removed outright,
- any web address, e-mail address, or text matching a known secret format, such
  as an access token or a private key.

So `ENOENT: no such file or directory, open '/Users/you/work/notes.md'` is sent
as `ENOENT: no such file or directory, open '<REDACTED: user-file-path>'`.

The cleaner is Microsoft's, taken from VS Code, which Review is built on. Review
uses it rather than a rule of its own so that you can check it against a known
implementation. The copy is in
`packages/review/src/telemetry-clean-text.ts`, and its header lists
every difference from the original.

Two rules sit on top of the cleaner:

- **Review sends no message for an error that quotes a review document.** A
  review tool checks authored text against a schema, and those errors repeat the
  text they rejected. Review keeps the error class, the fingerprint, and the
  stack lines for these, and drops the message.
- **Review sends no message the cleaner did not finish.** After cleaning, Review
  checks the result again for a path or a secret. If it finds one, the message
  is dropped. This is a second, separate check, so a fault in the cleaner cannot
  by itself put a path on the wire.

**`message_hash` is a fingerprint of the original message**: the first 16
characters of a one-way SHA-256 digest. It is sent whether or not the message
survives, so reports whose message was dropped still group together. The digest
cannot be turned back into the message.

**Review sends only its own stack frames.** Each frame reads as
`file:line:column`, where the file is a path inside the Review program, such as
`vs/review/browser/workbench.js:456:12`. Review finds the shipped program
directory in each frame and discards everything before it, which removes your
home directory. It then keeps a frame only when the result starts inside a known
Review directory. A frame in your repository, in `node_modules`, or in an
extension is dropped whole, not shortened.

The local Review server does this work, and the event allowlist checks every
frame a second time. Both steps run on your machine, before anything is sent.

### Crash reports

When a Review process dies, Review records a `review_crash` with the process
kind, Electron's reason code, and the exit code — no message or stack.
Electron also writes a local minidump under `<user data>/review-crashes`,
never uploaded from Electron itself. On the next launch, an uncovered dump
(one no live crash already reported) is counted too, as
`review_crash{process:"unknown", source:"minidump"}`, and uploaded to the
bug-report service (`bug.dev.fast`) with the telemetry envelope as metadata,
then deleted; a dump older than seven days is deleted without upload. With
telemetry off, dumps are still deleted but never uploaded, and no
`review_crash` is reported for them. A minidump contains process memory and
can include source text open in Review at the time of the crash. Reports are
stored for 30 days.

The Worker sends its own `review_crash_uploaded` event once a dump is stored,
with the report ID, the report date, and the same crash and envelope fields —
never the dump itself.

## User-initiated bug reports

The **Report bug** dialog sends data only after the user selects **Send**. The
description is optional. It has one **Review** consent control for both the
current review source and head software map source, plus a separate control for
changed-file diffs. Both controls are on by default. Review also captures a
screenshot before the dialog opens and attaches it by default. The dialog shows
a removable preview and accepts a replacement image by paste or drag.

**Agent session trace attachment is not available yet.** The dialog has no
trace control, and reports never include agent traces.

A review does not always have a software map. The report then omits the map and
records no error, because an absent map is a normal state.

The report payload contains these fields:

| Field                              | Value                                                                               |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| `schema_version`                   | Internal report payload format version                                              |
| `description`                      | Optional user-entered description, limited to 64 KiB of UTF-8 data                  |
| `screenshot.mime`                  | `image/jpeg` when a screenshot is attached                                          |
| `screenshot.base64`                | JPEG screenshot data, limited to 3 MiB decoded                                      |
| `review`                           | Current selected review source, when the user consents and it is available          |
| `review["<file name>"]`            | One review source file as text: the current document and its TypeScript modules     |
| `map`                              | Canonical head software map note source, when the user consents and it is available |
| `diff.baseRef`                     | Base revision for the changed-file diffs, when one is available                     |
| `diff.headRef`                     | Head revision for the changed-file diffs, when one is available                     |
| `diff.files[].path`                | Current changed-file path                                                           |
| `diff.files[].previousPath`        | Previous path for a renamed file, when one is available                             |
| `diff.files[].status`              | Changed-file status                                                                 |
| `diff.files[].additions`           | Added line count                                                                    |
| `diff.files[].deletions`           | Deleted line count                                                                  |
| `diff.files[].patch`               | Unified patch used to resolve the review's exact CodePeek ranges                    |
| `diagnostics.app_version`          | Review Desktop product version                                                      |
| `diagnostics.cli_version`          | `@dev.fast/review` package version                                                  |
| `diagnostics.platform`             | Node platform enum                                                                  |
| `diagnostics.app_session_id`       | Random identifier for the canvas window                                             |
| `diagnostics.client_error_names`   | Last 20 sanitized JavaScript error class names from that canvas session             |
| `diagnostics.attachment_errors`    | Selected attachment names with the value `unavailable`                              |
| `diagnostics.review_omitted_files` | Names of review source files the report did not send                                |

The `review` field holds a file map. It contains the current review document and
the TypeScript modules beside it, because the document alone cannot render: the
anchors live in those modules. The report sends at most 20 files. It drops a
file larger than 2 MiB. It lists the name of each dropped file in
`diagnostics.review_omitted_files`.

The report never sends these review files:

- `review.json`, which holds a local directory path and the pull request URL
- the compiled document in `.bundle/`, and the build output in `.build/`
- `review.db`, a local database that earlier versions kept beside the review

The Worker stores reports in a private Cloudflare R2 bucket. Only credentialed
dev.fast operators can read the bucket. Reports are deleted after 90 days.

After storage completes, the Worker sends a `review_bug_report` PostHog event
with the report ID, date, app version, platform, sizes, attachment presence, and
truncation flags. The event does not contain the description or attachments.

Cloudflare uses `CF-Connecting-IP` only as the rate-limit key. The Worker does
not store that value in R2. The Worker does not send it to PostHog as report
data. The limit is five report attempts per minute for each client IP.

An explicit bug report submission overrides the passive telemetry opt-out.
The local server sends this report even when Review telemetry is off. The
passive event allowlist and telemetry disk queue do not process bug reports.

## Code locations

| Concern                    | File                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| Telemetry API and identity | `packages/review/src/review-telemetry.ts`                                                      |
| Batch queue                | `packages/review/src/posthog-capture-client.ts`                                                |
| Opt-out rules              | `packages/review/src/telemetry-config.ts`                                                      |
| Developer sink             | `packages/review/src/telemetry-debug-sink.ts`                                                  |
| UI allowlist               | `packages/review/src/ui-telemetry-events.ts`                                                   |
| Error message and frames   | `packages/review/src/error-telemetry.ts`                                                       |
| Message cleaner (VS Code)  | `packages/review/src/telemetry-clean-text.ts`                                                  |
| Error reporting rules      | `apps/review-desktop/code-oss/src/vs/review/common/reviewErrorReport.ts`                       |
| Pre-start crash note       | `apps/review-desktop/code-oss/src/vs/review/node/reviewBootstrapBreadcrumb.ts`                 |
| Desktop setting            | `apps/review-desktop/code-oss/src/vs/review/common/reviewConfiguration.ts`                     |
| Settings screen            | `packages/review/app/src/settings-page.tsx`                                                    |
| First-use notice           | `apps/review-desktop/code-oss/src/vs/review/contrib/telemetry/reviewTelemetry.contribution.ts` |
| Error budget and bursts    | `packages/review/src/server/client-error-budget.ts`                                            |
| Account alias              | `packages/review/src/server/account-alias.ts`                                                  |
| Review lifecycle events    | `packages/review/src/server/review-lifecycle-telemetry.ts`                                     |
| Open-timeout watchdog      | `packages/review/src/server/review-open-watchdog.ts`                                           |
| Crash dump upload          | `packages/review/src/server/crash-report.ts`                                                   |
| Crash and hang listeners   | `apps/review-desktop/code-oss/src/vs/review/electron-main/reviewCrashTelemetry.ts`              |
| Crash dump reconciliation  | `apps/review-desktop/code-oss/src/vs/review/electron-main/reviewCrashDumps.ts`                  |
| Main-thread stall watchdog | `apps/review-desktop/code-oss/src/vs/review/common/reviewStallWatchdog.ts`                      |
