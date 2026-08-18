# Lifecycle and storage

## Binding and pins

A Review binds to one unit of change:

- a Git branch
- a jj bookmark
- a jj change ID
- a GitHub pull request

Use a bookmark for a document about a stack. Use a change ID for one jj change. Use `review scaffold --pr <number-or-url>` for a pull request.

Choose the base deliberately:

- For a stack, use the branch directly below the reviewed stack.
- For one change, use its parent.
- A bare scaffold uses the trunk fork point.

Use `--base @-` for one jj change. Use `--base <head>~1` for one Git commit.

A bare scaffold needs a named checkout. Use `--head <ref>` for a detached Git HEAD. Scaffold output shows the selected change and pins.

`review scaffold --update` re-pins an existing Review from its binding. It creates a Review when none exists. A pull-request binding updates from GitHub. A branch binding follows only its local branch or bookmark.

`review rebind <change> --review <uuid>` changes the binding and immediately re-pins the Review.

Publication never moves pins. It warns when pins are behind the binding.

## Artifact publication

The reviewer sees sealed artifact revisions. The two publish commands have independent validation and presentation pointers.

`review publish`:

- compiles `review.mdx` and `data.ts`
- resolves every source range against the pinned worktree
- seals only the document bundle
- updates `presentedDocumentRevision`
- preserves `presentedSoftwareMapRevision`
- sets the Review status to `awaiting-review`

`review map publish`:

- requires a published document
- reads the commits from the presented document revision
- validates the saved base and head map notes for those commits
- seals only the software-map bundle
- updates `presentedSoftwareMapRevision`
- preserves `presentedDocumentRevision` and the Review status
- reuses the existing map revision when its bytes are identical

The document can render without a map. Map absence never blocks document publication. Agent workflows must use the two explicit publish commands.

A failed publish keeps the last good pointer.

## Review states

| Status                   | Owner and next action                                        |
| ------------------------ | ------------------------------------------------------------ |
| `draft`                  | Agent authors and publishes the document.                    |
| `awaiting-review`        | Reviewer reads, asks questions, or submits comments.         |
| `awaiting-agent-updates` | Agent reads threads, corrects the document, and republishes. |

An "Ask now" question does not change the status. "Submit review" with pending comments sets `awaiting-agent-updates`.

Dismissal is separate from Review status. It removes the Review from the active list and stops the waiting agent. The reader can restore it from Home until retention deletes it. Closing the tab does not dismiss the Review. A new document publication clears dismissal and returns the Review to the active list.

After publication, `review wait --requires-agent` resolves for `awaiting-agent-updates`, `review-dismissed`, or `review-deleted`.

## UUID directory

Each Review has one canonical directory:

```text
${DEV_REVIEW_HOME:-~/.dev}/reviews/<uuid>/
├── review.mdx
├── data.ts
├── review.json
├── review.db
├── package.json
├── review-test.mjs
├── .gitignore
├── .bundle/
│   ├── document/
│   └── software-map/
├── .build/<revision>/
└── .git/
```

`review.json` is schema 3 state. It contains the source worktree, binding, pinned commits, status, `presentedDocumentRevision`, and `presentedSoftwareMapRevision`.

`review.db` contains durable comment and question threads. Use only `review threads` to read or change it.

`.bundle/document/` contains the current document candidate. `.bundle/software-map/` contains the current map candidate when one exists. The private Review Git repository seals these candidates as revisions.

`.build/<revision>/` contains a temporary materialization of one sealed revision. Review can create it again.

Do not edit Review infrastructure files or directories directly.

## Threads

Run thread commands in the source worktree:

```sh
review threads list --review <uuid>
review threads reply <threadId> --body <text> --review <uuid>
review threads resolve <threadId> --review <uuid>
```

Do not invent, rewrite, or merge opaque thread targets. Resolve a thread only after its requested document or code change is present.

A document re-publish requires zero open comment threads. Before each re-publish, run `review threads list`. Address every open thread. Mark each addressed thread with `review threads resolve <threadId> --review <uuid>`. Run `review threads list` again. Do not re-publish until no comment thread has `status: "open"`. The first document publication does not use this gate.

## Migration

Run `review migrate apply` only for legacy Review state. It converts supported Reviews to schema 3 and the split bundle layout.

A migrated valid combined revision gets independent document and map pointers. The private history can retain old combined revisions. Active pointers and materialized artifacts use the current layout.

Migration drops stored Reviews whose `data.ts` uses removed `symbol` or `declarationId` peeks. It preserves range-only Reviews. Use `--force` only to restart interrupted development migration state.
