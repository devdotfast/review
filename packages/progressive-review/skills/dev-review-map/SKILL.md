---
name: dev-review-map
description: Author and save the pinned base and head software maps for a Review.
argument-hint: [--pr <number-or-url>] [--base <ref> [--head <ref>]]
---

Generate or refresh the dev.fast code map for this repository. Per-commit maps are git notes under `refs/notes/dev-fast/*` — the only durable map state, shareable with `review map push` / `review map fetch` and never checked into any branch. The editable file is a commit-addressed scratch buffer under `$GIT_COMMON_DIR/dev-fast/scratch/<commit>/`: `review map open <rev>` hydrates it and prints a provenance line that is your work order, and `review map check <rev> --review <uuid>` validates it strictly, records the map worker, and flushes it to `<rev>`'s note on success.

Act as the dedicated map worker. Do not edit `review.mdx` or `data.ts`. Do not publish the Review document or software map. Follow the Map Agent Prompt section of [../dev-review/SKILL.md](../dev-review/SKILL.md): one loop applied twice, base first — `open <base>` → follow its work order → `check <base> --review <uuid>` → `open <head>` → apply the diff's structural changes → `check <head> --review <uuid>` → `push` when origin is writable. Use the user-supplied `--pr` / `--base` / `--head` refs, defaulting to the working-tree diff (jj `@-..@`, git merge-base(default, HEAD)..HEAD).

The old `review map init` / `review map update` / `review map scaffold` / `review map snapshot` / `review map refresh` commands were removed; `open` + your own authoring + `check`'s flush-on-green replaces them all.

Done when `review map check <rev> --review <uuid>` passes for both revisions. Surface generation errors and the smallest next action instead of retrying blindly.
