# Telemetry

Whiteboard collects a small amount of anonymous usage and reliability data. We
use it to learn which parts of Whiteboard are useful and where the app is
failing.

This page is the complete public contract for Whiteboard app and `whiteboard`
CLI telemetry.
For a shorter overview of all product data, including local files, coding
agents, and bug reports, see [Privacy](privacy.md).

Last checked against this repository: 2026-09-24.

## The short version

- Anonymous telemetry is on by default and can be turned off at any time.
- Whiteboard records actions such as opening a whiteboard, changing tabs, using code
  navigation, or completing a CLI command. Values are limited to fixed
  categories, booleans, counts, durations, versions, and opaque identifiers.
- Passive telemetry never includes your code, diffs, file paths, repository
  name, whiteboard title, refs, revision hashes, whiteboard ID, coding-agent
  session ID, whiteboard text, prompts, or model output.
- Whiteboard uses a random installation ID, never your email, username,
  hostname, or a hardware identifier. Signing in with GitHub links
  installations of the same account through a one-way hash.
- Product errors may include a cleaned error message and stack frames from
  Whiteboard's shipped program. Paths, web and email addresses, and recognizable secrets are removed
  on your machine before the event is accepted.
- Sending a bug report is a separate, explicit action. You see and control its
  attachments before anything is uploaded.

Whiteboard sends anonymous telemetry to PostHog. PostHog may derive a coarse
location during ingestion; our project discards the source IP.

## Turn telemetry off

In Whiteboard, open **Preferences → Settings** and disable **Share anonymous
usage data**. The setting controls both the app and the `whiteboard` CLI on
that installation. Disabling it also clears any queued events that have
not been sent.

For a single command, a shell, or a headless environment, set `DO_NOT_TRACK`:

```sh
DO_NOT_TRACK=1 whiteboard info
```

Whiteboard also honors these variables when their value is `1` or `true`:

- `DO_NOT_TRACK`
- `DNT`
- `PROGRESSIVE_REVIEW_TELEMETRY_DISABLED`
- `DEV_FAST_TELEMETRY_DISABLED`
- `DEV_FAST_PROGRESSIVE_REVIEW_TELEMETRY_DISABLED`
- `DEV_FAST_REVIEW_TELEMETRY_DISABLED`

The desktop app sets `DEV_FAST_REVIEW_TELEMETRY_DISABLED` for its own server
from the in-app setting, so setting that one variable in your shell does not
turn off app telemetry. Use `DO_NOT_TRACK` or the setting instead.

Tests also turn telemetry off with `VITEST=1` or `NODE_ENV=test`.

An explicit bug report is still sent if you choose **Send** in the bug-report
dialog. Bug reports do not pass through the passive telemetry system.

## What Whiteboard collects

| Category           | Examples                                                  | What is not included                                       |
| ------------------ | --------------------------------------------------------- | ---------------------------------------------------------- |
| App usage          | A whiteboard opened, a tab viewed, a map expanded         | Whiteboard text, code, paths, or repository details        |
| CLI usage          | Command category, success or failure, duration            | Command arguments, refs, process output, or exception text |
| Code navigation    | Feature category, language category, editor surface       | Symbols, declarations, search text, or source code         |
| Extensions         | An allowlisted extension ID, install outcome and duration | Extension version, configuration, or extension data        |
| Whiteboard outcome | Dismiss, restore, or delete                               | Whiteboard text or reviewer identity                       |
| Reliability        | Error class, cleaned message, shipped-program frames      | User paths, repository frames, secrets, or authored text   |

