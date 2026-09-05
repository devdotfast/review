---
name: dev-review
description: Answer product questions about Review Desktop, or author and publish a progressive Review for a branch, jj change, or pull request. Use for Review capabilities, setup, CLI, privacy, telemetry, troubleshooting, and code-change or architecture reviews.
---

# dev.fast Review

Author a short Review document while a dedicated sub-agent authors the software map. Publish each artifact through its own command.

The Review has two independent artifacts:

- `review.mdx` explains the change with exact source ranges and focused visuals.
- The software map describes the repository structure at the base and head commits.

Document publication must not wait for map authoring.

## Product questions

When the user asks what Review Desktop can do or how to install, use, configure, or troubleshoot it, read the bundled [Review documentation](docs/README.md). Read only the index and the pages relevant to the question. When the bundled index is unavailable because this skill is loaded directly from a source checkout, use the [source documentation](../../../../docs/README.md) instead.

Answer the question without launching Review Desktop, scaffolding a Review, or publishing. Enter the authoring workflow only when the user also asks you to create, update, or open a Review.

## Before authoring

Read these Review guidance files when they exist, in this order:

1. `$DEV_REVIEW_HOME/DEV-REVIEW.md` for user-level guidance. Use `~/.dev/DEV-REVIEW.md` when `DEV_REVIEW_HOME` is not set.
2. `DEV-REVIEW.md` at the source repository root for repository guidance.

Follow the review rules and domain language in both files. The repository guidance takes precedence when the files conflict.

Read [Document authoring](references/document-authoring.md) for writing rules and document structure.

Read [Component API](references/component-api.md) before you write `data.ts`. It defines every component's props and every helper's input shape.

Read [Trace quoting](references/trace-quoting.md) when the scaffold event reports a non-empty `traces.paths` array, or when the compatibility fallback below reports an available session.

Read [Lifecycle and storage](references/lifecycle-and-storage.md) when you must select or update the binding. It also defines publication, state, migration, and thread behavior.

Read [Prepared worktrees](references/prepared-worktrees.md) only when pinned worktree dependencies or language-server navigation do not work.

## In-app Ask replies

When the prompt starts with `dev-review-thread-id: <id>`, answer that Review thread. Run `review threads get <id>` from the source worktree. Treat its target and complete message list as the canonical context. Read the Review document or repository files only when the question requires them.

Do not modify files. Do not publish, resolve, or reply through the CLI. Review Desktop stores your returned text in the same thread. Return only the answer to the user message that follows the header.

## Workflow

### 1. Resolve the Review

Run `review app launch --json` to start Review Desktop. Then run `review info --json` in the source worktree. It lists active Reviews bound to that worktree and reports `matchesCheckout` for each one. Use an existing Review when it matches the requested change. If none matches, run `review scaffold --json` to create one. When the user asks for a fresh Review, pass `--new`; the explicit request overrides reuse.

Pass resolved commit ids to `--base` and `--head`. Parent suffixes like `<rev>^` do not resolve in a jj workspace; resolve the parent first with `jj log -r '<rev>-'`.

If scaffold warns that `devfast.prepare` is not configured, set up that command according to [Prepared worktrees](references/prepared-worktrees.md).

Read the scaffold JSON event and `review info --json`. Together they carry these values; record them. Do not treat the compatibility `review.json` mirror as authoritative:

- Review UUID and directory
- source worktree
- `baseCommit` and `sourceCommit` (the scaffold event prints them under `pins`)
- both pinned checkout paths (the scaffold event prints them under `checkouts`)
- materialized agent trace paths (the scaffold event prints them under `traces.paths`)
- source binding and status

`inSync: false` in `review info` means only that the source worktree does not sit on the pinned commit. That alone requires no action. Use `review scaffold --update --review <uuid>` only when the bound branch or pull request gained commits past the pin. Re-read each file whose anchored range changed after the update.

### 2. Show small changes immediately

Measure the change from the source worktree: `git diff --shortstat <baseCommit> <sourceCommit>`. When insertions plus deletions total under 300, publish the untouched scaffolded stub at once and land the reader on the diff:

```sh
review publish --review <uuid> --view diff --json
```

Then write a short document (a few sentences with `AnchorLink`s; no diagrams unless one claim needs one), publish again, and continue with the normal steps. Larger changes skip this step.

### 3. Dispatch the map worker

Use the current harness sub-agent facility. Dispatch one worker after Review resolution provides the UUID and pinned commits. The worker must follow the dev-review-map skill.

Give the worker this prompt with resolved values. Prepend any environment setup the worker needs to run the `review` CLI (for example, a PATH prefix). When the harness has no dev-review-map skill registered, or you are not sure the worker can resolve it, give the worker the path to the skill file instead:

```text
Use the dev-review-map skill in <source-worktree>.

Review UUID: <uuid>
Review directory: <review-dir>
Base commit: <baseCommit>
Head commit: <sourceCommit>

Author and save both software maps.
Do not edit review.mdx or data.ts.
Do not publish the Review document or software map.
Return only after both `review map check <rev> --review <uuid>` commands pass.
```

The worker owns only map scratch files and git notes. The main agent owns `review.mdx`, `data.ts`, both publish commands, and reviewer feedback.

Continue document work while the worker runs. Do not author the map in the main-agent context.

If no sub-agent facility exists, publish the document. Report that the map is not published. Do not silently author it in the main-agent context.

### 4. Author the document

Read [Document authoring](references/document-authoring.md) before authoring the document. All document and comment reads and edits must go through the Review API; do not read or write `review.mdx`, `data.ts`, or comment databases directly. Register `review mcp` with your MCP client if its tools are not available.

For rich MDX, use `review_get_document_file` and `review_write_document_file` with
`name: "review.mdx"` or `name: "data.ts"`. Pass the returned `sourceHash` as
`expectedSourceHash`; null creates a missing input. Keep built-in components and
imports intact. Write each input through the API, then publish to compile and
present the complete document.

For incremental documents, use `review_get_document` and
the revision-checked `review_replace_document`, `review_insert_node`,
`review_update_node`, `review_delete_node`, and `review_move_node` tools. Keep
the returned revision for the next mutation. Converting a compiled Review
requires the exact `sourceHash` returned by `review_get_document`. Never edit an
incremental `review.mdx` directly.

Use the materialized files in `traces.paths` from the scaffold event. When that array is non-empty, read [Trace quoting](references/trace-quoting.md) and complete its intent pass before authoring. Use FFF for candidate discovery.

Use the smallest document that explains the important change. Default to `AnchorLink` for source evidence, and use this to hyperlink any text in the review that refers to a specific piece of code. Use `CodePeek` only when readers must see the code inline to understand the main claim.

Read every referenced range from the correct pinned checkout before you add it. Use the `checkouts` paths from the scaffold event: the head checkout for a head range, the base checkout for a base range.

### 5. Publish the document

Run:

```sh
review publish --review <uuid> --json
```

Both `review publish` and `review app pick` accept `--view <review|commits|diff|map|trace>` to choose the tab the reader lands on. Without `--view`, the Review tab remains the default.

Read each NDJSON error event. Correct all document errors and publish again. A missing software map is not a document error.

A successful document publish updates `presentedDocumentRevision`. It preserves `presentedSoftwareMapRevision` and sets the status to `awaiting-review`.

Show the published document immediately:

```sh
review app pick --review <uuid> --json
```

### 6. Publish the map

Join the map worker after document publication. If the Review became terminal, report the valid unpublished-map state and do not retry.

A worker that finishes early changes nothing. Publish the map only after the document publish. A failed or skipped `review map push` to origin does not gate publication. Only the two checks gate publication.

If both checks passed, run:

```sh
review map publish --review <uuid> --json
```

This command updates only `presentedSoftwareMapRevision`. It preserves the document pointer and Review status.

If the worker fails, keep the valid document publication. Report the map failure and the smallest next action.

### 7. Handle feedback

Wait for a status that requires agent action. Use the command for the current harness:

```sh
review wait --requires-agent --review <uuid>
review wait --requires-agent --codex --review <uuid>
```

Use only one wait command.

- For `awaiting-agent-updates`, read the threads with `review threads list`. Address every open thread. Mark each addressed thread with `review threads resolve <threadId> --review <uuid>`. A document re-publish requires zero open comment threads. Update moved pins with `review scaffold --update` when required. If pins move, dispatch a new map worker with the new pins. Publish the document without waiting for the new map. Then publish the new map after both checks pass.
- For `review-dismissed` or `review-deleted`, stop the loop.
- While the status is `awaiting-review`, the reviewer owns the next action.

Read and change threads only through `review threads`. Do not edit `review.db`.

## Architecture reviews

A Review can explain a codebase as it stands:

1. Pin the same commit as base and head: `review scaffold --base <ref> --head <ref>` with one ref (`@` in jj, `HEAD` in git).
2. Choose sections that describe the system (data flows, state, storage, and module boundaries). Omit diff-specific sections (interface changes, test claims, decision logs).
3. Use diagrams and code peeks instead of raw prose. Scope the review to one subsystem.

All other steps (map worker, publish, wait loop) remain identical.

## Completion criteria

Complete the authoring turn only when all applicable conditions are true:

- Review Desktop shows the published document.
- The map is published, or you reported why it is not published.
- All document diagnostics are resolved.
- Both map checks passed before map publication.
- The Review is waiting on the reviewer, the reader dismissed it, or the Review was deleted.
