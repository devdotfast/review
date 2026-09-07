# review-latency

Measures how long a coding agent takes from the user's prompt ("write me a dev
review of PR #N") to a published Review document being visible in Review
Desktop, and where that time goes.

```sh
cd scripts/review-latency
uv run review-latency list
uv run review-latency run --id review-27          # one run
uv run review-latency run --all                   # every run in runs.toml
uv run review-latency render ~/.dev/review-latency/runs/<run-dir>   # re-render
uv run review-latency dashboards                                        # compare.html + flamegraph.html over all runs
```

Requirements: the packaged Review app installed at `/Applications/dev.fast
Review.app` (each run launches its own isolated instance), `claude` on PATH,
`tsx` on PATH (for `review_cli = "source"`), and the dev-review skill installed
for Claude Code.

## What a run does

1. Launches an isolated Review Desktop for the run: `DEV_REVIEW_HOME` (reviews
   store + `server.json` discovery) under `<run dir>/profile/home`, and
   `DEV_FAST_REVIEW_DESKTOP_STATE_ROOT` (Electron user-data/extensions/logs)
   under `/tmp/review-latency/<run>/state` — short because the user-data dir
   carries a unix socket capped at 103 chars. The agent env carries the same
   `DEV_REVIEW_HOME`, so the run never sees the user's real reviews or app,
   and no pre-cleaning is needed. The desktop is torn down when the run ends.
2. Puts a `review` shim first on PATH that runs the instrumented source CLI
   (`packages/progressive-review/src/cli.ts`, no desktop delegation) and sets
   `DEV_FAST_REVIEW_TRACE_DIR` so every `review` invocation writes a span file.
3. Runs `claude -p "<prompt>" --model <model> --output-format stream-json
   --dangerously-skip-permissions` from the repo root, with the outer Claude /
   Codex session variables stripped from the environment.
4. Copies the Claude transcript (`~/.claude/projects/<cwd-slug>/<session>.jsonl`
   plus `<session>/subagents/*.jsonl`), the CLI trace files, and the resulting
   Review's `review.json`, `review.mdx`, `data.ts`, and revision log into the
   run directory.
5. Builds `timeline.json`, `trace.perfetto.json` (open in ui.perfetto.dev), and
   `report.html` (self-contained gantt + tables).

## Timeline model

- **model** spans: previous transcript record → assistant record (LLM latency,
  with output/thinking/cache token counts).
- **tool** spans: `tool_use` → matching `tool_result`.
- **cli** spans: the `review` CLI's internal span tree, parented under the Bash
  tool call whose window contains the process start.
- **phases** on the main agent: `skill+setup` (prompt → scaffold), `scaffold`,
  `exploration` (scaffold end → first write to `review.mdx`/`data.ts`),
  `authoring` (→ first `review publish`), `publish loop` (→ successful
  publish), `show` (→ `review app pick`).

`summary.time_to_visible_s` is the headline metric. `review wait`, reviewer
feedback, and Ask replies are out of scope.

## Fork runs

`mode = "fork"` requests the review from *inside* the implementation session,
which is how reviews are actually triggered. Per run (`repo`, `pr`, `harness`,
`session`):

1. The raw transcript is located in the harness's native store, else fetched
   from R2 (`by-session/<id>/trace.jsonl`).
2. The cut point is the first review activity: a real user prompt asking for a
   review, or the agent invoking the dev-review skill / running the review
   CLI. Everything from there on is dropped (`cut = <index>` overrides).
   Sessions with no review activity are kept whole and the prompt is appended.
3. A git worktree is created on branch `review-latency/<id>` at the
   *representative commit* — the checkout state at the cut: the latest commit
   carrying the session's `Agent-Session` trailer committed before the cut,
   else the latest PR-branch commit before the cut, else the PR head. The
   session's `cwd` is rewritten to the worktree. The summary's `realism`
   block records whether the commit the agent ended up reviewing is the
   worktree head or in its history; "UNRELATED" means the run is not
   representative.
4. The session is forked under a new id (Claude: transcript copy in the
   worktree's project dir; Codex: rollout copy) and resumed non-interactively
   with the review prompt (`claude -p --resume`, `codex exec resume --json`).
   pi is not wired yet.
5. The manifest records the fork (source session, cut index/reason, worktree,
   head commit) and the surface fingerprint (skill/docs/authoring-type/CLI-help
   hashes, package version, source commit) so runs can be compared across
   skill or CLI changes.

For Codex runs the timeline's tool spans come from rollout rows appended after
launch, and model timing from receipt-stamped `codex exec --json` items
(reasoning item wall time = thinking; no message_start, so TTFT is measured to
the first item of the model's output).

## Update runs

Not implemented yet. Design: for a run with `mode = "update"`, the harness
creates a local branch at the PR head's parent, has the agent author a Review
for that branch, fast-forwards the branch to the PR head, then prompts "the
branch has new commits; update the review". Both the create and the update
halves are measured. Unblocks once the create-mode numbers look right.
