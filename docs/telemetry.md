# Telemetry

This document lists the telemetry that Review collects. It is the public source
of truth for Review CLI and Review Desktop telemetry.

Last checked against the code: 2026-08-17.

## Privacy rules

1. Passive telemetry sends only closed enums, booleans, numbers, random
   identifiers, and the error fields in rule 3.
2. Passive telemetry never sends paths, repository names, refs, symbols, code,
   diffs, review text, comments, questions, prompts, or model output.
3. An error report is the one place free text appears. Review sends the error
   message with every path, web address, e-mail address, and known secret
   format replaced by a marker, it sends stack lines only for files inside the
   Review program itself, and it sends a fingerprint of the original message.
   It sends no message at all for an error that quotes a review document. See
   "Error reports" below.
4. Review uses a random installation UUID. It does not use an email, username,
   hostname, or machine identifier.
5. PostHog derives coarse location data. The PostHog project discards the source
   IP at ingestion.
6. The UI and server apply the same event allowlist. They drop unknown events,
   properties, and enum values.

## Data flow

```text
Review workbench -------> root /telemetry/event ---\
Review canvas ----------> session telemetry routes +--> allowlist -> disk queue -> PostHog batch API
Review background ------> root /telemetry/event ---/
Review CLI -------------------------------------------> disk queue -> PostHog batch API
```

The canvas does not connect to PostHog. The local server checks each canvas
event first. The CLI and server use one telemetry implementation in
`packages/progressive-review/src/progressive-review-telemetry.ts`.

The transport stores pending events under
`{DEV_REVIEW_HOME}/telemetry/events`. It sends batches to `POST /batch/`. It
retries temporary failures with backoff. It deletes events after seven days.
It limits the queue to 1,000 events.

Review Desktop disables the built-in Microsoft telemetry. A product hardening
test checks this rule.

### Workbench (Review Desktop)

The workbench sends allowlisted events to the root `POST /telemetry/event`
route. The request uses the loopback server token. It also sends the random
window `app_session_id`. The server checks the event before it adds the event
to the PostHog queue.

The canvas uses session routes. It sends dwell events to `/telemetry/tab`. It
sends its other allowlisted events to `/telemetry/event` in that session. The
root workbench route and the session event route use the same allowlist.

The Electron background process uses the same root route as the workbench. It
holds no connection to PostHog of its own, so its errors pass every opt-out
check and the same allowlist as every other event.

User-initiated bug reports use a separate path:

```text
Review canvas -> local Review server -> bug.dev.fast -> private Cloudflare R2
                                            `-----> PostHog metadata event