Every event is checked against an allowlist on your machine. Unknown events,
unknown properties, and values outside their allowed categories are dropped.
The full event-by-event list begins at [Event reference](#event-reference).

## Identity and storage

On first use, Whiteboard creates a random installation UUID and stores it at
`${DEV_REVIEW_HOME:-~/.dev}/telemetry/progressive-review.json`. It does not call
PostHog's `identify()` API. Events carry `$process_person_profile: false`, so
PostHog keeps no person profile.

**Account alias.** The first GitHub sign-in (in the app or with
`whiteboard login`) sends one `$create_alias` linking the installation ID to
`gh_` plus a one-way HMAC of the account ID. The account ID, login, and email
never leave the machine. After that, events carry
`$process_person_profile: true`, so installations signed into the same account
share one PostHog person. Later sign-ins to other accounts and sign-outs change
nothing.

Whiteboard Preview keeps a separate installation ID in
`telemetry/progressive-review.preview.json`. The standalone CLI always uses the
stable ID.

Pending events are kept in a local queue under
`${DEV_REVIEW_HOME:-~/.dev}/telemetry/events`. The queue holds at most 1,000
events, retries temporary failures, and deletes events after seven days. Each
event keeps one random `uuid` across retries, so PostHog ingests a resent event
once, and its `timestamp` is when it happened, not when it was sent. A
`review_telemetry_dropped` count is queued the same way, so a resent count
lands once too.
Telemetry is best-effort and never blocks Whiteboard from working.

Three identifiers support exact lifecycle correlation without PostHog identity
or group profiles:

- `command_run_id` is a new random UUID for each CLI invocation.
- `review_id` is `rv_` plus 128 bits of a namespaced HMAC of the whiteboard's
  ID.
- `presentation_id` is `pr_` plus 128 bits of a namespaced HMAC of the ID of
  one opening of a whiteboard in the app.

The HMAC key is the random installation ID. The same whiteboard therefore has
a stable `review_id` only on one installation; another installation produces a
different value. The raw IDs are used only inside the local server and never
reach the capture client.

Whiteboard disables the built-in Microsoft telemetry inherited from Code -
OSS. A hardening test enforces that rule.

## How events leave the app

The canvas and desktop window do not connect directly to PostHog. They send
events to Whiteboard's local server, which checks the allowlist before adding an
event to the queue. The CLI uses the same queue and transport.

```text
Whiteboard app    ──┐
Whiteboard canvas ──┼─→ local allowlist ─→ disk queue ─→ PostHog
whiteboard CLI    ──┘
```

User-initiated bug reports take a separate path:

```text
Whiteboard ─→ local server ─→ bug.dev.fast ─→ private Cloudflare R2
                                      └─→ attachment-free PostHog metadata
```

## Inspect events during development

Set `DEV_FAST_REVIEW_TELEMETRY_DEBUG` to `1` or `true` to see the events that
Whiteboard emits. Whiteboard then prints one line for each event to stderr:

```
[review-telemetry] {"event":"review_command_succeeded","distinctId":"…","properties":{…}}
```

The sink replaces PostHog. Whiteboard sends nothing to PostHog while the switch
is on. Set the variable before you start Whiteboard, because most events come
from the local server, not from the CLI.

The sink ignores the opt-out rules above, because the sink does not send the
events. The sink also does not record the `review_installation_created` event as
sent, so the real event still goes out on the next normal run.

## Event reference

### Common properties

Every event from the Whiteboard telemetry API includes these properties:

| Property                  | Value                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `cli_version`             | CLI package version (`version` repeats it for one release)                                                                |
| `app_version`             | Whiteboard app release version; absent for the standalone CLI                                                             |
| `channel`                 | `stable`, `preview`, or `dev` for an unpackaged build                                                                     |
| `environment`             | `production`, `ci`, `internal`, `e2e`, or `smoke`                                                                         |
| `surface`                 | `desktop`, `cli`, `headless`, `mcp`, or `api`                                                                             |
| `node_major`              | Node major version                                                                                                        |
| `platform`                | Node platform enum                                                                                                        |
| `arch`                    | Node architecture enum                                                                                                    |
| `os_version`              | Kernel release string                                                                                                     |
| `ci`                      | Boolean                                                                                                                   |
| `internal`                | Boolean for a dev.fast workspace build or a stored internal marker                                                        |
| `app_session_id`          | One UUIDv7 per app launch, shared by every app process                                                                    |
| `install_age_days`        | Whole days since this installation ID was created (for an older installation, since the first run that recorded it)       |
| `$session_id`             | The same ID as `app_session_id`, so PostHog groups a launch's events into one session; absent when the ID is not a UUIDv7 |
| `$process_person_profile` | `false` until this installation is aliased to a GitHub account (see "Identity and storage"), then `true`                  |

`environment` is the first that applies: `smoke` or `e2e` (test harness), `ci`
(`CI` set), `internal`, `production`. These variables set it and `channel`:

- `DEV_FAST_REVIEW_TELEMETRY_ENV`: `e2e` or `smoke` for a test harness. Other
  values are ignored.
- `DEV_FAST_REVIEW_CHANNEL`: set by the app for its server to `stable`,
  `preview`, or `dev`.
- `PROGRESSIVE_REVIEW_TELEMETRY_INTERNAL`: `1` marks telemetry as internal and
  `0` as external, overriding the stored marker and workspace detection.

The event names predate the Whiteboard name and are unchanged. UI events also
include `source: review_app`.

Events about one opened whiteboard also include `review_id` and
`presentation_id`. Global main-process and renderer errors remain unscoped;
Whiteboard does not guess which open whiteboard caused them.

`review_telemetry_dropped` carries the common properties of the process that
dropped the events.

### CLI and lifecycle events

| Event                           | Additional properties                                                                                                                          | When                                                                                         |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `review_installation_created`   | None                                                                                                                                           | The first enabled Whiteboard use                                                             |
| `review_command_started`        | `command_path`, `command_run_id`, `agent_kind`                                                                                                 | A public CLI handler is about to run                                                         |
| `review_command_succeeded`      | `command_path`, `command_run_id`, `exit_code`, `duration_ms`                                                                                   | A public CLI command succeeds                                                                |
| `review_command_failed`         | The success properties plus `error_name` and `error_category` closed enums                                                                     | A public CLI command fails                                                                   |
| `review_telemetry_dropped`      | `reason`, `count`                                                                                                                              | The queue drops one or more events                                                           |
| `review_session_started`        | `source_kind`, `review_id`, `presentation_id`                                                                                                  | A whiteboard opens in the app canvas                                                         |
| `review_review_presented`       | `load_ms`, `review_id`, `presentation_id`                                                                                                      | The canvas signals ready                                                                     |
| `review_first_review_presented` | `review_id`, `presentation_id`                                                                                                                 | The first presented whiteboard on this installation                                          |
| `review_session_ended`          | `outcome`, `duration_ms`, `review_id`, `presentation_id`                                                                                       | The whiteboard closes; see outcomes below                                                    |
| `review_crash`                  | `process` in `renderer`, `gpu`, `utility`, `server`, `unknown`; `reason` (≤40 chars); `exit_code`; `uptime_ms`; `source` in `live`, `minidump` | A Whiteboard process dies, or an uncovered dump is found on the next launch                  |
| `review_hang_started`           | None                                                                                                                                           | An app window stops responding                                                               |
| `review_hang_ended`             | `duration_ms`                                                                                                                                  | The window responds again, its process dies, or it closes                                    |
| `review_app_ready`              | `duration_ms`                                                                                                                                  | The workbench restores, timed from the startup trace; once per app launch                    |
| `review_error_burst`            | `message_hash`, `suppressed`                                                                                                                   | A `review_client_error` passes 5 reports for one message in one session; see "Error reports" |
| `review_open_timeout`           | `elapsed_ms`, `review_id`, `presentation_id`                                                                                                   | A session starts and no presented or ended event follows within 30 seconds                   |
| `review_review_created`         | `via` in `api`, `mcp`, `other`; `kind` in `review`, `scratchpad`; `blocks`; optional `agent_kind`                                              | A whiteboard or the scratchpad is created; `via` is `other` for the app's own UI             |
| `review_review_published`       | `version`                                                                                                                                      | A whiteboard is published for sharing                                                        |
| `review_review_revoked`         | None                                                                                                                                           | A share link is revoked                                                                      |
| `review_authoring_completed`    | `duration_ms`; optional `agent_kind`                                                                                                           | The first publish of a whiteboard created via `api` or `mcp`, timed from its creation        |
| `review_mcp_tool_called`        | `tool`; `via` in `api`, `mcp`; `ok`; `duration_ms`                                                                                             | An agent calls a Whiteboard authoring tool                                                   |
| `review_login_started`          | None                                                                                                                                           | GitHub sign-in in the app begins                                                             |
| `review_login_succeeded`        | None                                                                                                                                           | GitHub sign-in in the app finishes                                                           |
| `review_login_failed`           | `reason` in `did_not_finish`, `error`                                                                                                          | GitHub sign-in in the app fails                                                              |
| `$exception`                    | Same fields as `review_client_error`, in PostHog's error-tracking shape                                                                        | Sent alongside every `review_client_error`, for one release                                  |
| `$create_alias`                 | `alias`, `$process_person_profile: true`                                                                                                       | The first GitHub sign-in on this installation; see "Identity and storage"                    |

`source_kind` is `worktree`, `commits`, or `scratchpad`, set by the server from
the opened whiteboard. `agent_kind` is allowlisted for session events but not
yet sent.

| `outcome`   | Meaning                                                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `closed`    | The tab closed or another whiteboard replaced it                                                                                                     |
| `dismissed` | The open whiteboard was dismissed while its session was active                                                                                       |
| `deleted`   | The open whiteboard was deleted while its session was active                                                                                         |
| `app_quit`  | The app quit, or reloaded, with the whiteboard open                                                                                                  |
| `abnormal`  | The app died with the whiteboard open. Sent by the next launch, without `duration_ms`, with the dead launch's common properties and `app_session_id` |

`command_path` is a closed enum: `help`, `version`, `app.launch`, `app.pick`,
`info`, `connect`, `instances`, `instances.use`, `instances.clear`,
`migrate.apply`, `login`, `logout`, `whoami`,
`trace.store.create`, `trace.store.delete`, `trace.store.info`,
`trace.install`, `trace.allow`, `trace.deny`, `trace.storage.use`,
`trace.config.migrate`, `api`, `mcp`, `server.start`, and `invalid`. Other
commands, such as `share` and `status`, send no command events. Whiteboard
sends no arguments, refs, tokens, or storage credentials. `surface` is
`headless` for `server.start`, `mcp` for `mcp`, `api` for `api`, and `cli`
otherwise, on every event the command's process sends.

The CLI writes `review_command_started` to the disk queue before entering the
command handler. The queue normally begins its background flush after five
seconds; Whiteboard does not wait for network delivery before starting the command.

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
- Agent kinds: `codex`, `claude`, `pi`, and `other`.

### Desktop and canvas events

The server checks all properties in this table against
`packages/review/src/ui-telemetry-events.ts`.

| Event                             | Additional properties                                                                                                                                                          | When                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `review_app_opened`               | None                                                                                                                                                                           | The canvas app opens                                                                                       |
| `review_tab_viewed`               | `tab` in review, commits, map, files, trace; `duration_ms`; `reason` in tab_change, visibility_hidden, pagehide, unmount                                                       | A tab dwell period ends                                                                                    |
| `review_diff_viewed`              | `duration_ms`                                                                                                                                                                  | A files tab dwell period ends; the server derives it from `review_tab_viewed`, the canvas does not send it |
| `review_peek_opened`              | `via` in prose_link, diagram, map, db_lens, call_stack_frame                                                                                                                   | A user opens a code peek                                                                                   |
| `review_peek_resolved`            | `root_kind` in range                                                                                                                                                           | A code peek the user opened resolves                                                                       |
| `review_peek_resolve_failed`      | `root_kind` in range                                                                                                                                                           | A code peek the user opened does not resolve                                                               |
| `review_diff_opened`              | `kind` in commit, file, structural; `via` in topbar, lens, locate                                                                                                              | A user opens a diff view                                                                                   |
| `review_scratchpad_opened`        | None                                                                                                                                                                           | The one scratchpad document opens                                                                          |
| `review_discord_clicked`          | `via` in topbar, dialog, docs                                                                                                                                                  | A user clicks a Discord invite                                                                             |
| `review_discord_dialog_shown`     | None                                                                                                                                                                           | The community invite dialog opens                                                                          |
| `review_discord_dialog_dismissed` | None                                                                                                                                                                           | The community invite dialog closes unaccepted                                                              |
| `review_review_shared`            | None                                                                                                                                                                           | A user copies a whiteboard's share link                                                                    |
| `review_review_deleted`           | `via` in home                                                                                                                                                                  | A user deletes a stored whiteboard from Home                                                               |
| `review_tour_started`             | `steps`                                                                                                                                                                        | A user starts a tour                                                                                       |
| `review_tour_step_advanced`       | `step`, `steps`                                                                                                                                                                | A user moves to the next tour step                                                                         |
| `review_tour_abandoned`           | `step`, `steps`                                                                                                                                                                | A user closes an incomplete tour                                                                           |
| `review_tour_completed`           | `steps`                                                                                                                                                                        | A user completes a tour                                                                                    |
| `review_map_expanded`             | `level` in system, container, component, code                                                                                                                                  | A user expands a map element                                                                               |
| `review_commit_expanded`          | `expanded`                                                                                                                                                                     | A user expands or collapses a commit                                                                       |
| `review_commit_diff_opened`       | `via` in row, file, footer                                                                                                                                                     | A user opens a commit diff                                                                                 |
| `review_source_tree_opened`       | `via` in topbar, home                                                                                                                                                          | A user opens the source tree                                                                               |
| `review_client_error`             | See "Error reports"                                                                                                                                                            | A part of Whiteboard reports an error                                                                      |
| `review_update_started`           | Random `update_attempt_id`, `target_version`                                                                                                                                   | An update is downloaded and ready to install                                                               |
| `review_update_completed`         | Start properties plus `duration_ms`                                                                                                                                            | The downloaded target launches after restart                                                               |
| `review_update_failed`            | `phase` in check, download, install; `message_source` in electron, request, shipit, fallback; `error_name`; optional start properties and `duration_ms`; see "Error reports"   | An update check, download, or install fails                                                                |
| `review_bug_report_dialog_opened` | None                                                                                                                                                                           | A user opens the bug report dialog                                                                         |
| `review_bug_report_cancelled`     | None                                                                                                                                                                           | A user closes the dialog without a report                                                                  |
| `review_bug_report_send_failed`   | Short `error_name`                                                                                                                                                             | A bug report request fails                                                                                 |
| `review_setting_changed`          | `setting` in telemetry_enabled, keymap, software_map_enabled, scratchpad_enabled, diffr_config, structural_diff, theme; `enabled`; `value` in dark, light, system (theme only) | A user changes a Whiteboard setting                                                                        |
| `review_review_opened`            | `via` in home, other                                                                                                                                                           | A user opens a whiteboard                                                                                  |
| `review_diff_layout_changed`      | `layout` in split, unified                                                                                                                                                     | A user switches the diff layout                                                                            |
| `review_home_empty_state_viewed`  | None                                                                                                                                                                           | The empty Home state opens                                                                                 |

The canvas sends `review_review_dismissed`, `review_review_restored`, and
`review_review_deleted` from Home's actions, with `via` set to `home`.
`review_review_dismissed` also comes from the whiteboard's top bar, with `via`
set to `review_topbar`. `review_review_restored`'s `open` (the implicit undo,
where opening a dismissed whiteboard brings it back) is allowlisted but not yet
sent.

