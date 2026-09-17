# Immutable review sharing

Status: agreed product direction; implementation not started.

V1 shares remain immutable. Author-controlled updates to existing shares are a
future requirement; do not implement update endpoints, recipient polling, or
automatic publication of later edits in this pass. Keep share IDs distinct from
source review/version IDs so a later design can add revisions without conflating
local identity with a public link.

## Experience

- Share captures the exact saved review version being viewed, uploads it once,
  and returns an HTTPS link that opens Review Desktop. Subsequent edits do not
  change that share. Sharing a newer version creates a new snapshot and link.
- The sender signs in through the existing Review device-login flow. UI and
  CLI use the same authenticated share service and account identity.
  Initial GitHub authorization requests identity/email access; repository
  permission is requested only when the user enables hosted traces.
- Anyone with the link can download and view that snapshot without signing in,
  GitHub repository access, or a local clone.
- An HTTPS landing page hands off to the Desktop deep link and provides an
  installation fallback. It does not render the review in a browser.
- Desktop imports the snapshot into a separate, read-only shared-review
  namespace, opens it immediately, and retains it for offline reading.
- A small dismissible toast says: **Clone repository to enable code navigation
  and language features.** Actions: **Clone repository** and **Dismiss**.
  Show it once per imported share when a usable repository is not attached.
- Clone runs only after the recipient clicks. It uses the recipient's access,
  checks out the pinned revision in an isolated location, and does not modify
  an existing working copy. Private repository access may be unavailable;
  failure leaves the downloaded review usable.
- Attaching a clone enables the path to richer navigation. Language features
  also depend on suitable language extensions, configuration, and dependencies;
  the clone action does not silently install dependencies or run project scripts.

## Existing implementation and reuse

Review's JSON store (`packages/review/src/review-api/store.ts`) already stores
complete version snapshots: review ID, version, title, source pins, document
blocks, creation time, and optional origin metadata. Its immutable `resources`
table stores image, trace, and software-map bytes separately. The local
repository ID is a registry UUID, not a GitHub repository ID.

`sourceReferences()` in `review-api/document.ts` traverses source-bearing
blocks, including Markdown links, code peeks, sequence steps, call-stack frames,
and database operations. Map resources have additional source ranges to collect.
`LocalReviewData` resolves files from pinned Git/jj commits, validates resources,
and computes map change counts. Reuse those boundaries for export.

`api-document.tsx` loads the snapshot's images, retained trace resources, maps,
and commit summaries. Code components delegate to `InlineCodeEditor`, which
uses Desktop's native editor bridge. Keep the document block/source contract;
provide snapshot-backed source reads beneath those components. Audit that bridge
before finalizing implementation: `ReviewApiSourceService` already registers
virtual text models and reads `/reviews-api/:id/file`. Serve imported source
through that boundary and prove real rendering without a clone.

The JSON API versions every saved edit; it does not currently expose a separate
published-version pointer. For these reviews, Share means the exact displayed
saved version. For legacy reviews, export the presented version through the
existing JSON conversion/import path, not unpublished authoring files.

## Ownership and headless integration

This work owns sharing backend/auth, snapshot export, Desktop share/import,
clone attachment, and CLI share commands. Headless host extraction, CLI
installation/distribution, service discovery/autostart, and database-owner
lifecycle are owned by the coworker's separate workstream.

Keep export/import and the hosted share client independent of Electron. Expose
export through the existing local authoring service so both Desktop and a future
headless CLI use the same snapshot contract without opening a second SQLite
writer. The future remote flow is author locally, complete device login from
another machine, share over outbound HTTPS, then open the link in Desktop.
No tunnel, inbound remote connection, or device-delivery inbox is required.

The sharing acceptance gate is Desktop plus the current CLI against a running
local host. A clean headless installation is a joint integration check after the
coworker's host is available, not a prerequisite for delivering sharing.

Detailed contracts and delivery phases are in
[the implementation plan](review-sharing-implementation-plan.md).

## Upload payload

Use a versioned export envelope containing:

1. One review snapshot, with stable block/resource references preserved.
2. Only the image, trace, and map resources reachable from that snapshot.
3. Complete pinned text files referenced by document and map code peeks. Include
   both base and head versions where needed for inline comparisons, and record
   absent sides explicitly. Preserve repository-relative paths and commit IDs.
4. Resolved map change counts and unmapped counts, so viewing does not require
   recalculating them from a Git checkout.
