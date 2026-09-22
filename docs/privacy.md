# Privacy

<!--
Outline: Local data -> Anonymous telemetry -> Errors -> Agent providers
-> Explicit bug reports -> Opt-out -> Developer inspection.
-->

Whiteboard reads source code and agent-authored documents from your machine. This
page separates the local product data, anonymous telemetry, connected coding
agents, and explicit bug reports.

Read the [dev.fast privacy policy](https://dev.fast/privacy) for the public
policy governing Whiteboard.

For the exact event schemas and implementation references, see the full
[telemetry reference](telemetry.md).

## What stays local

Whiteboard stores authored sessions under
`~/.dev/reviews/<uuid>/` and keeps desktop discovery and
state under `~/.dev/review-desktop/` by default.

Passive product telemetry never includes:

- source code or changed-file diffs;
- paths, repository names, Session titles, refs, revision hashes, symbols, or
  declarations;
- review document text;
- prompts or model output; or
- email, username, hostname, machine identifier, raw session UUID, or coding-agent
  session identifier.

The canvas talks to Whiteboard's local server. It does not connect directly to
PostHog.

## Anonymous product telemetry

Anonymous telemetry is enabled by default. Whiteboard creates a random installation
UUID and does not associate it with a person profile.

Telemetry can include closed enums, booleans, counts, durations, the Whiteboard and
app versions, operating-system and architecture categories, feature usage,
opaque lifecycle-correlation identifiers, and sanitized product errors.
Whiteboard derives session and presentation correlation IDs locally with a
namespaced HMAC keyed by the random installation ID. Raw session UUIDs and
Desktop presentation IDs never reach PostHog. PostHog may derive coarse
location at ingestion, but the project discards the source IP.

Pending events are stored in a bounded local queue under
`~/.dev/telemetry/events` by default. Whiteboard retries temporary
delivery failures and removes pending events after seven days.

## Error reports

Whiteboard can automatically report failures in its own app, canvas, server, or
background process. These reports may contain an error class, a cleaned message,
a one-way fingerprint, and up to ten stack frames from Whiteboard's own program.

Update telemetry records when an update is staged, when that exact target next
launches, or when checking, downloading, or installing fails. For a macOS
install failure, Whiteboard reads only log bytes appended after that update was
staged, extracts one concise ShipIt error summary, and passes it through the
same local cleaner. The raw ShipIt log is never stored in telemetry or sent.

Before sending, Whiteboard cleans paths, home and temporary directories, web
addresses, email addresses, and known secret formats. It drops repository,
dependency, and extension stack frames. It also drops any message that quotes a
session document or does not pass a second local path-and-secret check.

## User-initiated bug reports

The **Report bug** dialog sends a report only after you select **Send**.

Under **Include diagnostic attachments**, three independent checkboxes control
whether Whiteboard attaches:

- **Session**: the current session source and head software-map source
- changed-file diffs used by the review codepeeks (only the diff lines)
- **Agent session trace**: the complete local trace records for the session that
  authored the session and available ancestor-session history through each fork
  point

The session and changed-file diff attachments are selected by default. **The
agent session trace is off by default and is included only when you explicitly
select it for that report.**

Whiteboard captures a screenshot before the dialog opens, so the dialog itself is
not in the image. The screenshot is attached by default with a visible preview.
You can remove it with the × button, or paste or drag an image to replace it.
Pasted and dropped PNG, JPEG, and WebP images are normalized to JPEG and limited
to 3 MiB.

You can turn off either default attachment, leave the trace unselected, and
remove the screenshot before sending.

If you opt in, the report includes those session records and can also include
up to ten of the most recently modified subagent trace tails. This data can
contain prompts, model output, source code, file paths, URLs, and email
addresses.

Whiteboard replaces recognizable Google API keys, JWTs, Slack tokens, GitHub
tokens, and Microsoft Entra tokens before attaching the trace. Other
credentials or secrets may remain. Passive telemetry and trace-sync settings do
not enable this attachment.

The checkboxes control only those optional attachments. Every submitted report
also includes the optional description (which may be empty), app and CLI
versions, operating-system category, a random app-session ID, and up to 20
sanitized JavaScript error class names seen during that canvas session. It does
not include error messages in that list.

If a selected Whiteboard, map, or diff attachment is unavailable, Whiteboard omits it
and sends the other available data. The source session's own trace is sent
complete or the report fails. Ancestor history is sent as far as Whiteboard can
read it, and the report names any ancestor it omits. If the compressed report
would exceed the upload limit, Whiteboard drops the trace and sends the rest.

The report never attaches Whiteboard metadata. Whiteboard stores completed reports in a private /dev/fast Cloudflare R2
bucket and deletes them after 90 days.

An explicit bug report is separate from passive telemetry and is sent even when
anonymous telemetry is disabled. Whiteboard shows the attachment choices before
submission.

## Hosted trace store

Hosted tracing requires explicit consent for each repository and origin.
Before setup, explain transcript contents, destination, and access rules below.
Without consent, capture stays off. S3 `autoActivateRepositories` never grants
hosted consent.

Trace capture is off by default. Hosted uploads start when this machine's
selected store is the hosted store and the repository is allowed. Selection
happens explicitly with `whiteboard trace storage use hosted`, or implicitly when
a machine that has no bucket configured allows a repository with
`whiteboard trace allow`. After that, complete agent session transcripts for the
allowed repositories are uploaded to the /dev/fast hosted store at the origin
you logged in to. One conversation can contain work from several
repositories; Whiteboard publishes a session automatically only when its captured
provenance places it in the allowed repository, and a commit trailer alone
never authorizes an upload. Transcripts can contain prompts, model output,
source code, file paths, URLs, and email addresses. Each publication also
records the checkout branch and the Git author name at that time.

Only GitHub users with current push access or higher to the repository can
discover or read its traces, for public and private repositories alike.
Read-only collaborators, former contributors, and the public cannot. Making a
repository public does not widen access. Deleting a store is admin-only and is
a logical deletion followed by operator cleanup; issued download links and
retained object versions expire on a bounded schedule rather than instantly.
`whiteboard trace deny` removes this machine's consent for the repository and keeps
prior uploads. `whiteboard trace store delete` asks the store to delete the
repository's hosted copies (admins only) and leaves the consent as it is.
`whiteboard logout` forgets the local login only.

Objects are encrypted with server-controlled keys, so /dev/fast can decrypt
stored traces. The GitHub OAuth app requests the `repo` scope to check access.
S3/R2 bucket storage sends nothing to /dev/fast.

## Turn telemetry off

In Whiteboard, open **Preferences → Settings** and disable **Share anonymous
usage data**. That setting controls both the app and CLI on the same
installation.

For a process or headless environment, set a supported opt-out variable:

```sh
DO_NOT_TRACK=1 whiteboard info
```

`DNT=1` and the Whiteboard-specific variables listed in the
[telemetry reference](telemetry.md#identity-and-control) are also supported.

## Inspect events during development

Set the debug sink before launching Whiteboard:

```sh
DEV_FAST_REVIEW_TELEMETRY_DEBUG=1 whiteboard app launch
```

Whiteboard prints each event to stderr instead of sending it to PostHog. See
[Developer sink](telemetry.md#developer-sink) for its exact behavior.