### Reserved events

The allowlist also defines `review_review_reaped`, but no current code sends
it. If a future change sends it, it will update this page in the same change.

### Hangs

- `review_hang_started` / `review_hang_ended`: Electron's window
  `unresponsive` / `responsive` events.
- `review_open_timeout`: a whiteboard that neither presents nor ends within 30
  seconds.

If the app dies with a whiteboard open, the next launch sends
`review_session_ended` with `outcome: "abnormal"`. A workbench reload ends its
session with `outcome: "app_quit"`, the same as quitting.

### Workbench events

| Event                             | Additional properties                                                                                                                                                                                                                       | When                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `review_lsp_used`                 | `feature` in hover, goto_definition, peek_definition, goto_type_definition, goto_implementation, references, rename, format, code_action, symbol_search; `via` in command, mouse; `language`; `editor_kind` in files_tab, inline_peek, diff | A user invokes an LSP feature               |
| `review_ls_activated`             | `group` in python, go, rust, swift, csharp; `ok`                                                                                                                                                                                            | A language server activation check ends     |
| `review_extension_installed`      | Allowlisted `extension_id`; `trigger` in user, auto_upgrade, startup_seed, keymap, rollback; `cached`; `duration_ms`                                                                                                                        | An optional extension installs              |
| `review_extension_install_failed` | Allowlisted `extension_id`; allowlisted `trigger`; `phase` in download, install                                                                                                                                                             | An optional extension install fails         |
| `review_extension_enabled`        | Allowlisted `extension_id`; allowlisted `trigger`                                                                                                                                                                                           | Whiteboard enables an optional extension    |
| `review_extension_disabled`       | Allowlisted `extension_id`; allowlisted `trigger`                                                                                                                                                                                           | Whiteboard disables an optional extension   |
| `review_extension_uninstalled`    | Allowlisted `extension_id`; allowlisted `trigger`                                                                                                                                                                                           | Whiteboard uninstalls an optional extension |

