# Review sharing simplification plan

Status: separate follow-up audit; changes below are not yet applied.

The [required-checkout migration](review-sharing-checkout-migration.md) supersedes
any repository-free viewing or optional-clone assumptions below. Re-evaluate
items against the completed migration before applying them.

This follow-up addresses the second Fable review and reuse audit. It builds on
[the implementation plan](review-sharing-implementation-plan.md), including the
first round of Fable fixes. It preserves immutable snapshots, anonymous
link-based downloads, separate contact email, and explicit hosted-trace consent.

Work in the existing isolated checkouts:

- Review: `/Users/aiansiti/workable/review-sharing-plan`.
- Dev backend: `/Users/aiansiti/workable/dev-review-sharing`.

Do not change the core checkouts. Package publication, deployment, and the
standalone headless host are outside this follow-up.

## 1. Correct the confirmed bugs first

### GitHub token replacement — Dev

The installed Better Auth version parses `read:user,user:email,repo` as one
array element. Consequently, `tokens.scopes.includes("repo")` is false.
Initial basic-to-repository upgrades work through the SQL predicate's other
branch, but replacing an existing repository token fails. This can preserve a
dead token after the user revokes and reauthorizes the OAuth app.

- Normalize scope strings and array entries by splitting on commas and
  whitespace, removing empty entries and duplicates.
- Reuse that normalization in login and stored repository-grant checks.
- Store normalized scopes with the token in the existing atomic update.
- Preserve the rule that a basic login cannot replace a repository token.
- Extract the device-grant predicate used by both the approval UI and server
  enforcement. Preserve the legacy rule that missing device scope requires
  repository access.
- Move the repository-grant check into the existing token-resolution path,
  after its session lookup. Remove the extra outer lookup. Preserve token
  retry and session revalidation behavior.

### Clipboard and cancelled requests — Review and Dev

- Use Review's existing `copyText` helper in Share. It attempts browser copy
  and then the workbench-compatible fallback. Show the manual-copy message
  only when the helper returns false; keep the link available for copying.
- In Dev's device approval effect, check `cancelled` before every state update,
  including `setNeedsRepositories`.

## 2. Simplify the Dev backend

### Share listing and completion

- List shares newest first by `created_at DESC, id DESC`.
- Replace the UUID-only cursor with an opaque base64url-encoded JSON cursor
  containing `{createdAt, id}`. Validate both fields. Select rows older than
  that pair and retain the existing page size and `nextCursor` response.
- Use the existing `(owner_id, created_at, id)` index. Update API documentation
  and verify that the Review client treats the cursor as opaque.
- No compatibility adapter is needed for the unreleased UUID cursor.
- Keep the completion batch at 32 objects. Check S3 attributes with at most
  six concurrent requests, then record successful verification in one D1
  batch. Await all started checks before returning on failure.
- Do not mark a share ready if any object fails. Preserve the conditional
  ready transition and final revocation check. Failed checks remain retryable.

UUID pagination was deterministic, not literally random per request. The
change provides useful chronological ordering; it does not repair unstable
sorting. The existing index could still help filter by owner.

### Validation and response plumbing

- Translate an oversized stored manifest into `manifest_integrity_failed`
  with status 409. Keep oversized incoming request bodies as 413. Invalid,
  unknown, and revoked recipient capabilities still return 404 before storage
  is read. Do not catch unrelated storage errors as integrity failures.
- Parse owner upload object IDs with the protocol's `objectIdSchema`, as the
  recipient route already does. Keep route matching separate from ID validation.
- Remove duplicate cache-control and referrer-policy assignments from the
  share response helper and handoff page. Use `Response.json` for JSON responses;
  the outer Worker remains responsible for security headers and CSP nonces.
- Replace the duplicated S3 configuration literals with a small factory used
  by request and cleanup handlers. Read bindings when called; do not introduce
  cached request state or module-initialization network work.
- Pass the typed-array view directly to Web Crypto instead of copying it with
  `Uint8Array.from`. Preserve the view's offset and length and avoid unsafe casts.
- Rename the unreleased migration to `0007_review_sharing.sql`. Update the
  journal tag and documentation references; leave its SQL and snapshot identity
  unchanged. Do not rename a migration already applied to a shared environment.

Earlier migrations use mixed naming. The rename is a readability improvement,
not a correctness requirement. If deployment status changed since this review,
retain the existing name.

## 3. Reuse Review code without weakening boundaries

### UI and login progress

- Extract a small popover-dismiss hook for Share, history, diff layout, and
  the matching App control. Preserve each control's event capture behavior,
  trigger containment, open state, and cleanup. Do not change focus or layering.
