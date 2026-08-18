# Review workflow

A Review lives in one canonical UUID directory under
`${DEV_REVIEW_HOME:-~/.dev}/reviews/<uuid>/`. Its `review.mdx` and `data.ts`
are edited with normal file tools. Read and mutate comment threads only through
`review threads`. The `.build/` directory is disposable publish output.

1. Run `review app launch --json`.
2. Run `review info --json` in the source checkout. It lists active Reviews
   bound to that worktree and reports `matchesCheckout` for each one. If no
   Review matches the requested change, run `review scaffold --json`.
3. Read the JSONL event for the UUID directory, source binding, sync state,
   and unresolved threads.
4. Edit `review.mdx` and `data.ts` in that directory. Keep the H1 and write
   short, evidence-backed prose. Link each code claim to an anchored source
   range. Read that exact range from the pinned worktree before you write it.
5. For any code evidence, `softwareMap` frontmatter must pin the persisted
   review commits from `review.json` (`baseCommit` and `sourceCommit`), never a
   moving branch such as `HEAD` or `origin/main`.
6. Run `npm test` in the UUID directory. It validates TypeScript and MDX
   without launching a renderer.
7. Run `review publish` (agents: `review publish --json` — every `review`
   command accepts `--json`, and it keeps stdout to JSON events only). It is the only
   promotion gate, and it runs entirely in the CLI: compilation, the
   software-map check, and resolution of every source range against the pinned
   worktree. A validation failure preserves the last good revision.
   On success the CLI seals the revision and Review Desktop mounts it.
8. Run `review app pick --review <uuid> --json` to select the published Review.
9. Run `review threads list` for open comment threads and questions. Make the
   relevant change, and publish again. Resolve a comment with `review threads
resolve <threadId>` only after its exact target is addressed. Question
   records remain `running`, `answered`, or `error`.

`review info` is read-only discovery. It lists active Reviews bound to the
current worktree, or all worktrees in the repository with `review info --all`.
The `matchesCheckout` field reports whether the checkout equals or descends
from each Review change. A new Review is `draft`; publishing
sets it to `awaiting-review`. The
reviewer submits **Approve** (`accepted`) or **Request changes**
(`awaiting-agent-updates`), with or without comments. Dismissal sets
`rejected`; `accepted` and `rejected` cannot be published again.

Use `SequenceDiagram` for temporal behavior and `DatabaseLens` only for
meaningful persistence changes. Inline software-map blocks are disabled, but
pinned `softwareMap` frontmatter remains required for map-backed evidence.

Do not use code mode, `review start`, or blocking session workflows.