The `language` property is one of typescript, javascript, python, go, rust,
swift, csharp, json, css, html, markdown, yaml, toml, shell, sql, or other.
The allowlisted extension identifiers are `vscodevim.vim`,
`tuttieee.emacs-mcx`, `ms-python.python`, `astral-sh.ty`,
`charliermarsh.ruff`, `golang.go`, `rust-lang.rust-analyzer`,
`swiftlang.swift-vscode`, `llvm-vs-code-extensions.lldb-dap`,
`muhammad-sammy.csharp`, and `ms-dotnettools.vscode-dotnet-runtime`.
Whiteboard does not send an extension version.

## Error reports

Whiteboard reports its own failures so that a defect that only happens on your
machine can still be found and fixed. Four parts of Whiteboard report an error:
the app window, the canvas, the background process, and a crash that happens
before Whiteboard can start. Uncaught canvas errors are reported once, by the
app window.

Every `review_client_error` is also sent as a PostHog `$exception` with the same
fields; `review_client_error` is removed after one release. After 5 reports of
one `message_hash` in a session, Whiteboard sends a `review_error_burst` instead
and drops the rest.

Whiteboard sends these properties with the `review_client_error` event. A
`review_update_failed` event uses the same server-side message cleaning and
fingerprinting, plus the closed update phase and message-source fields above.
Install failures read at most 64 KiB appended to ShipIt's stderr log after the
matching update was staged. Whiteboard extracts only the last NSError summary (or
the fixed retry-exhausted line); it neither stores nor uploads the raw log.

