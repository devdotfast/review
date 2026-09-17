# Sharing with required GitHub checkouts

Status: draft handoff; implementation is incomplete. [PR #332](https://github.com/devdotfast/review/pull/332) now includes prepared pinned language environments. Integrate sharing with that interface before merging. The focused independent checks below do not establish a working recipient flow or a successful full build.

## Stack and preserved work

- Working branch: `feat/sharing-required-checkouts`, in `../review-sharing-checkouts`.
- Current base: PR #332 at `ee675c8c3e14150d73b5ef2d679016915bc210e4`.
- Existing sharing changes were ported from `plan/review-sharing`. The original branch and its untracked Fable plans remain untouched.
- Dev changes remain in `../dev-review-sharing`, branch `feat/review-sharing`.
- Do not apply the unrelated Fable cleanup as part of this migration.

## Independent changes prepared

- The protocol requires a canonical GitHub repository URL. Remote normalization accepts GitHub HTTPS and SSH forms and excludes credentials from the published URL.
- Bundles retain the selected document, attribution, repository identity, pins, images, retained traces, and existing map presentation. They no longer contain source objects, missing-side metadata, general diff lists, or commit lists.
- Publication checks both full commit IDs by fetching into a fresh temporary Git repository before upload. It does not push or escalate hosted-trace permissions.
- The Git helper uses `gitAt`, isolated Git environment variables, disabled hooks, and a timeout. It fetches complete objects into persistent base/head refs. Local transport tests cover offline reads and unavailable commits.
- Dev consumes protocol package `0.1.1`. This remains a development tarball dependency until coordinated package publication; do not publish or deploy as part of the local preparation.

These changes are not a completed migration. The old recipient integration and its acceptance tests still require the changes below.

## Remaining integration

1. Inspect #332's new `review-api/workspaces.ts`, preparation routes, registration, language context, and cleanup interfaces. Reuse them for recipient lifecycle code rather than introducing another worktree manager. Restack again if #332 changes further.
2. Download and validate retained data. Fetch both pinned commits into an app-owned repository dedicated to the share. Use #332's pinning behavior to prepare its checkout(s). Keep sender snapshot bytes unchanged; store recipient repository identity in local metadata.
3. Validate document and map source references against fetched Git objects. Mark an import ready only after preparation and validation succeed. Deduplicate concurrent operations. Add host-local status polling with downloading, fetching, validating, ready, and error stages.
4. Reuse completed imports offline. Check missing repositories/pins locally at startup. Retry checkout preparation from retained data without another hosted download. Clean up app-owned repositories, worktrees, readers, and unused registrations when removing a share. Preserve user checkouts.
5. Resolve shared reviews to effective local pins in normal API readers, including language context. Allow source quoting and copy-context POST requests through the immutable-review guard. Keep ordinary commit-range validation, resource isolation, sender attribution, and authoring mutation rejection.
6. Remove shared source readers, source attachments and hash matching, optional cloning endpoints/UI, and clone guidance. Retain map/resource readers. Port the deep-link contribution from the removed session service to the current Desktop connection service. Audit other cherry-pick adaptations before claiming a successful build.
7. Update Share UI, CLI reference, and existing sharing plans to explain repository access and required checkout preparation. Replace repository-free tests and fixtures with required-checkout coverage. Update bug-report diff generation to use Git rather than removed presentation fields.

## Validation

Prepared focused checks:

- Protocol tests and typecheck.
- Local VCS typecheck.
- Sharing bundle, transport, client, and publication tests.
- Dev sharing Worker tests using the updated protocol dependency.

Still required after integration:

- Complete Review typecheck, lint, native checks, and affected API/import/reporting tests.
- Successful clean-profile import; code, added/deleted/renamed files, selected commits, quotes, copy-context, retained maps/images/traces, and language features through #332.
- Credential failure and retry; interrupted/concurrent imports; missing-checkout repair; offline restart; deletion and reimport without stale worktrees.
- Branch movement and author edits cannot change the snapshot. Read-only protection, integrity validation, and revocation of new downloads remain enforced.
- Visible Desktop acceptance with a real GitHub repository, followed by a review of the complete stacked diff.

The format is unreleased. Keep `review-share/1`, reject old development envelopes, and recreate development shares rather than adding compatibility code. Share capabilities authorize artifact downloads; Git credentials independently authorize repository access.
