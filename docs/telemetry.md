# Telemetry

Review collects a small amount of anonymous usage and reliability data. We use
it to learn which parts of Review are useful and where the app is failing.

This page is the complete public contract for Review Desktop and CLI telemetry.
For a shorter overview of all product data, including local files, coding
agents, and bug reports, see [Privacy](privacy.md).

Last checked against this repository: 2026-08-18.

## The short version

- Anonymous telemetry is on by default and can be turned off at any time.
- Review records actions such as opening a review, changing tabs, using code
  navigation, or completing a CLI command. Values are limited to fixed
  categories, booleans, counts, durations, versions, and opaque identifiers.
- Passive telemetry never includes your code, diffs, file paths, repository
  name, Review title, refs, revision hashes, raw Review UUID, coding-agent
  session ID, Review text, comments, questions, prompts, or model output.
- Review uses a random installation ID. It does not use your email, username,
  hostname, or a hardware identifier, and it does not create a PostHog person
  profile.
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
| Review outcome  | Approve, request changes, dismiss, comment count          | Comments, questions, thread text, or reviewer identity          |
| Reliability     | Error class, cleaned message, Review-only stack frames    | User paths, repository frames, secrets, or authored Review text |

Every event is checked against an allowlist on your machine. Unknown events,
unknown properties, and values outside their allowed categories are dropped.
The full event-by-event list begins at [Event reference](#event-reference).

## Identity and storage

On first use, Review creates a random installation UUID and stores it at
`${DEV_REVIEW_HOME:-~/.dev}/telemetry/progressive-review.json`. It does not call
PostHog's `identify()` API or associate that ID with a person profile.

Pending events are kept in a local queue under
`${DEV_REVIEW_HOME:-~/.dev}/telemetry/events`. The queue holds at most 1,000
events, retries temporary failures, and deletes events after seven days.
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

| Property      | Value                                   |
| ------------- | --------------------------------------- |
| `product`     | `review-cli`                            |
| `package`     | `@dev.fast/review`                      |
| `version`     | Review CLI package version              |
| `app_version` | Optional Review Desktop release version |
| `node_major`  | Node major version                      |
| `platform`    | Node platform enum                      |
| `arch`        | Node architecture enum                  |
| `ci`          | Boolean                                 |
| `internal`    | Boolean for a dev.fast workspace build  |

UI events also include `source: review_app` and a random `app_session_id`. The
app creates a new app session identifier for each renderer lifetime.

Review-scoped events can also include `review_id`. Events routed through a
specific Desktop Review session can include both `review_id` and
`presentation_id`. Global main-process and renderer errors remain unscoped;
Review does not guess which open Review caused them.

The embedded Desktop server adds `app_version` to all of its telemetry events.
Standalone CLI events omit this property.

The transport creates `review_telemetry_dropped` directly. That
event includes only `reason`, `count`, and the random installation identifier.

### CLI and lifecycle events

| Event                          | Additional properties                                                                                        | When                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| `review_installation_created`  | None                                                                                                         | The first enabled Review use            |
| `review_command_started`       | `command_path`, `command_run_id`, `agent_kind`                                                               | A public CLI handler is about to run    |
| `review_command_bound`         | Start properties plus `review_id`                                                                            | Scaffold or publish resolves its Review |
| `review_command_succeeded`     | `command_path`, `command_run_id`, `exit_code`, `duration_ms`, optional `review_id`, and closed command flags | A public CLI command succeeds           |
| `review_command_failed`        | The success properties plus `error_name` and `error_category` closed enums                                   | A public CLI command fails              |
| `review_session_started`       | `source_kind`, `agent_kind`, `review_id`, `presentation_id`, optional `app_session_id`                       | A Desktop review session opens          |
| `review_session_ended`         | Start properties plus `outcome`, `duration_ms`                                                               | A review submits or is dismissed        |
| `review_review_deleted`        | None                                                                                                         | A user deletes a stored review          |
| `review_review_reaped`         | `retention_days`                                                                                             | Retention deletes a dismissed review    |
| `review_publish_gate_rejected` | `gate` in publish_ready, map_publish_ready                                                                   | A publish readiness gate rejects        |
| `review_telemetry_dropped`     | `reason`, `count`                                                                                            | The queue drops one or more events      |

`command_path` is a closed enum for all public commands. It includes `help`,
`version`, `app.launch`, `app.pick`, `rebind`, `publish`, `wait`, `info`,
`scaffold`, `install`, `migrate.apply`, `threads.list`,
`threads.resolve`, `threads.reply`, `map.open`, `map.check`, `map.prune`,
`map.publish`, `map.push`, `map.fetch`, and `invalid`. Review sends no
arguments or refs.

The `command`, `subcommand`, `mode`, `has_base_ref`, `has_head_ref`, and
`force` flags accompany only `map.*` commands.

The CLI writes `review_command_started` to the disk queue before entering the
command handler. The queue normally begins its background flush after five
seconds; Review does not wait for network delivery before starting the command.
Scaffold binds after a new Review is persisted or an update target is resolved.
Publish binds immediately after target resolution, before validation and mount.

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
- Session sources: `pull_request`, `git_branch`, `jj_bookmark`, and
  `jj_change`. Agent kinds are `codex`, `claude`, `pi`, and `other`. Outcomes
  are `approve`, `request-changes`, and `dismissed`.

### Desktop and canvas events

The server checks all properties in this table against
`packages/progressive-review/src/ui-telemetry-events.ts`.

| Event                             | Additional properties                                                                                                                                          | When                                         |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `review_app_opened`               | None                                                                                                                                                           | The canvas app opens                         |
| `review_tab_viewed`               | `tab` in review, commits, map, files; `duration_ms`; `reason` in tab_change, visibility_hidden, pagehide, unmount                                              | A tab dwell period ends                      |
| `review_peek_opened`              | `via` in prose_link, diagram, marker, map, db_lens                                                                                                             | A user opens a code peek                     |
| `review_peek_resolved`            | `root_kind` in symbol, declaration, range                                                                                                                      | A code peek resolves                         |
| `review_peek_resolve_failed`      | `root_kind` in symbol, declaration, range                                                                                                                      | A code peek does not resolve                 |
| `review_tour_started`             | `steps`                                                                                                                                                        | A user starts a tour                         |
| `review_tour_step_advanced`       | `step`, `steps`                                                                                                                                                | A user moves to the next tour step           |
| `review_tour_abandoned`           | `step`, `steps`                                                                                                                                                | A user closes an incomplete tour             |
| `review_tour_completed`           | `steps`                                                                                                                                                        | A user completes a tour                      |
| `review_map_expanded`             | `level` in system, container, component, code                                                                                                                  | A user expands a map element                 |
| `review_commit_expanded`          | `expanded`                                                                                                                                                     | A user expands or collapses a commit         |
| `review_commit_diff_opened`       | `via` in row, file, footer                                                                                                                                     | A user opens a commit diff                   |
| `review_thread_draft_opened`      | `intent` in comment, ask-agent                                                                                                                                 | A user opens a thread draft                  |
| `review_threads_opened`           | `thread_count`                                                                                                                                                 | A user opens the Threads panel               |
| `review_new_ask_opened`           | `via` in topbar, threads_panel                                                                                                                                 | A user opens the new-ask composer            |
| `review_source_tree_opened`       | `via` in topbar, home                                                                                                                                          | A user opens the source tree                 |
| `review_comment_created`          | `is_reply`                                                                                                                                                     | A user creates a comment                     |
| `review_agent_run_started`        | None                                                                                                                                                           | A user starts an agent run                   |
| `review_thread_resolved`          | `kind: comment`                                                                                                                                                | A user resolves a comment                    |
| `review_client_error`             | See "Error reports"                                                                                                                                            | A part of Review reports an error            |
| `review_update_started`           | Random `update_attempt_id`, `target_version`                                                                                                                   | An update is downloaded and ready to install |
| `review_update_completed`         | Start properties plus `duration_ms`                                                                                                                            | The downloaded target launches after restart |
| `review_update_failed`            | `phase` in check, download, install; `message_source` in electron, request, shipit, fallback; optional start properties and `duration_ms`; see "Error reports" | An update check, download, or install fails  |
| `review_bug_report_dialog_opened` | None                                                                                                                                                           | A user opens the bug report dialog           |
| `review_bug_report_cancelled`     | None                                                                                                                                                           | A user closes the dialog without a report    |
| `review_bug_report_send_failed`   | Short `error_name`                                                                                                                                             | A bug report request fails                   |
| `review_setting_changed`          | `setting` in telemetry_enabled, keymap, dismissed_retention_days, software_map_enabled; `enabled`                                                              | A user changes a Review setting              |
| `review_review_opened`            | `via` in home, cli, other                                                                                                                                      | A user opens a review                        |
| `review_review_presented`         | `review_id`, `presentation_id`                                                                                                                                 | A visible canvas loads and signals ready     |
| `review_home_empty_state_viewed`  | None                                                                                                                                                           | The empty Home state opens                   |

The server emits `review_review_submitted` after it stores a submission. Its
properties are `decision` and `comment_count`. The server emits
`review_review_dismissed` after it stores a dismissal. Its property is `via` in
review_topbar, home.

The server emits `review_review_restored` when a dismissal ends. Its property
is `via` in home, open. The `home` value is the Undo button. The `open` value
is the implicit undo: a reader who opens a dismissed review brings it back.

“Presented” does not mean `review publish` returned successfully. It means the
visible canvas loaded both the Review document and its optional software map,
reported no render error, and fired the existing canvas-ready signal. The
off-screen mount used by the publish validation gate does not emit this event.

## Suspected hangs

Operational queries classify a lifecycle start as a suspected hang after five
minutes without its matching terminal event:

- a command start with no success or failure sharing `command_run_id`; or
- a session start with no presentation sharing `presentation_id`.

This observes lifecycle gaps; it does not time out or kill work. A suspected
hang can also be a crash, force-kill, or telemetry delivery loss. A late
terminal or ready event removes the match automatically.

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
Review can start.

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
`packages/progressive-review/src/telemetry-clean-text.ts`, and its header lists
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

## User-initiated bug reports

The **Report bug** dialog sends data only after the user selects **Send**. The
description is optional. It has one **Review** consent control for both the
current review source and head software map source, plus a separate control for
changed-file diffs. Both controls are on by default. Review also captures a
screenshot before the dialog opens and attaches it by default. The dialog shows
a removable preview and accepts a replacement image by paste or drag.

**Agent traces require separate, explicit consent for every report.** The
**Agent session trace** control is off by default. Review does not attach any
agent trace unless the user turns on this control before selecting **Send**.

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
| `trace.harness`                    | Authoring harness: `claude-code`, `codex`, or `pi`                                  |
| `trace.session_id`                 | Authoring session identifier from the Review record                                 |
| `trace.files["subagents/<name>"]`  | Tail-capped raw JSONL for an included subagent                                      |
| `trace.omitted_files`              | Ancestor or subagent trace names omitted because of limits or read failures         |
| `trace.truncated`                  | Whether any trace record, ancestor, or subagent trace was dropped or tail-capped    |
| `diagnostics.app_version`          | Review Desktop product version                                                      |
| `diagnostics.cli_version`          | `@dev.fast/review` package version                                                  |
| `diagnostics.platform`             | Node platform enum                                                                  |
| `diagnostics.app_session_id`       | Random identifier for the canvas window                                             |
| `diagnostics.client_error_names`   | Last 20 sanitized JavaScript error class names from that canvas session             |
| `diagnostics.attachment_errors`    | Selected attachment names with the value `unavailable`, or `too_large` for a trace  |
| `diagnostics.review_omitted_files` | Names of review source files the report did not send                                |

The `review` field holds a file map. It contains the current review document and
the TypeScript modules beside it, because the document alone cannot render: the
anchors live in those modules. The report sends at most 20 files. It drops a
file larger than 2 MiB. It lists the name of each dropped file in
`diagnostics.review_omitted_files`.

The report never sends these review files:

- `review.json`, which holds a local directory path and the pull request URL
- the compiled document in `.bundle/`, and the build output in `.build/`
- the shared `review.db`, which holds Review metadata and comment threads

Trace attachment consent is independent of passive telemetry and trace sync.
Neither setting enables trace attachment for a bug report. If the user opts in,
the report includes the complete authoring-session trace and available ancestor
history through each fork point. It can also include up to ten of the most
recently modified subagent trace tails. Review drops a record the harness has
not finished writing, an ancestor it cannot read, and, when the compressed
report would exceed the upload cap, the whole trace; each case is recorded in
the payload rather than failing the report.

The trace can contain prompts, model output, source code, file paths, URLs, and
email addresses. Review replaces recognizable Google API keys, JWTs, Slack
tokens, GitHub tokens, and Microsoft Entra tokens with labelled markers. Other
credentials or secrets may remain.

The Worker stores reports in a private Cloudflare R2 bucket. Only credentialed
dev.fast operators can read the bucket. Reports are deleted after 90 days.

After storage completes, the Worker sends a `review_bug_report` PostHog event
with the report ID, date, app version, platform, sizes, attachment presence, and
truncation flags. For an explicitly included trace, it also sends the harness
type and trace sizes. The event does not contain the description, attachments,
or trace session identifiers.

Cloudflare uses `CF-Connecting-IP` only as the rate-limit key. The Worker does
not store that value in R2. The Worker does not send it to PostHog as report
data. The limit is five report attempts per minute for each client IP.

An explicit bug report submission overrides the passive telemetry opt-out.
The local server sends this report even when Review telemetry is off. The
passive event allowlist and telemetry disk queue do not process bug reports.

## Code locations

| Concern                    | File                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| Telemetry API and identity | `packages/progressive-review/src/progressive-review-telemetry.ts`                              |
| Batch queue                | `packages/progressive-review/src/posthog-capture-client.ts`                                    |
| Opt-out rules              | `packages/progressive-review/src/telemetry-config.ts`                                          |
| Developer sink             | `packages/progressive-review/src/telemetry-debug-sink.ts`                                      |
| UI allowlist               | `packages/progressive-review/src/ui-telemetry-events.ts`                                       |
| Error message and frames   | `packages/progressive-review/src/error-telemetry.ts`                                           |
| Message cleaner (VS Code)  | `packages/progressive-review/src/telemetry-clean-text.ts`                                      |
| Error reporting rules      | `apps/review-desktop/code-oss/src/vs/review/common/reviewErrorReport.ts`                       |
| Pre-start crash note       | `apps/review-desktop/code-oss/src/vs/review/node/reviewBootstrapBreadcrumb.ts`                 |
| Desktop setting            | `apps/review-desktop/code-oss/src/vs/review/common/reviewConfiguration.ts`                     |
| Settings screen            | `packages/progressive-review/app/src/settings-page.tsx`                                        |
| First-use notice           | `apps/review-desktop/code-oss/src/vs/review/contrib/telemetry/reviewTelemetry.contribution.ts` |
