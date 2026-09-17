> Current implementation checklist: [sharing-simplification-todo.md](sharing-simplification-todo.md). The required-checkout design supersedes repository-free viewing and optional cloning below.

# Review sharing implementation plan

Status: implemented locally; hosted and packaged release gates remain open. Product decisions are recorded in
[the design](review-sharing-plan.md). No further product decisions block work.
Code claims below were verified against Review `864fb9732` and Dev
`origin/main` `6e7ff82c6c9` on 2026-09-16; the "Verified state" notes record
what the code actually does where it differs from earlier drafts.

## Scope and ownership

Review repo: transport contract, export/import, source-provider routing, Desktop
login/share/deep-link UI, clone attachment, and CLI share commands.

Dev repo: minimal GitHub/email auth, incremental repository authorization,
contact-email migration, share storage/API, and HTTPS handoff/install page.

### One hosted backend Worker in Dev

Extend the existing `apps/review-web` Worker at `app.dev.fast`, which already
owns auth and hosted trace APIs on current Dev main. Do not introduce another
sharing Worker, auth service, cross-service token exchange, or separate public
backend origin for v1.

Verified state: review-web is a TanStack Start app on Workers with a single D1
binding (`DB`) and no R2, KV, or Durable Object bindings. Trace bytes live in
external AWS S3 (`devfast-review-traces`, replica, and `-dev`), reached with
`aws4fetch` SigV4. Clients transfer bytes directly through presigned PUT/GET
URLs (900 s and 300 s TTL); the Worker never proxies object bytes and caps API
request bodies at 64 KiB. The production bucket holds only hosted traces, all
under `r<repositoryId>/` prefixes (about 1 GB as of 2026-09-16).

Reuse the D1 binding for auth/contact metadata, trace metadata, and new share
tables. Store share objects in the same S3 bucket under a separate `shares/`
prefix, using the existing presigner and completion-verification code. A move
to Cloudflare R2 is deferred; when it happens it is a separate Dev PR that
migrates both prefixes at once, so nothing in the share design may depend on an
S3-only feature beyond what traces already use. Shared deployment does not
imply shared object authorization or a single unbounded JSON row: trace and
share records/resources retain distinct ownership boundaries.

Keep route families and services separate inside the app:

- Existing auth/device routes plus same-account permission upgrades.
- Existing `/api/trace` routes with unchanged repository roles and consent rules.
- New `/api/shares` owner routes, using the app session without requiring GitHub
  repository access or a live GitHub call for each request.
- New `/api/shared` recipient routes, using only the share capability scoped to
  one completed snapshot; these cannot call the trace API as a privileged deputy.
- `/s/:id` HTTPS handoff/install page, served by the same application.

This shares identity, migrations, deployment, and operational tooling. There is
no current requirement to split Workers. Revisit only if measured load/resource
isolation, distinct deployment ownership, or platform constraints justify it.

### File/module ownership by repository

| Concern | Dev repo: `apps/review-web` | Review repo |
| --- | --- | --- |
| Auth | `src/lib/auth.server.ts`, token/session helpers, same-account scope upgrade, contact-email D1 migration | `packages/trace-core` auth client; login flags and trace escalation; Desktop account UI |
| Share contract | Consume the published envelope package; validate only the envelope, never the document | Own/publish `@dev.fast/review-share-protocol` (envelope only); block/source schemas stay in `packages/review` |
| Creation/storage | New share service/API modules, D1 migrations, object storage, retry/completion checks | Export exact local version and referenced bytes through the existing local host |
| Download/revoke/list | Capability downloads and owner-only listing/link recovery/revocation | Reusable Node share client; CLI share/revoke; staged importer and local cache |
| Links | HTTPS handoff/install page | Registered Desktop protocol handler, cold/warm open, paste-link fallback |
| Rendering/source | No review renderer and no Git clone | Local snapshot data provider, existing virtual source/editor path, read-only enforcement, clone attachment |
| Documentation/tests | API/auth/migration/deployment and Worker behavior checks | CLI reference/help, skills/onboarding/privacy, export/import and actual Desktop acceptance |