| Property        | Value                                                                             |
| --------------- | --------------------------------------------------------------------------------- |
| `error_process` | Which part of Whiteboard failed: `main`, `renderer`, `canvas`, or `server`        |
| `error_source`  | Which handler caught it, from a closed list                                       |
| `error_name`    | The error class name, such as `TypeError`. Identifier characters only, 40 at most |
| `component`     | A fixed component name, when the reporter has one. Identifier characters only     |
| `message`       | The error message, cleaned. See below                                             |
| `message_hash`  | A fingerprint of the original message. See below                                  |
| `frames`        | Up to 10 stack lines, all inside Whiteboard's shipped program. See below          |

**Whiteboard cleans the message before it sends it.** The cleaner replaces each of
these with a marker that names what it removed, such as
`<REDACTED: user-file-path>`:

- any file path, on macOS, Linux, or Windows,
- your home directory and your temporary directory, which are removed outright,
- any web address, e-mail address, or text matching a known secret format, such
  as an access token or a private key.

So `ENOENT: no such file or directory, open '/Users/you/work/notes.md'` is sent
as `ENOENT: no such file or directory, open '<REDACTED: user-file-path>'`.

The cleaner is Microsoft's, taken from VS Code, which Whiteboard is built on.
Whiteboard uses it rather than a rule of its own so that you can check it against a known
implementation. The copy is in
`packages/review/src/telemetry-clean-text.ts`, and its header lists
every difference from the original.

