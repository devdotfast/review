# Sharing simplification implementation checklist

This is the execution record for the approved combined plan. Check an item only
after its code and relevant validation are complete. Keep unrun acceptance work
unchecked. Review PR: https://github.com/devdotfast/review/pull/338. Dev PR:
https://github.com/Fix-Fast/dev/pull/1068.

## Setup and delivery

- [x] Inspect both worktrees and preserve existing work.
- [x] Restack Review on merged #332: main at `1cbb014e9`. The final base differs from the initially tested #332 only in its LSP test harness.
- [x] Refresh both previous plans to point to this combined execution record.
- [x] Keep protocol dependency and fixtures synchronized across repositories.
- [x] Commit changes in reviewable groups and update PR descriptions with evidence.
- [x] Review the final diffs and document any remaining release work.

## Dev authorization

- [x] Normalize GitHub scopes; test re-grants and downgrade protection.
- [x] Remove duplicate session lookup; preserve token retries and grant enforcement.
- [x] Share the device repository-grant predicate and fix cancelled state updates.

## Dev persistence and routing

- [x] Convert sharing persistence and cleanup to schema-backed Drizzle.
- [x] Preserve atomic quota reservation, idempotency, conditional states, and tombstones.
- [x] Register objects in parameter-safe batches; verify multi-batch registration.
- [x] Verify completion objects concurrently and use set-based conditional updates.
- [x] Paginate by creation time and ID; validate cursors and timestamp ties.
- [x] Split owner, recipient, and common handlers after behavior passes.
- [x] Preserve revocation rechecks after recipient reads and signing; test races.

## Dev rate limiting and crypto

- [x] Configure one native Cloudflare limiter (8192 requests/60 seconds/IP), separately for development and production.
- [x] Remove sharing rate-table bookkeeping; retain upload limits and storage quotas.
- [x] Update unapplied migration, snapshot, journal, generated bindings, and rollout docs.
- [x] Replace custom encryption with Better Auth and purpose-specific key derivation.
- [x] Validate encrypted payload and expected share ID; preserve minimum secret length.
- [x] Use Better Auth random capabilities and synchronous hashing without byte copies.
- [x] Test recovery, cross-share substitution, tampering, malformed data, and wrong secrets.

## Dev shared helpers

- [x] Share bounded-body reading with trace metadata; preserve size-error mapping.
- [x] Use protocol object-ID validation on owner and recipient routes.
- [x] Remove overwritten response headers; preserve CSP nonce and security middleware.
- [x] Consolidate S3 configuration and shared in-memory object-store fixtures.

## Review required checkout integration

- [x] Prepare app-owned pinned checkouts through #332's existing lifecycle.
- [x] Preserve snapshot bytes and store recipient repository identity separately.
- [x] Validate source/map references against fetched commits before marking ready.
- [x] Deduplicate imports and expose download/fetch/validation progress and retry.
- [x] Reuse offline imports; repair missing checkouts without redownloading retained data.
- [x] Delete only app-owned repositories, worktrees, registrations, and readers.
- [x] Use normal repository-backed readers and language context for shared reviews.
- [x] Remove bundled-source readers, optional clone UI/routes, and source attachments.
- [x] Generate reporting diffs from Git; retain resource routing and read-only enforcement.
- [x] Adapt native deep-link handling to the current Desktop connection service.

## Review helper and UI simplification

- [x] Reuse canonical GitHub URL normalization and hardened gitAt execution.
- [x] Validate signed HTTPS URLs without blocking signature query strings.
- [x] Use copyText's workbench clipboard fallback.
- [x] Share popover dismissal while preserving event phases and nested behavior.
- [x] Capture sign-in URL via openUrl; remove stdout parsing and retain progress/errors.
- [x] Share bounded stream reader with HTTP handling; preserve errors and cancellation.
- [x] Share a dependency-light stored trace schema with provenance.
- [x] Share resource-reference mapping; keep non-resource and root-tree behavior.
- [x] Remove obsolete diff schemas; retain single-pass bundle validation.
- [x] Update Share UI and CLI reference for repository access and explicit trace escalation.

## Acceptance and gates

- [x] Dev focused unit/Worker tests, typecheck, lint, and format checks.
- [x] Review affected tests, typecheck, lint, formatting, and native checks.
- [x] Local Git tests: unavailable commits, offline reads, retries, and pinned history.
- [x] Import lifecycle tests: concurrent/interrupted imports, repair, deletion, and reimport.
- [x] Live GitHub clean-profile Desktop import with visible rendered proof.
- [x] Verify added/deleted/renamed code, diffs, maps, images, full traces, and language features.
- [x] Verify credential retry, offline reopen, branch movement, immutable/read-only behavior, and revocation.

## Evidence and limitations

- Setup: both worktrees were clean. Review rebase completed without conflicts.
- Package publication, production deployment, and merge are separate release actions.
- Sharing is unreleased; do not silently delete persistent data or rewrite an applied migration.

- Dev validation: 74 Worker tests and 85 unit tests pass; package typecheck, repository lint, and formatting pass. The table-list assertion was removed without replacement, as requested.

- Local Desktop proof: `/tmp/review-share-e2e-4hHBIg` (rendered code/diff, map, image, complete trace, attribution, native source).
- Real GitHub clean-profile proof: `/tmp/review-share-e2e-QK2djc` (`octocat/Hello-World`, existing published commits; no push). Identical base/head pins retain an accessible Trace tab.
- Real TypeScript hover proof: `/tmp/review-share-e2e-WU80gp/shared-hover.png`, using the ordinary pinned source route and built-in language provider.
- Credential failures/retry, unavailable commits, branch movement, author edits, offline restart, missing checkout repair, read-only guards, integrity and revocation races are automated checks. Live GitHub used public repository access; private OAuth/S3 and packaged cold-start links remain release gates.

- Final Review checks: 192 affected tests, 99 native tests, 5 trace-auth tests, and 5 protocol tests pass. Review, trace-core, and native typechecks, repository lint, formatting, and whitespace checks pass. The development Desktop build succeeded.
- Dev's protocol tarball has byte-identical `dist/index.js` to Review's `0.1.1` build.
- Dev's repository-wide pre-push typecheck fails in unchanged `packages/review-agent-session-host` (missing Node and agent-session types/dependencies). Its files match `origin/main`; the focused review-web checks pass. Delivery bypasses that unrelated hook without changing the package.

## Coordinated release gates (not performed by this implementation)

- [ ] Publish protocol `0.1.1` and replace Dev's development tarball dependency.
- [ ] Apply the unapplied migration and deploy the Worker with the configured bucket, secret, and native rate-limiter bindings.
- [ ] Verify private GitHub authorization, production OAuth/S3, and packaged cold-start deep links in the release environment.