Publish/version the portable contract so Dev can consume a pinned dependency.
Follow the `@dev.fast/trace-protocol` recipe exactly: publish from
`packages/<name>` with `publishConfig.access: public`, depend from
`apps/review-web` with an exact version (no caret), bump in a dedicated Dev
commit, and add the package name to `minimumReleaseAgeExclude` in Dev's
`pnpm-workspace.yaml`. Without that entry Dev refuses new releases for seven
days. Do not add Node SQLite, Electron, Git subprocesses, or the local
authoring host to the Worker. Any backend storage adapter remains in Dev;
renderer/native editor code remains in Review. The CLI and Desktop never receive direct D1 credentials.

Coworker: standalone/headless packaging and authoring-host lifecycle. We expose
the same export and share functions to the future host; do not implement its
autostart, discovery, or installer here.

V1 excludes share updates/polling, collaboration, browser rendering, email/password
signup, recipient login, automatic delivery to a named device, and management UI.
Backend owner listing and revocation remain included.

## Implementation contracts

### Snapshot bundle

Introduce a versioned `review-share/1` envelope around the existing `Snapshot`
and `Block`/`Source` schemas.

Verified state: `Snapshot` is a plain TypeScript interface declared in
`packages/review/src/review-api/store.ts`, whose module imports `node:sqlite`;
there is no `Snapshot` zod schema. `Block` (`review-api/blocks/index.ts`) and
`Source` (`source.ts`) are zod and portable module by module, but they live in
`packages/review`, which depends on sharp, isomorphic-git, hono and React.
Neither can be consumed by the Worker as-is.

Decision: the Worker never validates the document. The published envelope
package `@dev.fast/review-share-protocol` defines only the envelope: format
version, sanitized repository metadata, sender-facing summary fields, and the
immutable object list. The snapshot document, commit summaries, and map
presentation data travel as objects the Worker stores and serves opaquely.
Desktop validates blocks and sources on import, where those schemas already
live. This keeps the published contract tiny, keeps `Snapshot` and the block
schemas where they are, and means Dev never bumps a dependency when a block
kind changes. Do not move block schemas into a shared package for this work.

The manifest lists sanitized optional repository metadata, the required reader
format version, and the immutable objects. Each object has an opaque
bundle-local ID, kind, MIME type, byte length, and SHA-256 digest. Resource IDs
remain meaningful only inside the bundle. File entries map commit/path to an
object, or explicit absence for a comparison side. Deduplicate repeated
files/resources within the bundle; defer cross-share deduplication.

Export algorithm:

1. Resolve `reviewId` and the requested/displayed version once, then read that
   complete snapshot. Never reread the current-version pointer during export.
2. Collect source ranges with `sourceReferences()` (Markdown `review-source:`
   links, `call_stack_diff` frames, `database_lens` operations, and any element
   with a `source` field). It returns source ranges only. Add a separate walker
   over `elements()` for the three resource-bearing kinds: `image.assetId`,
   `trace_quote.traceId`, and `software_map.mapVersionId`. The only existing
   per-kind resource resolver is `LocalReviewData.validateResource`. Then
   collect the additional source ranges inside map resources.
3. Validate resource ownership/type, quote references, pins, and source ranges.
   Read full referenced files at exact commits and comparison counterparts.
   Preserve rename metadata where comparison requires different paths; distinguish
   a legitimately absent side from a failed source read.
4. Materialize map counts, commit summaries, and included-file diff summaries
   needed by the chosen snapshot-mode UI. Do not imply full repository coverage.
5. Validate references against the completed manifest, apply size/count limits,
   and stage immutable bytes locally for retries. Fail if required content cannot
   be resolved. Do not upload unrelated resources, local paths, or credentials.

Use existing image bytes and retained trace event lists; do not rerun authored
JavaScript or re-fetch arbitrary hosted traces during export. Treat Markdown
external links as links, not crawl targets. Audit whether Markdown images need
normalization to managed image resources before claiming offline completeness.

### Local host boundary and client library

Expose export of one review/version through the local host. The host owns store
reads and source resolution; the CLI must not independently open its database.
Factor the exporter around injected snapshot/resource/source readers so the
coworker's host can reuse it without importing Electron.

Verified state: the local host is `createGlobalReviewServer` in
`packages/review/src/server/desktop-server.ts`, bound to `127.0.0.1` with a
per-process bearer sent as `x-review-token` and discovered through
`$DEV_REVIEW_HOME/review-desktop/server.json`. The review routes are in
`packages/review/src/review-api/http.ts`, mounted at `/reviews-api`. No export
or share route exists. The closest read is `GET /reviews-api/:id?full=true`,
which returns the whole `Snapshot` via `store.read(id, version)`; the export
route belongs beside it, behind the same `data` guard as the source routes.
`ReviewApiClient` in `packages/review-protocol` is the shared HTTP client.