5. Commit summaries needed by the current document loader, or an explicit
   snapshot-mode replacement if that dependency is removed during implementation.
6. Optional sanitized repository clone metadata, captured separately from the
   local registry ID: canonical remote and GitHub repository identity when known.
   Never copy credentials from remote URLs or publish absolute checkout paths.
7. A manifest of included files/resources and their sizes/digests, for validation
   and complete-import checks. This is a transport envelope, not a new authoring
   format or replacement for the existing block schema.

Trace resources are retained event lists (`id`, `role`, `text`), not references
that recipients must resolve through the hosted-trace API. Copying a referenced
resource includes its retained conversation, beyond the displayed quote. Keep
existing client-supplied provenance; do not relabel these as server-attested traces.
The share UI should state tersely what it includes, including full referenced
source files and retained trace conversations.

Do not upload the local database wholesale: exclude repository paths, command
receipts, attention state, other review versions, unrelated resources, credentials,
and authored executable bundles.

The initial scope is the document and its embedded content. Whole-repository
browsing, arbitrary commit diffs, and LSP navigation require a clone unless their
data was explicitly included. Only expose snapshot-mode actions the bundle can
satisfy. Bundled text still supports syntax highlighting, line numbers, context,
and comparisons for included file pairs.

## Backend and authorization

### Agreed sign-in flow

- Use GitHub as the only signup/sign-in provider for v1. Do not add email-only
  or password signup. Recipients still need no account to open a shared review.
- Initially request `user:email` and the basic identity access needed by the
  provider. Do not request `repo` for sharing. Select GitHub's verified primary
  email as contact information and retain the stable GitHub account ID as identity.
- Store contact email and its verification/source metadata separately. Existing
  `<id>@github.placeholder.invalid` values and their `emailVerified` flag are
  internal auth placeholders, never usable contact information. Missing contact
  email must not silently become a verified placeholder contact address.
- When the user enables hosted traces, check actual granted permissions. If
  `repo` is missing, offer **Authorize repository access** and run a controlled
  additional-permission flow for the same GitHub identity. Cancellation or denial
  leaves ordinary sign-in and sharing usable. Explain that OAuth `repo` access
  is broad; do not describe it as read-only or per-repository authorization.
- Preserve existing repository role checks and separate per-repository hosted
  capture consent. A scope grant neither grants GitHub roles nor starts capture.
- Keep account merging by email disabled. Verify the GitHub ID during permission
  upgrade; choosing a different GitHub account must not reassign the signed-in
  user's shares. Verify incremental authorization against the installed Better
  Auth version, including its current disabled-account-linking configuration.
- Separate session authentication for share ownership from GitHub API/token
  availability. Sharing and link management should not need the trace token
  broker to refresh a GitHub repository token on every request.
- Existing users keep their user IDs, sessions, share ownership, and previously
  granted trace access. Collect a contact email on a subsequent successful email
  authorization; do not force every existing user to sign out. A later basic
  login must not accidentally replace working trace credentials with narrower
  credentials. Handle externally revoked permissions explicitly.
- Do not expose contact email in share payloads or the public landing page. Show
  authenticated GitHub sharer attribution separately from document authorship.

