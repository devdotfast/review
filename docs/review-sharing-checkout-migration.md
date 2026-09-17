# Sharing with required GitHub checkouts

Implemented on [PR #338](https://github.com/devdotfast/review/pull/338), rebased
on main at `1cbb014e9` after [PR #332](https://github.com/devdotfast/review/pull/332) merged. The combined execution record is
[sharing-simplification-todo.md](sharing-simplification-todo.md).

Sharing publishes one immutable document with attribution, repository identity,
base/head commits, images, retained conversations, and map presentation. The
publisher fetches the commits into a temporary repository before uploading.
Recipients need their own GitHub repository access. Review never pushes commits
or requests hosted-trace permission as part of sharing.

The recipient downloads and validates the bundle, fetches a dedicated managed
repository, and prepares pinned workspaces through #332. Local metadata records
the recipient repository ID and completed validation; snapshot bytes stay
unchanged. Normal file, tree, diff, commit, source, and language readers use
that repository. Only retained resources and maps need shared-specific readers.

Imports report download, fetch, and validation progress. Failed fetches retain
the bundle for retry; complete imports reopen offline. Missing checkouts are
refetched. Deletion removes the managed repository, pinned workspaces, readers,
and unused registration. It never removes the author's or recipient's existing
checkout. Language setup follows normal Review behavior.

The optional clone UI, source attachments, bundled source, precomputed diff
lists, and separate source readers are removed. The immutable store, resource
isolation, sender attribution, and read-only guard remain.

## Backend and release boundary

[Dev PR #1068](https://github.com/Fix-Fast/dev/pull/1068) keeps sharing,
authentication, and hosted traces in one Worker. Its simplifications cover
Drizzle persistence, Better Auth capability encryption, GitHub re-grants, one
native Cloudflare limiter, shared helpers, and smaller request handlers.

Both repositories use protocol `0.1.1`. Dev's development tarball must be
replaced with the published package during the coordinated release. The format
is unreleased; recreate old development shares instead of adding compatibility
code. Do not rewrite a migration already applied to persistent data.

## Validation

Affected API/import tests cover offline source reads, unavailable commits,
credential retry, concurrent preparation, interrupted validation, missing
checkout repair, cleanup, read-only behavior, immutable history, and retained
traces. The existing native suite and package typechecks remain required.

`node apps/review-desktop/scripts/share-e2e.mjs --local-only --lsp` creates an
isolated profile and independently fetched checkout, hides the sender checkout,
and verifies rendered code, map, image, complete trace, attribution, native
source, and real TypeScript hover. `--github` instead fetches existing public
GitHub commits into both temporary publication verification and the recipient
checkout; it does not push anything.

These runs do not deploy the Worker or establish production OAuth/S3 and
packaged cold-start deep-link behavior. Those remain coordinated release gates.