The shared Node client handles authenticated creation, object upload, completion,
link recovery, owner listing/revocation, and capability-scoped download. UI and
CLI call this same implementation. Keep local host credentials, hosted account
sessions, and anonymous share capabilities as separate credential types.

Proposed CLI surface: `review share --review <id> [--version <n>] [--json]`, plus
`review share revoke <share-id>`. Resolve an omitted version once. Return share
ID, shared version, and URL; do not change the local review's authoring state.
The URL is intentional command output, but must not enter diagnostic telemetry.

### Hosted state and API

Use these logical D1 records (final SQL names may follow repo conventions):

- `review_share`: ID, owner user ID, source review ID/version, title, sender
  attribution, format, manifest/digest, total bytes, status, created/completed/
  revoked times, capability digest, encrypted recoverable capability, key version.
- `review_share_object`: share ID, opaque object ID, kind/MIME, expected size/hash,
  storage locator, verification state. Composite identity includes share ID.
- A unique owner/creation-request ID for retry-safe creation, bound to the manifest
  digest. Reusing a request ID with different content returns a conflict.

Decision: D1 holds the share row and the object table only. Every payload
(manifest, snapshot document, files, images, traces, maps) is an S3 object
under `shares/<shareId>/<objectId>`, because the Worker caps request bodies at
64 KiB and a manifest that embedded the document would not fit. Reuse the
trace presigner: conditional-create PUT with signed content-length and
`x-amz-checksum-sha256`, and `GetObjectAttributes` at completion to verify
size and digest against the declared object table. Do not duplicate trace
authorization, reinterpret a trace store as a share, or expose trace object
keys as public share object identifiers. Set explicit object/count/total limits
and cleanup policy before enabling uploads.

Proposed HTTP contract:

| Operation | Authorization | Result |
| --- | --- | --- |
| `POST /api/shares` | Account session | Create pending share with manifest size/hash and creation request ID; return manifest PUT |
| `POST /api/shares/:id/manifest` | Owner session | Read bounded uploaded manifest, validate and register its objects before content upload |
| `POST /api/shares/:id/objects/:objectId/upload` | Owner session | Issue a presigned PUT for the declared size/digest; retry-safe, conditional create |
| `POST /api/shares/:id/complete` | Owner session | Validate completeness, publish atomically, return link |
| `GET /api/shares` | Owner session | Cursor-paginated own-share metadata; no management UI |
| `GET /api/shares/:id/link` | Owner session | Recover original active link |
| `DELETE /api/shares/:id` | Owner session | Idempotently revoke future downloads |
| `GET /api/shared/:id` | Share capability | Ready manifest plus server-authenticated sender attribution |
| `GET /api/shared/:id/objects/:objectId` | Share capability | Short-lived presigned GET for an object belonging to that active share |

Pending shares are unreadable. Completion must validate actual stored bytes,
not merely trust client-declared digests, and cannot race revocation into
republishing a share. No update endpoint exists. Scope every lookup by share and
owner/capability as appropriate. Anonymous failures should not expose private
metadata. The capability check happens when the presigned GET is issued, and
revocation immediately stops new URLs. Already-issued URLs remain usable for
up to five minutes, as approved. Already delivered bytes are not revocable.

Rate-limit creation/downloads, cap retained pending uploads, and clean up abandoned
objects. Verified state: the only rate limiting in review-web is Better Auth's
own D1-backed limiter for auth paths; `/api/trace` has none, so share routes
need their own. For cursor pagination, copy the zod-validated base64 cursor in
`src/lib/trace-api/upload-status.server.ts`. Retries keep the same creation
request ID; an intentional new Share operation can create a separate share
even for the same source version.

### Authentication changes

Add nullable verified contact-email metadata without changing existing account
IDs or deriving ownership from email. Obtain verified primary email after a
successful `user:email` authorization; do not treat placeholder auth emails as
contacts. Missing/unverified email leaves contact data unset, not a failed identity.