```

## Identity and control

Review creates a random `distinct_id` on first use. It stores the identifier in
`{DEV_REVIEW_HOME}/telemetry/progressive-review.json`. Review does not call
`identify()` and does not create a person profile.

The `review.telemetry.enabled` Desktop setting controls Review CLI and Review
Desktop telemetry on the same installation. The setting is on by default.
Review Desktop shows one short notice on first use.

To change the setting, open **Preferences ▸ Settings...** (⌘,) and use the
**Share anonymous usage data** row. The first-use notice opens the same screen.

These environment variables also turn telemetry off when their value is `1` or
`true`:

- `DO_NOT_TRACK`
- `DNT`
- `PROGRESSIVE_REVIEW_TELEMETRY_DISABLED`
- `DEV_FAST_TELEMETRY_DISABLED`
- `DEV_FAST_PROGRESSIVE_REVIEW_TELEMETRY_DISABLED`
- `DEV_FAST_REVIEW_TELEMETRY_DISABLED`

Tests also turn telemetry off with `VITEST=1` or `NODE_ENV=test`.

### Developer sink

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

### Known exceptions

The `early_access_requested` event in
`apps/web/src/routes/-marketing-home.tsx` uses a separate marketing PostHog
instance. It identifies the request by email. This event is outside this
document's privacy model. The product team must make a separate decision about
this exception.

## Common properties

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

The embedded Desktop server adds `app_version` to all of its telemetry events.
Standalone CLI events omit this property.

The transport creates `review_telemetry_dropped` directly. That
event includes only `reason`, `count`, and the random installation identifier.

## CLI and lifecycle events

| Event                                     | Additional properties                                                      | When                               |
| ----------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------- |
| `review_installation_created` | None                                                                       | The first enabled Review use       |
| `review_command_succeeded`    | `command_path`, `exit_code`, `duration_ms`, and closed command flags       | A public CLI command succeeds      |
| `review_command_failed`       | The success properties plus `error_name` and `error_category` closed enums | A public CLI command fails         |
| `review_session_started`      | `source_kind`, `agent_kind`, optional `app_session_id`                     | A Desktop review session opens     |
| `review_session_ended`        | Start properties plus `outcome`, `duration_ms`                             | A review submits or is dismissed   |
| `review_review_deleted`       | None                                                                       | A user deletes a stored review     |
| `review_review_reaped`        | `retention_days`                                                           | Retention deletes a dismissed review |
| `review_publish_gate_rejected` | `gate` in publish_ready, map_publish_ready                                | A publish readiness gate rejects   |
| `review_telemetry_dropped`    | `reason`, `count`                                                          | The queue drops one or more events |

`command_path` is a closed enum for all public commands. It includes `help`,
`version`, `app`, `rebind`, `publish`, `wait`, `info`, `scaffold`, `install`,
`migrate.apply`, `threads.list`,
`threads.resolve`, `threads.reply`, `map.open`, `map.check`, `map.prune`,
`map.publish`, `map.push`, `map.fetch`, and `invalid`. Review sends no
arguments or refs.

The `command`, `subcommand`, `mode`, `has_base_ref`, `has_head_ref`, and
`force` flags accompany only `map.*` commands.

Error names and categories are closed enums. A failed command sends no exception
message, stack, path, process output, project identifier, or remediation text.
Only the `review_client_error` event carries message text, and only as described
in "Error reports".

- Error names: `usage_error`, `review_not_found`, `review_state_error`,
  `repository_error`, `desktop_connection_error`, `network_error`,
  `storage_error`, `index_error`, `process_error`, and `unexpected_error`.
- Error categories: `user_input`, `local_state`, `dependency`, `transport`, and
  `internal`.
- Queue drop reasons: `queue_full`, `expired`, `corrupt`,
  `permanent_rejection`, and `storage_failure`.
- Session sources: `pull_request`, `git_branch`, `jj_bookmark`, and
  `jj_change`. Agent kinds are `codex`, `claude`, and `other`. Outcomes are
  `approve`, `request-changes`, and `dismissed`.

## Canvas events

The server checks all canvas properties against
`packages/progressive-review/src/ui-telemetry-events.ts`.

| Event                                         | Additional properties                                                                                    | When                                      |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `review_app_opened`               | None                                                                                                     | The canvas app opens                      |
| `review_tab_viewed`               | `tab` in review, map, files; `duration_ms`; `reason` in tab_change, visibility_hidden, pagehide, unmount | A tab dwell period ends                   |
| `review_peek_opened`              | `via` in prose_link, diagram, marker, map, db_lens                                                       | A user opens a code peek                  |
| `review_peek_resolved`            | `root_kind` in symbol, declaration, range                                                                | A code peek resolves                      |
| `review_peek_resolve_failed`      | `root_kind` in symbol, declaration, range                                                                | A code peek does not resolve              |
| `review_tour_started`             | `steps`                                                                                                  | A user starts a tour                      |
| `review_tour_step_advanced`       | `step`, `steps`                                                                                          | A user moves to the next tour step        |
| `review_tour_abandoned`           | `step`, `steps`                                                                                          | A user closes an incomplete tour          |
| `review_tour_completed`           | `steps`                                                                                                  | A user completes a tour                   |
| `review_map_expanded`             | `level` in system, container, component, code                                                            | A user expands a map element              |
| `review_thread_draft_opened`      | `intent` in comment, question                                                                            | A user opens a thread draft               |
| `review_threads_opened`           | `thread_count`                                                                                           | A user opens the Threads panel            |
| `review_new_ask_opened`           | `via` in topbar, threads_panel                                                                           | A user opens the new-ask composer         |
| `review_comment_created`          | `is_reply`                                                                                               | A user creates a comment                  |
| `review_question_asked`           | None                                                                                                     | A user asks a question                    |
| `review_question_answered`        | `ok`, `duration_ms`                                                                                      | The question request ends                 |
| `review_thread_resolved`          | `kind: comment`                                                                                          | A user resolves a comment                 |
| `review_client_error`             | See "Error reports"                                                                                      | A part of Review reports an error         |
| `review_bug_report_dialog_opened` | None                                                                                                     | A user opens the bug report dialog        |
| `review_bug_report_cancelled`     | None                                                                                                     | A user closes the dialog without a report |
| `review_bug_report_send_failed`   | Short `error_name`                                                                                       | A bug report request fails                |
| `review_setting_changed`          | `setting` in telemetry_enabled, keymap, dismissed_retention_days, software_map_enabled; `enabled`        | A user changes a Review setting           |
| `review_review_opened`            | `via` in home, cli, other                                                                                | A user opens a review                     |
| `review_home_empty_state_viewed`  | None                                                                                                     | The empty Home state opens                |

The server emits `review_review_submitted` after it stores a
submission. Its properties are `decision`, `comment_count`, and
`question_count`. The server emits `review_review_dismissed` after
it stores a dismissal. Its properties are `question_count` and `via` in
review_topbar, home.

The server emits `review_review_restored` when a dismissal ends. Its property
is `via` in home, open. The `home` value is the Undo button. The `open` value
is the implicit undo: a reader who opens a dismissed review brings it back.

## Workbench events

| Event                                           | Additional properties                                                                                                      | When                                        |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `review_lsp_used`                   | `feature` in hover, goto_definition, peek_definition, goto_type_definition, goto_implementation, references, rename, format, code_action, symbol_search; `via` in command, mouse; `language`; `editor_kind` in files_tab, inline_peek, diff | A user invokes an LSP feature               |
| `review_ls_activated`               | `group` in python, go, rust, swift, csharp; `ok`                                                                            | A language server activation check ends     |
| `review_extension_installed`        | Allowlisted `extension_id`; `trigger` in user, auto_upgrade, startup_seed, keymap, rollback; `cached`; `duration_ms`         | An optional extension installs              |
| `review_extension_install_failed`   | Allowlisted `extension_id`; allowlisted `trigger`; `phase` in download, install                                              | An optional extension install fails         |
| `review_extension_enabled`          | Allowlisted `extension_id`; allowlisted `trigger`                                                                            | Review enables an optional extension        |
| `review_extension_disabled`         | Allowlisted `extension_id`; allowlisted `trigger`                                                                            | Review disables an optional extension       |
| `review_extension_uninstalled`      | Allowlisted `extension_id`; allowlisted `trigger`                                                                            | Review uninstalls an optional extension     |

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

Review sends these properties with the `review_client_error` event.

| Property        | Value                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------- |
| `error_process` | Which part of Review failed: `main`, `renderer`, `canvas`, or `server`                      |
| `error_source`  | Which handler caught it, from a closed list                                                 |
| `error_name`    | The error class name, such as `TypeError`. Identifier characters only, 40 at most           |
| `component`     | A fixed Review component name, when the reporter has one. Identifier characters only        |
| `message`       | The error message, cleaned. See below                                                       |
| `message_hash`  | A fingerprint of the original message. See below                                            |
| `frames`        | Up to 10 stack lines, all inside the Review program. See below                              |

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
dialog requires a description. It has separate consent controls for the
current review source, head software map source, and changed-file diffs. All
three controls are on by default. A selected attachment can be unavailable.
The report still sends the other available data.

A review does not always have a software map. The report then omits the map and
records no error, because an absent map is a normal state.

The report payload contains these fields:

| Field                              | Value                                                                               |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| `schema_version`                   | Payload schema version `2`                                                          |
| `description`                      | The user-entered description, limited to 64 KiB of UTF-8 data                       |
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
- `review.db`, which holds the comment threads and the questions

The local server compresses the payload and sends it to
`https://bug.dev.fast/api/v1/reports`. The Worker stores it in the private
`dev-fast-bug-reports` Cloudflare R2 bucket. Only credentialed dev.fast
operators can read this bucket. An R2 lifecycle rule deletes objects under
`reports/` after 90 days.

The Worker sends a `review_bug_report` PostHog event after the R2
write. The event contains the report ID, UTC report date, description byte
length, attachment presence flags, compressed payload size, app version,
platform, and map or diff truncation flags. It does not contain the
description or attachments.

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