GitHub supports sending users through authorization again for additional scopes:
[GitHub scope documentation](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps).
Better Auth documents same-provider incremental authorization:
[Better Auth OAuth documentation](https://better-auth.com/docs/concepts/oauth#requesting-additional-scopes).

### Share storage and access

Extend `apps/review-web` in the Dev repo, reusing its Worker, D1, Better Auth
session/device flow, and authenticated principal. Keep one backend Worker for
auth, hosted traces, and sharing, with distinct route modules and authorization
boundaries. Do not add a separate sharing Worker in v1. Add immutable share snapshots
and share-scoped resource/file records; publish the share only once all declared
content has been validated and stored. Use bounded uploads and retry-safe creation.
Determine D1 payload sizing during implementation; use existing object storage
for larger bytes if necessary rather than assuming one unbounded JSON row fits.

Use an unguessable share capability distinct from the sender's login token.
Scope every download to the exact share's manifest. Knowing a resource ID must
not expose resources belonging to other shares or hosted trace stores. Store a
digest of the capability and avoid putting it into telemetry or diagnostic text.

Existing trace policy stays unchanged: GitHub push allows trace uploads and
own-upload status; admin allows hosted trace reads/deletion. A share is an
explicit publication of locally available review content, not a new repository-wide
trace permission. Do not mint existing `trace_read` credentials for recipients
or let Share bypass authorization to fetch remote traces on the sender's behalf.

The v1 sender rule: a signed-in user can share a local snapshot and own
that share. A GitHub clone/access check is not required to publish local content.
Sharing does not enable hosted trace capture, change S3/R2 storage selection, or
grant repository upload consent. The share action is the explicit publication.

The creator can revoke a link. Revocation blocks future downloads; it cannot
erase snapshots already downloaded or copied. Links have no automatic expiry
in v1.
Defer the share-management UI. Store enough backend data to build it later:
share ID, authenticated owner ID, sender attribution, source review ID/version,
title, creation time, publication status, and revocation time. Support owner-scoped
listing and revocation without relying on the originating Desktop's local state.
Keep capability storage consistent with future copy-link support: retain a
server-encrypted capability alongside its lookup digest, available only through
authenticated owner access. A digest alone cannot reconstruct the original link.
Do not require a **Shared by you** page or other management UI for v1.

## Desktop and CLI implementation

Implement and validate the minimal GitHub/email login and permission-upgrade
flow before making hosted sharing depend on it. Include the additive contact
email migration and separation of session identity from repository authorization.

1. Implement a shared snapshot exporter that freezes one version, deduplicates
   referenced resources/files, resolves pinned data, and reports missing content
   before uploading. Never silently publish a broken partial review.
2. Implement authenticated creation, owner-scoped listing/revocation, and
   capability-scoped downloads in the Dev backend. Keep incomplete uploads
   invisible to recipients. Defer the management UI.
3. Add CLI share creation and revocation using existing login, with human link
   output and machine-readable JSON. Retry a failed request without duplicating
   the same creation operation; explicit new shares remain separate.
4. Add Desktop login/share UI backed by the same client. Read the currently
   displayed version once at the start of Share; concurrent edits cannot mix in.
5. Route HTTPS-to-Desktop links into a validated importer. Treat metadata and
   filenames as untrusted, namespace local IDs by share, verify completeness,
   and atomically register the downloaded snapshot. Do not execute bundled code.
6. Add the snapshot source provider/editor integration and retain current
   document components wherever possible. Ensure imported shares survive restart.
7. Add the clone toast and explicit clone/attach flow. Validate the remote and
   exact pins, honor the host's workspace trust controls, and keep snapshot display
   available when the clone lacks a pin or language tooling is unavailable.

## Acceptance checks

- Share a review with nested source references, an image, trace quotes, and a map;
  open the link in Desktop with no clone and no recipient login.
- Confirm document rendering, referenced code context/comparisons, retained trace
  expansion, and map display work from downloaded data, including after restart
  and without network access.
- Edit the sender's review after sharing; the old link and download stay unchanged.
- Confirm missing dependencies fail before a usable link is issued and interrupted
  upload/download retries cannot expose partial snapshots.
- Confirm a share cannot read unrelated resources, repository traces, local paths,
  or other review versions; verify revocation prevents fresh downloads.
- Verify clone toast dismissal, successful clone/attach, denied private-repository
  access, and missing pins. Show real navigation with a suitable configured language
  server before claiming advanced features work.
- Verify CLI and Desktop create equivalent snapshots and reuse the same login.
- Verify fresh minimal-scope login, verified contact-email capture, and existing
  placeholder-account migration without duplicate users. Verify a successful,
  declined, and wrong-account scope upgrade; revoked repository permissions;
  and a later basic login after traces were enabled. Sharing must remain usable
  without repository access or a functioning GitHub repository API request.
- Verify unsupported export versions produce an actionable Desktop update prompt;
  revoked links and upload/download size limits have clear errors.
- Once the coworker's headless host is available, jointly verify remote CLI
  authoring/sharing and main-machine Desktop import without a clone. Host startup,
  installation, and concurrent database ownership remain that workstream's gates.

## Agreed defaults and implementation investigations

The product decisions are settled, including these approved content/lifetime
defaults:

- Include complete referenced source files and complete retained trace resources,
  with a concise disclosure in Share. This preserves context but shares more than
  the visible snippets.
- Make links revocable without automatic expiry, with downloaded copies retained.

Implementation investigations: exact native-editor assumptions and virtual source
URI support; deep-link registration/install fallback; attachment to pinned clones;
payload limits/storage layout. These should not require a new document format.