Use app-session authentication for share operations, independent of live GitHub
repository requests. Add an explicit same-account repository permission upgrade
for traces. The implementation must prove initial minimal scope, retained prior
grants, wrong-account rejection, cancellation, external revocation, and unchanged
trace role/consent checks against the installed Better Auth version. Preserve
existing users' sessions and credentials during migration. No implicit email linking.

Verified state: device-code login already ships. review-web runs Better Auth
1.7.2 with the `deviceAuthorization` and `bearer` plugins, client id
`review-cli`, and the `/device` approval page; `packages/trace-core`'s
`runStoreLogin` drives it and stores the bearer in `$DEV_REVIEW_HOME/auth.json`.
The GitHub provider requests `["repo"]` only, with default scopes disabled, and
maps every user to a `<id>@github.placeholder.invalid` email. Account linking
is disabled and the `/get-access-token`, `/refresh-token`, `/account-info` and
`/update-user` paths are disabled. The `account` row is unique per GitHub id
and holds one encrypted OAuth token, which every trace request decrypts for a
live GitHub permission check. Trace reads and deletes require repository admin;
writes require push. `review login --traces` does not exist yet; today's flags
are `--origin`, `--no-browser` and `--json`.

Two hard requirements follow:

- Better Auth's incremental-scope path normally runs through account linking,
  which is disabled here. PR 2 opens with a spike proving the same-account
  `repo` upgrade works under the installed configuration before any migration
  is written. If it cannot, the fallback is a separate GitHub OAuth app for the
  `repo` grant, still bound to the verified GitHub id.
- A basic-scope login must never replace a stored `repo` token with a narrower
  one; that would silently break hosted traces for the user. Persist the
  granted scope on the account and expose it to clients so the CLI can raise
  `repository_authorization_required` without a live GitHub call. `auth.json`
  has no scope field today; add one or have the session endpoint report it.

CLI permission contract:

- `review login` requests identity/email access; `review login --traces` also
  requests the GitHub `repo` scope. Both support `--no-browser` and JSON output.
- Interactive hosted-trace commands detect missing repository authorization,
  offer an explicit authorization prompt, invoke the same upgrade function, and
  resume the requested operation after success. Local/S3 commands never trigger it.
- Noninteractive execution, JSON automation, and background hooks must not prompt
  or wait for browser approval. Return a structured
  `repository_authorization_required` error with the remedy `review login --traces`
  through the command's existing error channel; preserve silent background-hook
  behavior. An unauthenticated session remains a distinct login-required condition.
- Missing GitHub repository role, repository consent, and provider/network failures
  are separate errors; do not loop authorization prompts to try to fix them.
- Desktop's hosted-trace setup uses the same upgrade logic. Repository authorization
  never switches storage destinations or enables capture by itself.

Documentation is part of the implementation's completion criteria. Update
`docs/cli-reference.md`, command-generated `--help`, relevant onboarding and privacy
pages, and shipped agent guidance in the same changes that add the commands.
Include minimal login, `--traces`, remote `--no-browser`, interactive/noninteractive
behavior, sharing/revocation examples, and the separate repository consent step.
Audit the standalone traces CLI's shared login implementation for compatibility;
do not silently change its established trace-oriented login behavior. Verified
state: `packages/traces` (`dev-traces login`) calls the same `runStoreLogin`
and shares the same `auth.json`, so any scope change is cross-CLI by
construction. Its login is trace-oriented and should keep requesting `repo`;
it also derives the no-browser flag as `options.browser === false` where
`review login` uses `!options.browser`, which is worth aligning while there.
Until the commands exist, keep their syntax in planning docs rather than
describe it as available in the released CLI reference.

### Deep links and recipient storage

Proposed public link: `https://app.dev.fast/s/<share-id>#<capability>`. Keep the
secret in the fragment so ordinary HTTP access logs do not receive it. The page
passes it to the installed application's registered scheme; Desktop sends it in
a dedicated authorization header when downloading. Audit page analytics, desktop
URL logging, crash reports, and referrers so the secret does not leak elsewhere.

Use the existing stable/preview protocol registration rather than inventing a
second application identity. Verified state: the schemes are `dev-fast-review`
and `dev-fast-review-preview` (`apps/review-desktop/scripts/release-channel.mjs`),
registered by stock VS Code plumbing in `electronUrlListener.ts`, with
cold-launch URLs handled in `electron-main/app.ts`. No Review URL handler
exists; register an `IURLHandler` under `vs/review` for the share path and
leave the listener untouched. Provide a visible Open Review action and install
fallback; do not assume browsers allow automatic app launch. After installation,
the user can reopen the original link. Support cold launch and already-running
Desktop, and provide a paste/open-link fallback if platform association fails.