Two rules sit on top of the cleaner:

- **Whiteboard sends no message for an error that quotes a whiteboard
  document.** An authoring tool checks authored text against a schema, and
  those errors repeat the text they rejected. Whiteboard keeps the error class, the fingerprint, and the
  stack lines for these, and drops the message.
- **Whiteboard sends no message the cleaner did not finish.** After cleaning,
  Whiteboard checks the result again for a path or a secret. If it finds one, the message
  is dropped. This is a second, separate check, so a fault in the cleaner cannot
  by itself put a path on the wire.

**`message_hash` is a fingerprint of the original message**: the first 16
characters of a one-way SHA-256 digest. It is sent whether or not the message
survives, so reports whose message was dropped still group together. The digest
cannot be turned back into the message.

**Whiteboard sends only frames from its shipped program.** Each frame reads as
`file:line:column`, where the file is a path inside the program, such as
`vs/review/browser/workbench.js:456:12`. Whiteboard finds the shipped program
directory in each frame and discards everything before it, which removes your
home directory. It then keeps a frame only when the result starts inside a known
program directory, including the Code - OSS directories it ships. A frame in your repository, in `node_modules`, or in an
extension is dropped whole, not shortened.

The local server does this work, and the event allowlist checks every
frame a second time. Both steps run on your machine, before anything is sent.