- Add an optional typed `onPending({url, userCode})` callback to `runStoreLogin`.
  Call it when device-code login becomes pending. Preserve existing CLI text
  and JSON events. Desktop uses the callback instead of parsing stdout chunks
  as JSON lines.

### URLs, Git processes, and streams

- Put a reusable HTTPS/no-credentials URL schema in the sharing protocol.
  Derive purpose-specific checks rather than applying one final schema everywhere:
  clone URLs forbid query and fragment; share links require the capability
  fragment; signed storage URLs retain their query parameters. Preserve the
  existing localhost HTTP exception only for the development service origin.
- Extend `gitAt` with the options needed by sharing: child environment, timeout,
  and output limit. Preserve existing defaults and subprocess observation.
  Use it for cloning and remote lookup. Retain explicit worktree selection,
  disabled hooks/fsmonitor, and clone environment filtering. A direct replacement
  with today's `gitAt` would lose these controls.
- Extract a dependency-light byte-stream reader inside Review and use it from
  the sharing client and Hono request reader. It enforces the streaming byte
  limit, cancels on overflow, and releases the reader. Keep content-type checks,
  JSON parsing, empty-body defaults, and boundary-specific errors in the callers.
- Do not create a new package for this reader or move unrelated trace transport
  code. The claimed existing streamed reader in current trace-core was not found.

### Retained trace and diff shapes

- Move the common retained-trace shape into a lightweight Review module.
  Reuse it in local resource handling and sharing import. Preserve nonempty
  event IDs. Keep upload input and stored provenance rules explicit; do not
  import the heavy local-data implementation into the importer.
- Narrow imported diff statuses to the producer's actual values: `added`,
  `modified`, `deleted`, and `renamed`. Remove the reporting conversion for
  `copied`, `unmerged`, and `unknown`.

## 4. Validation and acceptance

Use behavioral checks rather than tests that repeat constants or source text.

- GitHub: basic login, basic-to-repository upgrade, repository-to-repository
  token replacement, and later basic login preserving the broader token.
  Exercise comma-delimited, whitespace-delimited, and array scope inputs.
  Verify UI and server device-grant decisions agree, including missing scope.
- Token broker: one explicit session resolution on the normal path; missing
  grants reject before GitHub repository work; retry still reloads current auth.
- Clipboard: denied browser permission followed by successful fallback; both
  methods failing retains the manual link. Check actual Desktop copying.
- Device UI: a stale request cannot update either screen or repository-grant state.
- Listing: stable newest-first pages, equal timestamps, malformed cursors,
  owner isolation, and no duplicate rows across pages of a fixed dataset.
- Completion: bounded parallel checks, missing or corrupt objects, retry after
  failure, and revocation while checks are in flight. Check final Worker headers
  on success, failure, and the handoff HTML after removing inner duplicates.
- Integrity: an oversized stored manifest returns 409, while bad capabilities
  remain 404. Hash a nonzero-offset typed-array view without including surrounding
  bytes. Owner and recipient object-ID validation must agree.
- Reuse: preserve URL acceptance rules; verify Git execution context and observer
  callbacks; test reader limits without Content-Length, cancellation, empty bodies,
  and stream errors; retain trace provenance and reject unsupported diff statuses.
- Run relevant existing suites, typechecks, lint, and formatting in each repo.
  Repeat the local Desktop share/import/source smoke test after integration.
  Inspect the migration journal and run migrations against a fresh local database.

The work is complete when these checks pass, the protocol consumer builds in
Dev, and both progressive reviews describe the resulting changes. Keep live
GitHub/S3 publication, packaged deep links, and clone/LSP acceptance explicitly
separate from mocked and local proof.

## 5. Deferred work and release assumptions

- Do not migrate all controls to native HTML popovers in this follow-up.
- Defer cross-package source-path consolidation until the package audit.
  `checkSourcePath` permits an empty repository root; shared file paths also
  reject empty segments, DEL, and oversized paths. They are not interchangeable.
  Never make the protocol package depend on Review or weaken sharing validation
  merely to remove duplication.
- The local trace schema is currently private, not an existing public export.
  Share its common definition through the extraction above.
- The Dev tarball remains temporary. Before merging Dev, publish the sharing
  protocol, replace the file dependency with its released version, regenerate
  the lockfile, and remove the archive. Publishing is a separate authorized action.
- Apply this follow-up as coordinated Dev and Review changes. No new product
  decisions, share-management UI, mutable links, or headless distribution are added.