Import in staging, enforce limits before allocation, validate schema and all
declared objects, then atomically register the complete download. Store incoming
objects by opaque IDs, not by unchecked repository paths. Use a local identity
derived from hosted origin plus share ID; never collide with an authored review
or a same-named resource in a different share. Reopening reuses the local copy.

Verified state: the JSON store has no read-only or status concept. The
`reviews` table carries only `id`, `version` and `next_id`; the only flags are
`review_attention.viewed_at/dismissed_at`; and `ReviewStore.execute()` has no
gate. The `reviewSessionModeIsReadOnly` machinery applies to legacy MDX
sessions only.

Decision: make read-only structural rather than a flag. Imported shares live
in a separate local store that `execute()` never sees, keyed by hosted origin
plus share id, and the local API routes a review id to either the authoring
store or the shared store. Mutation routes and CLI/MCP edits, rename, restore
and repin then fail for shared ids because there is no writer to reach, not
because each handler checks a bit. Local dismissal, cache removal, clone
attachment, and viewing state remain local operations. No recipients' actions
write back to the sender. Server attribution must override client-supplied sender
claims and remain separate from document author metadata.

### Source and clone behavior

`ReviewApiSourceService` already registers virtual text models and loads `/file`
through the local API. Extend data routing so imported reviews serve bundled files,
maps, traces, commit summaries, and included-file diffs through the same boundary. Resource URLs include the local shared review ID
(`/:id/resources/:resourceId`) so bundle-local resource IDs cannot collide.
Replace concrete `LocalReviewData` coupling with the smallest read interface
needed; preserve existing local-repository behavior. Verified state:
`LocalReviewData` (`review-api/local-data.ts`) implements no interface; the
only seam is the validation-only `ReviewProviders` in `store.ts`. Its
consumers are `http.ts`, `desktop-server.ts`, the legacy importer, and a
type-only import in `api-document.tsx`. Derive the read interface from the
routes `http.ts` guards with `if (data)`: a shared review must serve `file`,
`diff`, `commits`, `maps` and `resources`, and must visibly refuse `tree`,
`source` registration, `pins`, `repositories` and `upload`. Unsupported
repository-wide operations must be visibly unavailable, not return misleading
empty results.

Clone attachment is optional and must never replace snapshot bytes with current
branch contents. Retain share provenance/pins when attaching a repository. Verify
the remote and required commits; isolate any checkout and use workspace trust.
Map virtual snapshot sources to a verified checkout explicitly for language
navigation; prove this works while snapshot bytes stay pinned.
Only offer the clone toast if usable clone metadata is present. A missing remote,
denied access, missing pin, or unavailable language tooling leaves the review usable.

## Delivery phases and gates

### PR 1 — Export contract and clone-free local proof (Review)

Implement schema, dependency collector, staged export/import, and a source-provider
proof using a local exported fixture. Render code, trace expansion, image, and map
in real Desktop with the original repository unavailable. Exercise cross-share
resource isolation and local read-only enforcement. This settles the main technical
uncertainty before building hosted UX. No cloud deployment is needed for this gate.

### PR 2 — Minimal login and incremental trace authorization (Dev + Review client)

This phase comprises paired repo PRs: Dev owns server auth/migration and Review
owns flags, escalation, and device/UI status. It is not a single cross-repo PR.

Open with the incremental-scope spike described under Authentication changes.
Then add contact-email migration, basic scope login, the same-account upgrade
flow with corresponding device/UI status, and persisted granted scope. Validate
new and existing users and existing hosted trace behavior. Keep account
migration additive. Share ownership needs only the existing session and user
id, so PR 3 does not wait for this phase.

### PR 3 — Hosted immutable shares (Dev)

All backend code in this phase extends the existing `apps/review-web` Worker;
there is no additional Worker deployment.

Implement D1 migration, the `shares/` S3 prefix on the existing presigner,
creation/completion/download, owner listing/link recovery/revocation, cleanup,
and HTTPS handoff page. Reuse the validated PR 1 envelope. Start the Dev
worktree from `origin/main`; the core Dev checkout is behind. Flip the
wrangler config test only if a binding is added, which this phase does not do.
Check two-account ownership, capability isolation, incomplete uploads, digest
mismatch, retry conflicts, and revocation races in the Worker runtime. Deploy
schema before enabling routes; preserve existing trace data.

