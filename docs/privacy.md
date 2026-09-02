# Privacy

<!--
Outline: Local data -> Anonymous telemetry -> Errors -> Agent providers
-> Explicit bug reports -> Opt-out -> Developer inspection.
-->

Review reads source code and agent-authored documents from your machine. This
page separates the local product data, anonymous telemetry, connected coding
agents, and explicit bug reports.

Read the [dev.fast privacy policy](https://dev.fast/privacy) for the public
policy governing Review.

For the exact event schemas and implementation references, see the full
[telemetry reference](telemetry.md).

## What stays local

Review stores authored Reviews under
`~/.dev/reviews/<uuid>/` and keeps desktop discovery and
state under `~/.dev/review-desktop/` by default.

Passive product telemetry never includes:

- source code or changed-file diffs;
- paths, repository names, Review titles, refs, revision hashes, symbols, or
  declarations;
- review documents, comments, questions, or thread text;
- prompts or model output; or
- email, username, hostname, machine identifier, raw Review UUID, or coding-agent
  session identifier.

The canvas talks to Review's local server. It does not connect directly to
PostHog.

## Anonymous product telemetry

Anonymous telemetry is enabled by default. Review creates a random installation
UUID and does not associate it with a person profile.

Telemetry can include closed enums, booleans, counts, durations, the Review and
app versions, operating-system and architecture categories, feature usage,
opaque lifecycle-correlation identifiers, and sanitized product errors.
Review derives Review and presentation correlation IDs locally with a
namespaced HMAC keyed by the random installation ID. Raw Review UUIDs and
Desktop Review-session IDs never reach PostHog. PostHog may derive coarse
location at ingestion, but the project discards the source IP.

Pending events are stored in a bounded local queue under
`~/.dev/telemetry/events` by default. Review retries temporary
delivery failures and removes pending events after seven days.

## Error reports

Review can automatically report failures in its own app, canvas, server, or
background process. These reports may contain an error class, a cleaned message,
a one-way fingerprint, and up to ten stack frames from Review's own program.

Update telemetry records when an update is staged, when that exact target next
launches, or when checking, downloading, or installing fails. For a macOS
install failure, Review reads only log bytes appended after that update was
staged, extracts one concise ShipIt error summary, and passes it through the
same local cleaner. The raw ShipIt log is never stored in telemetry or sent.

Before sending, Review cleans paths, home and temporary directories, web
addresses, email addresses, and known secret formats. It drops repository,
dependency, and extension stack frames. It also drops any message that quotes a
Review document or does not pass a second local path-and-secret check.

## User-initiated bug reports

The **Report bug** dialog sends a report only after you select **Send**.

Under **Include diagnostic attachments**, three independent checkboxes control
whether Review attaches:

- **Review**: the current Review source and head software-map source
- changed-file diffs used by the review codepeeks (only the diff lines)
- **Agent session trace**: the complete raw local JSONL trace for the agent
  session that authored the Review and, for a forked Codex session, its complete
  parent history through the fork point

The Review and changed-file diff attachments are selected by default. **The
agent session trace is off by default and is included only when you explicitly
select it for that report.**

Review captures a screenshot before the dialog opens, so the dialog itself is
not in the image. The screenshot is attached by default with a visible preview.
You can remove it with the × button, or paste or drag an image to replace it.
Pasted and dropped PNG, JPEG, and WebP images are normalized to JPEG and limited
to 3 MiB.

You can turn off either default attachment, leave the trace unselected, and
remove the screenshot before sending.

If you opt in, the report includes the complete source-session JSONL trace and,
for a forked Codex session, its parent history through the fork point. It can
also include up to ten of the most recently modified subagent traces. This data
can contain prompts, model output, source code, file paths, URLs, and email
addresses.

Review replaces recognizable Google API keys, JWTs, Slack tokens, GitHub
tokens, and Microsoft Entra tokens before attaching the trace. Other
credentials or secrets may remain. Passive telemetry and trace-sync settings do
not enable this attachment.

The checkboxes control only those optional attachments. Every submitted report
also includes the optional description (which may be empty), app and CLI
versions, operating-system category, a random app-session ID, and up to 20
sanitized JavaScript error class names seen during that canvas session. It does
not include error messages in that list.

If a selected Review, map, or diff attachment is unavailable, Review omits it
and sends the other available data. Review does not send a partial source or
parent trace.

The report never attaches Review metadata, comment threads, or question
threads. Review stores completed reports in a private /dev/fast Cloudflare R2
bucket and deletes them after 90 days.

An explicit bug report is separate from passive telemetry and is sent even when
anonymous telemetry is disabled. Review shows the attachment choices before
submission.

## Turn telemetry off

In Review Desktop, open **Preferences → Settings** and disable **Share anonymous
usage data**. That setting controls both the app and CLI on the same
installation.

For a process or headless environment, set a supported opt-out variable:

```sh
DO_NOT_TRACK=1 review info
```

`DNT=1` and the Review-specific variables listed in the
[telemetry reference](telemetry.md#identity-and-control) are also supported.

## Inspect events during development

Set the debug sink before launching Review Desktop:

```sh
DEV_FAST_REVIEW_TELEMETRY_DEBUG=1 review app launch
```

Review prints each event to stderr instead of sending it to PostHog. See
[Developer sink](telemetry.md#developer-sink) for its exact behavior.
