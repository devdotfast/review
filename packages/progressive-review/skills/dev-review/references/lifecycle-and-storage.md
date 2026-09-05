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
- materializes the validated document as schema-checked JSON
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
| `accepted`               | Complete; ordinary publication is forbidden.                 |
| `rejected`               | Closed; ordinary publication is forbidden.                   |

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

`review.json` is schema 5 state. It contains the source worktree, binding, pinned commits, status, `presentedDocumentRevision`, and `presentedSoftwareMapRevision`.

`review.db` contains durable comment and question threads. Use only `review threads` to read or change it.

`.bundle/document/` contains the current document candidate. `.bundle/software-map/` contains the current map candidate when one exists. The private Review Git repository seals these candidates as revisions.

The document candidate is `review-document.json` with format `review-document/1` and a version-2 manifest. Map candidates are `head-map.json` and `base-map.json` with format `software-map/1`. The server serves JSON; the canvas renders built-in components without executing authored JavaScript. Authoring still uses `review.mdx` and `data.ts`; the CLI retains the MDX compiler, TypeScript checks, esbuild, and Node validation runtime until the separate Phase 3 compiler removal.

`.build/<revision>/` contains a temporary materialization of one sealed revision. Review can create it again.

Do not edit Review infrastructure files or directories directly.

## Threads

Run thread commands in the source worktree:

```sh
review threads list --review <uuid>
review threads reply <threadId> --body <text> --review <uuid>
review threads resolve <threadId> --review <uuid>
```

Do not invent, rewrite, or merge opaque thread targets. After making the requested document or code change, reply with a concise disposition and then resolve the thread.

A document re-publish requires zero open comment threads and a completed agent response for every current-round reviewer message. Before each re-publish, run `review threads list`. Address every open thread, reply with `review threads reply`, and mark it with `review threads resolve`. Run `review threads list` again. Do not re-publish until no comment thread has `status: "open"`. The first document publication does not use this gate.

## Migration and repair

Run `review migrate apply` for legacy Review state. It upgrades supported schema-2/3/4 records to schema 5 by converting the exact sealed current document and independently presented map. It never recompiles `review.mdx` or `data.ts`. Accepted and rejected Reviews are included. Valid JSON artifacts retain their pointers; absent maps stay absent. A draft without a presentation only needs its record upgraded.

Conversion failure leaves the Review's record, authoring inputs, candidates, and private refs unchanged and reports a blocker. A failed supported record remains visible in Home with the migration warning and **Open recovery**. Listing and opening recovery are read-only; they do not write schema 5 or execute legacy JavaScript. Diff, Commits, Threads, and valid independent artifacts remain available where their underlying data exists. Invalid or unsupported records remain explicit blockers.

Use `review repair --review <uuid> --json` for explicit recovery of the current presentation. An explicit UUID is required; there is no historical revision selector. Healthy current-schema Reviews return a no-op. Drafts without a presentation are directed to `review publish`.

Repair tries exact sealed conversion first. If that fails, it may compile editable `review.mdx`/`data.ts` with full pinned-range and evidence validation. Reconcile unpublished authoring edits first and preserve what the current Review says: validation is not proof of semantic equivalence. The command reports source fallback and does not overwrite authoring files. Fix only reported inputs, then rerun. A stale map is recovered from its own sealed revision first, or validated saved notes for the same pins; valid independent artifacts are preserved and broken maps are never silently discarded.

Repair requires Review Desktop for mount validation. It stages all required artifacts before promotion, blocks pending agent writes, and rejects concurrent record, pin, or candidate changes. Preparation, validation, mount, or promotion failures retain the old presentation with actionable diagnostics. Missing usable artifacts and authoring inputs remain a blocker.

Successful migration and repair preserve status, pins, title, threads, dismissal, publication timestamps, and old private history. Repair reports old/new artifact revisions and preserved status. It does not submit or resolve feedback, require closed comment threads, re-pin, or reopen accepted/rejected Reviews. Ordinary `review publish` and `review map publish` retain their terminal and feedback gates.

Only current presentation pointers are migrated or repaired. Already-JSON historical revisions remain readable. A pre-data historical revision shows “This older revision is unavailable in this version of Review” and **Open current review**, not a repair command. Old private commits remain immutable and may retain legacy JavaScript.