### PR 4 — Shared client and CLI (Review)

Implement local export endpoint and Node share client, authenticated CLI creation,
JSON output, retries, and revocation. Prove a real CLI upload against the backend
with a local host, without involving a Desktop renderer in export/upload code.
Publish the integration contract to the coworker's headless workstream.

### PR 5 — Desktop sender and recipient flow (Review)

Add login/account state, Share action, disclosure, upload progress/error/retry,
and copy link. Freeze the displayed version before login/upload waits. Wire URL
handling, staged download/import, sender attribution, read-only display, offline
reopen, compatibility errors, and the clone toast/attachment flow. Include a manual
copy fallback when clipboard writing fails. Do not add a share-management page.

## Testing and success criteria

Every PR has three layers: automated tests that run in CI, one scripted
end-to-end proof that a reviewer can rerun, and a short list of pass/fail
criteria. A PR is not done until all three hold. Do not add source-string or
change-detector tests; test behavior through the public boundary of each layer.

### Harnesses

- Review unit and DOM tests: `pnpm --filter @dev.fast/review test` (Node plus
  Vitest Browser Mode). Fresh worktrees need the tutorial assets and workspace
  deps built first; the `test` script's pre-hook does this.
- Review Desktop end to end: a new `apps/review-desktop/scripts/share-e2e.mjs`
  modeled on `native-authoring-e2e.mjs`, which spawns a built Desktop with an
  isolated `DEV_REVIEW_HOME`, reads `review-desktop/server.json`, and drives
  the window over Playwright/CDP. It runs two homes: sender and recipient.
- Dev Worker: `pnpm --filter @dev-fast/review-web test` and `test:worker`
  (the Workers runtime with D1 migrations applied). A new `test:share-live`
  mirrors `test:s3-live` for the presigner against the dev bucket.
- Cross-repo: the share e2e script takes `--origin`, defaulting to the Dev app
  running locally at `http://localhost:5174` (`pnpm --filter
  @dev-fast/review-web dev`, which applies D1 migrations to the local
  database first). Its dev vars already point `BETTER_AUTH_URL` at localhost,
  the dev GitHub OAuth app, and the `-dev` S3 bucket, so login, upload, and
  the handoff page all work without a deployment. Every gate below runs
  against the local app first; a dev deployment is only for the final
  PR 5 pass and release acceptance.

### Fixture

One committed fixture review under `packages/review/test/fixtures/share/`,
built from a real repository at two pinned commits. It contains every
supported embedded kind: Markdown with `review-source:` links, a `code_peek`
with base and head sides, a renamed file comparison, a file present on one
side only, a `call_stack_diff`, a `database_lens`, a sequence with steps, an
`image`, a `trace_quote` whose trace has more events than the quote, and a
`software_map` with additional source ranges. The exporter's expected manifest
for that fixture is checked in and compared by digest, not by string.

### PR 1 gate: export contract and clone-free proof

Automated:

- Exporter produces the expected manifest for the fixture; every referenced
  file, comparison side, image, trace and map is present and deduplicated.
- Exporter fails, with the missing reference named, when a file, resource, or
  commit is deleted from the fixture before export.
- Envelope validation rejects wrong format versions, undeclared objects,
  digest mismatches, and objects that exceed limits, before any bytes are
  staged.
- Importer accepts the fixture bundle into the shared store and rejects a
  bundle whose declared object is missing or whose digest does not match.
- Two imports of different shares that reuse the same bundle-local resource id
  do not collide.
- Every mutation route and CLI/MCP edit against a shared review id fails with
  a read-only error, and the authoring store is untouched.

End to end: `share-e2e.mjs --local-only` exports the fixture from the sender
home, imports it into the recipient home with no repository on disk, opens
it, and screenshots the document.

Pass when: the screenshot shows rendered code with line numbers for both
sides of the comparison, the absent side labeled as absent, the expanded
trace, the image, and the map with its change counts; the repository-wide
actions (tree, add source, repin) are visibly disabled; and the recipient
home has no path to the sender's repository.

### PR 2 gate: minimal login and incremental authorization

Automated (Worker runtime):