### Crash reports

A `review_crash` records the process kind, Electron's reason, and the exit code,
with no message or stack. Electron also writes a local minidump, which can
contain process memory, including open source text. The next launch uploads it
to `bug.dev.fast` with the common properties and deletes it. A dump no live
event already counted is reported as `review_crash` with `source: "minidump"`.
Dumps older than seven days, or any dump with telemetry off, are deleted
without upload. Uploaded dumps are kept for 30 days, and the Worker records a
`review_crash_uploaded` event without the dump.

## User-initiated bug reports

The **Report a bug** dialog sends data only after the user selects **Send**. The
description is optional. Under **Include diagnostic attachments**, two
independent controls choose what else is attached:

- **Session**: the current whiteboard record and its software maps. On by
  default.
- **Changed-file diffs used by CodePeeks**. On by default.

**Agent session trace attachment is not available yet.** The dialog has no
trace control, and reports never include agent traces.

Whiteboard also captures a screenshot before the dialog opens and attaches it
by default. The dialog shows a removable preview and accepts a replacement
image by paste or drag.

A whiteboard does not always have a software map. The report then omits the
map and records no error, because an absent map is a normal state.

The report payload contains these fields:

| Field                            | Value                                                                         |
| -------------------------------- | ----------------------------------------------------------------------------- |
| `schema_version`                 | Internal report payload format version                                        |
| `description`                    | Optional user-entered description, limited to 64 KiB of UTF-8 data            |
| `screenshot.mime`                | `image/jpeg` when a screenshot is attached                                    |
| `screenshot.base64`              | JPEG screenshot data, limited to 3 MiB decoded                                |
| `review["review.json"]`          | The saved whiteboard record, when the user consents                           |
| `map`                            | The software maps the whiteboard shows, when the user consents and one exists |
| `diff.baseRef`                   | Base revision for the changed-file diffs, when one is available               |
| `diff.headRef`                   | Head revision for the changed-file diffs, when one is available               |
| `diff.files[].path`              | Current changed-file path                                                     |
| `diff.files[].previousPath`      | Previous path for a renamed file, when one is available                       |
| `diff.files[].status`            | Changed-file status                                                           |
| `diff.files[].additions`         | Added line count                                                              |
| `diff.files[].deletions`         | Deleted line count                                                            |
| `diff.files[].patch`             | Unified patch used to resolve the whiteboard's exact CodePeek ranges          |
| `diagnostics.app_version`        | Whiteboard app version                                                        |
| `diagnostics.cli_version`        | `@dev.fast/review` package version                                            |
| `diagnostics.platform`           | Node platform enum                                                            |
| `diagnostics.app_session_id`     | Random identifier for the canvas window                                       |
| `diagnostics.client_error_names` | Last 20 sanitized JavaScript error class names from that canvas session       |
| `diagnostics.attachment_errors`  | Selected attachment names with the value `unavailable`                        |

