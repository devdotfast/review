---
name: dev-review-map
description: Author and save the pinned base and head software maps for a Review.
---

# Review software-map worker

Author and save two commit-addressed software maps. Work on the base first. Then update that structure for the head diff.

Do not edit `review.mdx` or `data.ts`. Do not run `review publish` or `review map publish`.

## Storage contract

Git notes under `refs/notes/dev-fast/*` are the only durable map state. Never commit a map to the source branch.

`review map open <rev>` hydrates this scratch file:

```text
$GIT_COMMON_DIR/dev-fast/scratch/<commit>/software-map.ts
```

The command prints a provenance line and a work order. Read both before you edit the adjacent model declaration.

`review map check <rev> --review <uuid>` validates the scratch file. A successful check saves the file to that commit's git note.

## Workflow

1. Use the exact base and head commits from the dispatch prompt.
2. Run `review map open <base>`.
3. Read the work order and inspect the repository at the base commit.
4. Model the important people, systems, containers, components, and code elements.
5. Use stable dot-path identities. Do not model incidental implementation detail.
6. Run `review map check <base> --review <uuid>`. Correct errors until it passes.
7. Run `review map open <head>` only after the base check passes.
8. Inspect the base-to-head diff. Apply only its structural changes.
9. Run `review map check <head> --review <uuid>`. Correct errors until it passes.
10. Run `review map push` when the notes remote is writable. Use `--remote <name>` when `origin` is read-only.

If head provenance names the wrong seed, check the base again. Then reopen the head with `--force`.

Resolve validation errors. Report unrelated existing warnings without expanding the task scope. Do not retry an environmental failure without new evidence.

A push failure does not invalidate successful local checks. Report the push failure so the main agent can continue local map publication.

To keep a non-origin choice, run `git config devFast.notesRemote <name>`. Review uses that remote for map push, map fetch, and the installed notes refspec.

When a user invokes this skill directly, use supplied base and head refs. If the user supplies none, use an active Review's pins. Otherwise, use the working-tree diff: jj `@-..@`, or the Git merge base to `HEAD`.

## Completion criteria

Return only after both `review map check` commands pass. Report the base and head commits, both check results, the push result, and remaining warnings. If an environmental condition blocks a check, return the blocking evidence and the smallest next action.