- A fresh device login with basic scope creates a user with the placeholder
  auth email and a separate verified contact email; no `repo` token exists.
- The upgrade flow adds `repo` for the same GitHub id and records the granted
  scope; a different GitHub id at upgrade is rejected and reassigns nothing.
- A later basic-scope login for a user who already holds `repo` leaves the
  stored token and scope unchanged.
- Cancellation, denial, and an externally revoked token each yield a distinct
  error, and trace routes keep their push/admin checks.
- Existing users' sessions survive the migration and still pass trace auth.

End to end, against the local Dev app with `--origin http://localhost:5174`:
`review login`, then a hosted trace command in noninteractive mode, then
`review login --traces`, then the same command.

Pass when: the first trace command returns
`repository_authorization_required` with the `review login --traces` remedy and
does not open a browser; the second succeeds; `dev-traces login` still works
unchanged; and `auth.json` contains no contact email.

### PR 3 gate: hosted immutable shares

Automated (Worker runtime):

- Create, upload, complete, and download the fixture bundle under one owner.
- A second owner cannot list, link, revoke, or complete the first owner's
  share; a capability for share A cannot fetch an object declared by share B.
- Completion fails when an object is missing, undersized, or has the wrong
  digest, and the share stays pending and unreadable.
- Reusing a creation request id with the same manifest returns the existing
  share; with a different manifest it returns a conflict.
- Revoke then complete, and complete then revoke, both leave the share
  revoked; revoked shares return the same anonymous error as unknown ones.
- Listing paginates by cursor and never includes another owner's rows.
- The capability appears nowhere in D1 except as a digest and an encrypted
  copy, and nowhere in logs.

Live: `test:share-live` uploads and verifies one object in the dev bucket
through the presigner.

Pass when, against the local Dev app: the handoff page at `/s/<id>` renders
with an Open Review action and an install fallback, the fragment never
reaches the server access log, and existing trace tests are unchanged.

### PR 4 gate: shared client and CLI

Automated: the Node share client retries an interrupted upload with the same
request id and resumes at the missing object; JSON output for `review share`
and `review share revoke` is schema-checked; the share URL is absent from
telemetry fixtures; `--help` and `docs/cli-reference.md` document both
commands.

End to end: `share-e2e.mjs --cli` against the local Dev app runs
`review share` through the sender home's local host and then downloads the
result with the client library into the recipient home, without a Desktop
renderer in the sender path.

Pass when: the CLI prints a share id, version, and URL; a second invocation
creates a distinct share; and the downloaded bundle is byte-identical to the
exporter's staged output.

### PR 5 gate: Desktop sender and recipient flow

Automated (browser mode): Share dialog states for logged out, uploading,
failed with retry, and copied; clipboard failure shows the manual copy
fallback; the displayed version is captured before the login wait.

End to end: the full `share-e2e.mjs` run against the local Dev app, then
once more against a dev deployment before merge. The handoff page step uses
`http://localhost:5174/s/<id>` locally; the deep-link scheme is the same.

1. Sender home signs in, opens the fixture, edits it once, and shares the
   displayed version.
2. Recipient home receives the `dev-fast-review://` URL via the deep-link
   handler, both cold and while already running, and imports it.
3. Recipient reopens Desktop offline and the share opens from the local copy.
4. Sender edits again; the recipient re-downloads and sees no change.
5. Sender revokes; a fresh recipient home fails to download while the first
   recipient's copy still opens.
6. Sender recovers the link through the CLI listing and it matches the
   original.
7. Recipient clicks Clone repository against the fixture's remote; the review
   keeps its pins and gains navigation.

Pass when: every step above is asserted by the script, the sender attribution
shown to the recipient is the server's GitHub login and not the document
author, no telemetry event in either home contains the capability or contact
email, and the seven screenshots are attached to the PR.

### Release acceptance

Run the PR 5 end-to-end script against production once, with a real review
that has all supported embedded content rather than the fixture, from a
production Desktop build in a clean profile. Then repeat step 5 with the
packaged preview build to confirm the preview scheme. Verify clone attachment
at the pinned commits and actual language navigation when a language server is
configured.

Headless clean-install and remote-to-main-machine acceptance happens jointly when
the coworker's host is ready. Its absence does not block the Desktop-sharing gate.

## Dependencies and first action