The whiteboard record is the whole saved version: its title and document text,
its lenses, the commits it is pinned to, and where it came from, such as the
branch, base ref, and pull request number and URL. A whiteboard received
through a share link also carries the sharer's GitHub login and the
repository's clone URL. It does not contain source code; the changed-file diffs
are a separate attachment.

If a selected attachment is unavailable, Whiteboard omits it, names it in
`diagnostics.attachment_errors`, and sends the rest. If the report would exceed
the upload limit, Whiteboard drops attachments in this order until it fits:
the diffs, the maps, the screenshot, and the whiteboard record. If it still
does not fit, the report is not sent.

The Worker stores reports in a private Cloudflare R2 bucket. Only credentialed
dev.fast operators can read the bucket. Reports are deleted after 90 days.

After storage completes, the Worker sends a `review_bug_report` PostHog event
with the report ID, date, app version, platform, sizes, attachment presence, and
truncation flags. The event does not contain the description or attachments.

Cloudflare uses `CF-Connecting-IP` only as the rate-limit key. The Worker does
not store that value in R2. The Worker does not send it to PostHog as report
data. The limit is five report attempts per minute for each client IP.

An explicit bug report submission overrides the passive telemetry opt-out.
The local server sends this report even when Whiteboard telemetry is off. The
passive event allowlist and telemetry disk queue do not process bug reports.

## Code locations

| Concern                     | File                                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| Telemetry API and identity  | `packages/review/src/review-telemetry.ts`                                                      |
| Batch queue                 | `packages/review/src/posthog-capture-client.ts`                                                |
| Opt-out rules               | `packages/review/src/telemetry-config.ts`                                                      |
| Developer sink              | `packages/review/src/telemetry-debug-sink.ts`                                                  |
| UI allowlist                | `packages/review/src/ui-telemetry-events.ts`                                                   |
| Error message and frames    | `packages/review/src/error-telemetry.ts`                                                       |
| Message cleaner (VS Code)   | `packages/review/src/telemetry-clean-text.ts`                                                  |
| Error reporting rules       | `apps/review-desktop/code-oss/src/vs/review/common/reviewErrorReport.ts`                       |
| Pre-start crash note        | `apps/review-desktop/code-oss/src/vs/review/node/reviewBootstrapBreadcrumb.ts`                 |
| Desktop setting             | `apps/review-desktop/code-oss/src/vs/review/common/reviewConfiguration.ts`                     |
| Settings screen             | `packages/review/app/src/settings-page.tsx`                                                    |
| First-use notice            | `apps/review-desktop/code-oss/src/vs/review/contrib/telemetry/reviewTelemetry.contribution.ts` |
| Error budget and bursts     | `packages/review/src/server/client-error-budget.ts`                                            |
| Account alias               | `packages/review/src/server/account-alias.ts`                                                  |
| Whiteboard lifecycle events | `packages/review/src/server/review-lifecycle-telemetry.ts`                                     |
| Open-timeout watchdog       | `packages/review/src/server/review-open-watchdog.ts`                                           |
| Crash dump upload           | `packages/review/src/server/crash-report.ts`                                                   |
| Crash and hang listeners    | `apps/review-desktop/code-oss/src/vs/review/electron-main/reviewCrashTelemetry.ts`             |
| Crash dump reconciliation   | `apps/review-desktop/code-oss/src/vs/review/electron-main/reviewCrashDumps.ts`                 |
