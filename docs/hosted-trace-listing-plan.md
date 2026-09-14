# Follow-up: repository-wide hosted session listing

Status: deferred. This work is separate from the capture diagnostics changes.

## Interface

Add `review trace sessions [--limit <n>] [--cursor <id>] [--storage hosted] [--json]`.
Keep existing `trace list` behavior. Resolve the current repository and selected
hosted origin. Reading sessions does not require local publication consent.

## Backend and shared contract

Permit the existing sessions API to receive neither a commit nor a session
filter. The current shared schema rejects that request; the backend query
already scopes by active store and conditionally applies the filters.

Preserve repository authorization, active-store checks, completed-upload
filtering, session-ID ordering, and cursor pagination. Default to 50 entries;
retain the existing maximum of 200. Preserve the response contract. No database
schema change is planned.

## CLI behavior

Display session ID, harness, update time, branch, and stored bytes. Exclude
signed download URLs from all CLI output. Return an empty successful result
for an empty store. Report authentication, access, deleted-store, and network
failures explicitly. If S3 is selected, explain that this command requires
hosted storage. Do not switch stores or fall back.

## Delivery and validation

Recheck current shared-contract and backend sources before implementation.
Backend source: `Fix-Fast/dev`, `apps/review-web/src/lib/trace-api/sessions.server.ts`.
Shared schema and CLI source: `devdotfast/review`.
Deploy backend support before releasing the client command. An older backend
must produce a clear unsupported-operation error.

Check pagination, empty stores, incomplete uploads, access revocation,
repository isolation, existing filtered queries, and output without signed URLs.
Use isolated worktrees. Publishing and deployment require separate authorization.