The phases are implementation/review boundaries, not five user-visible launches.
One coordinated implementation effort is possible, but the code spans two repos
and requires at least a Dev backend PR and a Review client PR. Prefer the smaller
PR boundaries above for auth/migration review and independent local validation.
Deploy additive backend support before enabling the Desktop/CLI feature; never
release a minimal-scope login that breaks existing trace clients waiting for their
permission-upgrade support. Either gate that login change until compatible clients
are ready or preserve a backward-compatible flow for existing client versions.

PR 1 determines the export contract and source routing. PR 2 and PR 3 run in
parallel: PR 3 depends only on PR 1's envelope and the existing session
identity, and PR 2 carries the auth risk, so neither should wait on the other.
PR 4 integrates PR 1 and PR 3; PR 5 integrates those with Desktop. Do not make
the cloud API accept an unstable payload format just to land the UI sooner.

Start by proving a shared local snapshot renders through the existing virtual
source provider with the repository unavailable. Product decisions are complete;
storage thresholds, compatible-reader checks, and concrete module names are
implementation choices to resolve using this proof and measured bundle sizes.


## Implementation record (2026-09-16)

The implementation is in `/Users/aiansiti/workable/review-sharing-plan`
(branch `plan/review-sharing`, rebased onto main `3d7d055a9`) and
`/Users/aiansiti/workable/dev-review-sharing` (branch `feat/review-sharing`,
base `6e7ff82c6`). Core checkouts were preserved. Nothing has been deployed,
published, or pushed.

Review now owns the versioned transport package, immutable export/import with
full pinned source bytes, offline read-only catalog, reusable sharing client,
Desktop account/share UI and deep-link handler, optional clone attachment, and
`review share` / `review share revoke`. The shared library exposes listing and
link recovery; these management operations do not yet have CLI commands or UI.
The existing CLI reference documents minimal login and trace permission upgrades.
The standalone headless host remains coworker-owned.

Dev extends its existing review-web Worker with owner and capability APIs,
D1 metadata/migration, S3 share objects, bounded resumable uploads, revocation,
cleanup, and the HTTPS handoff. GitHub identity uses separate verified contact
email and preserves repository grants during subsequent minimal login.
`apps/review-web/SHARING.md` contains deployment order, limits, and operations.
The new protocol tarball is vendored temporarily so the Dev checkout builds
without publishing a package; replace that dependency as part of release.

Validation completed:

- Review Node suite: 1,222 passed, one skipped; trace-core: 261 passed;
  trace and sharing protocol tests passed. Desktop tests and typechecks passed.
- Dev Node suite: 84 passed, four live-S3 tests skipped; Worker suite: 66 passed.
  Review and Dev builds, typechecks, and lint passed.
- `node apps/review-desktop/scripts/share-e2e.mjs --local-only` proved an
  imported JSON snapshot renders in the actual Electron Desktop with the
  sender repository renamed away. It exercised pinned native code, embedded
  image/map, sender attribution, full retained conversation, and Open file.
  Evidence: `/tmp/review-sharing-live-fixture2/report.json`,
  `shared-desktop.png`, `shared-trace.png`, and `shared-source.png`.

Remaining gates are explicit: the current share-e2e script is a local import
proof, not the seven-step hosted PR 5 scenario above. Live GitHub OAuth/S3,
sender-to-recipient network integration, packaged warm/cold deep links,
production/preview handoff, remote clone with actual LSP navigation, and
production release acceptance have not run. Local credentials were unavailable;
no production resources were changed. These gates must pass before release.


### Fable follow-up (2026-09-17)

Addressed the reported login, export-error, clone-cleanup, JSON-error, source-read,
validation, resource-route, reporting, and native-formatting findings. Shared
reviews now use the common Hono read routes with a shared-ID guard. Snapshot
reads use the same inspect semantics as local reviews; callers that need the
whole snapshot request `full=true`. A separate source-attachment endpoint returns
clone metadata without downloading the snapshot file again.

Full bundle validation runs once during import or cached startup load, and its
parsed result is retained. Download still checks envelope and object integrity;
document validation belongs to the importer. Removing a local share waits for an
active clone and removes the repository plus both pinned worktrees.

Regression checks cover expired-session reauthentication, actionable export
errors, cleanup and reimport, one JSON authorization error, missing shared-store
telemetry, scoped resources, and metadata-only source lookup. The repository-free
Desktop smoke test passed again. Hosted release gates above remain unchanged.
