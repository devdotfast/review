# Privacy

<!--
Outline: Local data -> Anonymous telemetry -> Errors -> Explicit bug reports
-> Sharing -> Hosted trace store -> Opt-out -> Developer inspection.
-->

Whiteboard reads source code and agent-authored documents from your machine.
This page separates the local product data, anonymous telemetry, explicit bug
reports, sharing, and hosted traces.

Read the [dev.fast privacy policy](https://dev.fast/privacy) for the public
policy governing Whiteboard.

For the exact event schemas and implementation references, see the full
[telemetry reference](telemetry.md).

## What stays local

Whiteboard stores authored whiteboards in `~/.dev/review-api.db`, whiteboards
opened from share links under `~/.dev/shared-reviews/`, and desktop discovery
and state under `~/.dev/review-desktop/` by default. These names predate the
Whiteboard rename.

Passive product telemetry never includes:

- source code or changed-file diffs;
- paths, repository names, whiteboard titles, refs, revision hashes, symbols,
  or declarations;
- whiteboard document text;
- prompts or model output; or
- email, username, hostname, machine identifier, whiteboard ID, or coding-agent
  session identifier.

The canvas talks to Whiteboard's local server. It does not connect directly to
PostHog.

## Anonymous product telemetry

Anonymous telemetry is enabled by default. Whiteboard creates a random
installation UUID per release channel and sends `$process_person_profile:
false` with every event, so PostHog creates no person profile.

Telemetry can include closed enums, booleans, counts, durations, the CLI and
app versions, release channel, operating-system version and architecture
categories, feature usage, opaque lifecycle-correlation identifiers, and
sanitized product errors. Whiteboard derives whiteboard and presentation
correlation IDs locally with a namespaced HMAC keyed by the random
installation ID; raw whiteboard IDs never reach PostHog. PostHog may derive
coarse location at ingestion, but the project discards the source IP.

Pending events are stored in a bounded local queue under
`~/.dev/telemetry/events` by default. Whiteboard retries temporary
delivery failures and removes pending events after seven days.

## Error reports

Whiteboard can automatically report failures in its own app, canvas, server,
or background process. These reports may contain an error class, a cleaned
message, a one-way fingerprint, and up to ten stack frames from Whiteboard's
shipped program.

Update telemetry records when an update is staged, when that exact target next
launches, or when checking, downloading, or installing fails. For a macOS
install failure, Whiteboard reads only log bytes appended after that update was
staged, extracts one concise ShipIt error summary, and passes it through the
same local cleaner. The raw ShipIt log is never stored in telemetry or sent.

Before sending, Whiteboard cleans paths, home and temporary directories, web
addresses, email addresses, and known secret formats. It drops repository,
dependency, and extension stack frames. It also drops any message that quotes a
whiteboard document or does not pass a second local path-and-secret check.

## User-initiated bug reports

The **Report a bug** dialog sends a report only after you select **Send**.

Under **Include diagnostic attachments**, two independent checkboxes control
whether Whiteboard attaches:

- **Session**: the saved whiteboard record, including its title, document
  text, pinned commits, and origin such as the branch and pull request URL,
  plus its software maps
- **Changed-file diffs used by CodePeeks** (only the diff lines)

Both attachments are selected by default. Attaching the agent session trace
that authored a whiteboard is not available yet: the dialog offers no trace
control and reports never include agent traces.

Whiteboard captures a screenshot before the dialog opens, so the dialog itself
is not in the image. The screenshot is attached by default with a visible
preview. You can remove it with the × button, or paste or drag an image to
replace it. Pasted and dropped PNG, JPEG, and WebP images are normalized to
JPEG and limited to 3 MiB.

You can turn off either attachment and remove the screenshot before sending.

The checkboxes control only those optional attachments. Every submitted report
also includes the optional description (which may be empty), app and CLI
versions, operating-system category, a random app-session ID, and up to 20
sanitized JavaScript error class names seen during that canvas session. It does
not include error messages in that list.

If a selected attachment is unavailable, Whiteboard omits it and sends the
other available data. If the report would exceed the upload limit, Whiteboard
drops attachments, starting with the diffs and then the maps, screenshot, and
whiteboard record, and sends what fits.

Whiteboard stores completed reports in a private /dev/fast Cloudflare R2 bucket
and deletes them after 90 days.

An explicit bug report is separate from passive telemetry and is sent even when
anonymous telemetry is disabled. Whiteboard shows the attachment choices before
submission.

## Sharing

Sharing is explicit. `whiteboard share` uploads an immutable copy of one saved
whiteboard version to the /dev/fast share service and returns a link. The copy
includes the document text, images, software maps, the commits it is pinned
to, your GitHub login, and the repository's GitHub clone URL. It does not
upload source code: recipients fetch the pinned commits from GitHub with their
own access. Anyone with the link can download the copy.
`whiteboard share revoke <share-id>` stops future downloads.

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

`DNT=1` and the other variables listed in the
[telemetry reference](telemetry.md#turn-telemetry-off) are also supported.

## Inspect events during development

Set the debug sink before launching Whiteboard:

```sh
DEV_FAST_REVIEW_TELEMETRY_DEBUG=1 whiteboard app launch
```

Whiteboard prints each event to stderr instead of sending it to PostHog. See
[Inspect events during development](telemetry.md#inspect-events-during-development)
for its exact behavior.
