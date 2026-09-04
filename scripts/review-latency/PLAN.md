# Review authoring latency — fix list

Metric: wall clock from the user's review request to the published document
visible in Review Desktop. Baseline: 16 valid runs (Aug 29 – Sep 3, 2026),
median 299s, range 122–659s. Dashboards in `~/.dev/review-latency/runs/`:
`compare.html`, `flamegraph.html`, `cycle-anatomy.html`, `review-levers.html`,
`review-latency-dag.html`.

Ordered by seconds unlocked per run, deduplicated along dependencies. We work
this list back to front (7 → 1): the items at the bottom have no
prerequisites and make the items above them measurable or cheaper.

| # | item | owner | s / run | prereqs | unlocks | status |
|---|------|-------|---------|---------|---------|--------|
| 1 | Anchor / peek range resolver: one CLI call, patterns → exact base+head line ranges | CLI | 75–150 | — | #3 payout, #5; fewer failed first publishes | todo |
| 2 | Trace pipeline: local-first loads (no R2 HEAD per `trace show`; `--refresh` to force), `trace show --event a,b,c`, native SigV4 R2 client replacing every `aws` spawn (HEAD 170ms / GET 316ms / LIST 206ms live), scaffold pull fanned out 6-wide | CLI | 50–90 (+0–20 scaffold) | — | #3 payout | implemented 2026-09-03 night; measuring overnight |
| 3 | Skill v2: one-shot preamble (1–2 turns), one canonical exemplar, pre-digested PR summary in `review info`, use #1/#2 | skill + CLI | 50–75 | preamble/exemplar standalone; primitives half needs #1, #2 | #5 | todo (user reading skill) |
| 4 | Incremental rendering | product | 20–55 (hides authoring) | — | #5 | in flight, other worktree |
| 5 | Skill v3: write as you go, outline first | skill | 45–110 overlapped | #1, #3, #4 | authoring subagent | todo |
| 6 | Publish: settle timer removed; code peeks resolved at publish and embedded in the bundle. Measured on review#83: mount 7.62s → 4.05s → **0.20s**, `/publish-ready` 4.74s → 0.81s, publish loop 8s → 4s | desktop + CLI | 4–7 per publish | — | — | **done** (needs commit) |
| 7 | Benchmark with repeats: ≥3 runs per PR per config, compare medians | harness | — | — | trusting #1–6 | harness done (`run --repeat N`, medians table in compare.html); baseline repeats running |

Also: harness realism for dev-monorepo runs (pre-start the dev server the
repo's DEV-REVIEW.md asks for), not a product lever.

## Ownership (agreed 2026-09-03)

1. **Skill (user).** Stop the repeat read → load skill → read chain by
   deterministically handing the agent what it always fetches; replace the
   "think a lot" language (cost without benefit); tell the agent to use the
   code points it already knows — on a warm review (resuming the session that
   wrote the change) there is little to explore. Evidence from the harness:
   the three reference files are read every run; orientation is three
   separate turns (`review app launch`, `review info`, `gh pr view`) plus git
   archaeology; pinning is ~9 turns that a single search script could do in
   1–2 (est. 151s → 40–60s on review#83).
2. **Traces + CLI primitives (Claude).** No remote HEAD for pinned reviews;
   digest-default `trace show` with `--event a,b,c`; native batched R2 client;
   `review info --digest` if the skill wants it.
3. **App-side slowness (Claude gathers evidence, decide together).** Publish
   mount is now `import document` time only (1.7s / 3.9s) — needs a CPU
   profile of the module evaluation; plus anything else the runs show.

## #6 design: resolve code peeks at publish, embed in the bundle (agreed)

Today the published bundle ends in `await __reviewDefinitionsReady()`; in the
browser that waits for one `POST /code-peek/resolve` per peek (8 concurrent),
each of which re-resolves the worktrees and spawns `git diff` — 21 peeks ≈
3.9s of the mount. Publish's `evaluate` step already resolves every peek
against the same pinned worktrees.

1. Move `resolveCodePeekDiff` (+ helpers) out of `server/review-api.ts` into a
   shared module; extend `ReviewPublishEvidenceTargets` with the diff refs
   (`baseRef`, `headRef`, `diffRootPath`) from `resolveReviewSourceTarget`.
2. `evaluateReviewDocumentBundleForPublish`: for each peek also compute the
   diff summary and collect `codePeeks[graph|file|from|to] = {snapshot, diff}`;
   return it in `ReviewPublishEvaluationResult`.
3. `embedCodePeeks(bundle, codePeeks)`: prepend
   `globalThis.__reviewEmbeddedCodePeeks = {"<routePath>": {...}};` to the
   bundle code, recompute `contentHash`; called in
   `prepareReviewDocumentBundle` after evaluation, before
   `writeReviewDocumentBundle`.
4. `createBrowserReviewDefinitionSession` (app runtime): if the global carries
   this route's map, `resolveCodePeek` is a lookup (missing key = error, the
   bundle is immutable); no map = pre-change bundle, keep the fetch path.
5. Rebuild: `pnpm run build` + `app:desktop:build` in progressive-review, then
   `app:build` for the desktop; measure with review-8-cold / review-83-fork.

Expected: mount ≈ first commit only (well under 1s); publish desktop half
4–8s → <1s.

## Experiment design (from 2026-09-03 night)

- **Traces on/off** is a first-class axis: `review-latency run --traces both`
  runs each spec with trace storage present and absent. Off =
  `DEV_FAST_REVIEW_TRACES=off` in the agent env, which the CLI honors end to
  end (no R2, no local corpus, no local transcripts, `review info` lists no
  sessions). Off variants carry the id suffix `-notrace`.
- **Per-run trace corpus**: every run gets `REVIEW_TEST_TRACE_SEARCH_DIR`
  under its profile, so "traces on" always pulls fresh instead of reusing what
  earlier runs cached.
- **Fork prompt** is "review of this branch": the worktree sits at the
  session's cut state, and reviewing "PR #N" made the agent explore commits
  that landed after the cut (review#83: 15 PR commits vs 7 in context).

## Skill audit (2026-09-03) — two buckets

Findings from warm, traces-off smoke runs of the user's skill edits (review#83:
236s / 340s / 289s / 389s): the "no exploration when in context" guidance
holds; the batch-search line did not change the read → decide → next loop
(9–10 sequential pinning calls, 61–96s model time); two runs spent ~150s
running typecheck/tests in the worktree to produce "testing evidence".

### Bucket 1 — non-trace (skill text, user) — IN PROGRESS

1. One anchor procedure in one place: replace `document-authoring.md:69`
   ("Read from the correct pinned checkout before you add it") and the
   duplicate batch line at `:76` with: list anchors from what you know → one
   script resolving all at head/base → set every range. `SKILL.md:100–110`
   points at it, no second copy.
2. Step 1 of `SKILL.md:102–103` ("Load the change into your context window …
   code mode + parallel subagents") becomes conditional: skip when the
   implementation is already in context. Drop "parallel subagents" from the
   search path (each launch is a ~17s turn).
3. Forbid manufacturing test evidence: never run typecheck/tests to produce
   evidence; cite tests only when the diff touches them. Remove or condition
   `- testing evidence` (`document-authoring.md:43`); widen `:163` beyond the
   private Review dir.
4. Reconcile "smallest document" (`SKILL.md:96`, `document-authoring.md:26,
   31`) with diagrams-first (`:13–18`) and one-anchor-per-frame
   (`component-api.md:41, 120`): pinning volume = diagram frame count.
5. Deduplicate: AnchorLink/CodePeek guidance (`SKILL.md:97–98` vs
   `document-authoring.md:74`); "read Document authoring" (`SKILL.md:27` vs
   `:92`).
6. `SKILL.md:94` "Use FFF for candidate discovery" — FFF indexes transcripts,
   not source; keep only in the trace reference.

### Bucket 2 — trace-related — PARKED, return after bucket 1

1. Gate the intent pass on context (`SKILL.md:94`, `trace-quoting.md:13–31`):
   full survey for cold reviews only; a warm review must not re-survey its own
   session. (skill)
2. Quote-from-memory contradiction: `document-authoring.md:22` allows quoting
   from context, `trace-quoting.md:64–75` requires `trace_quote_props` from
   `review trace show --event`. Fix: a CLI call returning event props for a
   quoted text, so citing from memory is one call. (CLI, Claude)
3. `trace-quoting.md:56–60`: document `--event 43,62,70`; agents still use
   shell loops. (skill)
4. Density rules vs "smallest": `trace-quoting.md:80–83` ("one quote per
   bullet", "decision log: the full replay") is the strongest expansion
   pressure in the skill. (skill)
5. Scaffold trace pull off the critical path: traces-on scaffold is 15–17s vs
   2.5s off with the fresh per-run corpus, all R2 download. Async/lazy. (CLI,
   Claude)

Measured context for bucket 2: traces on vs off, medians of 2 — review#83
553s vs 288s, review#24 315s vs 219s, review#8 210s vs 183s.

## Regression suite

Four PRs, all on the dev desktop (`desktop = "dev"` default): `review-8-cold`
(small, Claude), `review-83-fork` (large refactor, Claude), `review-24-fork`
(small, Codex), `dev-898-fork` (dev monorepo, Codex). Target ≥3 runs each;
judge a fix on the change in medians.

## Evidence per item

1. **Pinning.** review#83: 9 turns emitting `H=<head>; grep -n …; sed -n …`
   = 151s of 298s exploration; review#8: 91s of 164s. Each turn: 0.5–3k output
   tokens and up to 30s of thinking for a grep that runs in 0.1s; the same
   file is pinned separately at base and head. 3 of 16 runs published twice;
   the clearest failure was a bad `peek` range caught at mount.
2. **Traces.** Same trace dumped 6× through different `head`/`sed` windows,
   then one `review trace show --event N` process per event, each with its own
   `aws s3api` round-trip (two 4-event loops: 11.3s and 7.4s). 72s on #83, 42s
   on #8. Scaffold's trace pull is serial `aws` calls: 0–20s.
3. **Preamble + context.** skill+setup averages 50s/run, 34s of it model
   round-trips across ~6 sequential reference reads (tool time 0.1s each).
   Codex dev#898: ~30s reading other reviews' `data.ts` as format exemplars,
   ~12s dead-end `rg`; review#24: 13 diff-shape discovery turns (25s).
4. **Authoring.** Pure generation at ~100 tok/s for 2–7k tokens: 20–55s.
5. **Planning block.** One large silent turn before writing in every run
   (45s Claude, 111s Codex dev#898); redacted content; consistent placement.
6. **Publish.** Mount = `document module load` (1.6s for a 7KB doc, 5.2s for
   18KB) + `mountValidationSettleMs = 2_000`. Assets, session and map fetches
   ≈ 0. Code-peek evaluation is concurrent (all peeks in <0.6s) — not a lever.
   Compile + evaluate 2–4s. The packaged app's 15.9s mount on #83 did not
   reproduce on the dev desktop (7.6s).
7. **Variance.** review#83 forked from the same cut: 509s (Sep 2) vs 659s
   (Sep 3); exploration 298→427s, authoring 81→131s, publish 20.9→11.0s.
   review#24 (Codex): 159s (Sep 1) vs 1568s (Sep 3) with the *same* turn
   count (52 vs 53) — per-turn model latency went from ~2s to ~28s, i.e.
   provider-side. Baseline repeats (Sep 3, PATH fix in): review#24 278s /
   259s; dev#898 300s / 881s (earlier 539s). Medians across days, not single
   runs.

## Harness notes

- Codex executes tools via `zsh -lc`; the login shell reset PATH and bypassed
  the review shim (journal empty → no stop-at-publish). Fixed with a
  harness-owned `ZDOTDIR` that re-prepends the shim (2026-09-03).
- Desktop-side edits need `REVIEW_DESKTOP_DEV_FAST=1 pnpm --filter
  @dev-fast/review-desktop app:build` (renderer; a bare `npm run compile`
  leaves `out/vs/review/common/reviewProtocol.js` importing `zod/v4` and the
  window fails to start) and `pnpm run build` in `packages/progressive-review`
  (server) before a `desktop = "dev"` run sees them.

## Not levers (checked)

`git worktree add` (0.8–1.3s ×2 per scaffold), `git fetch` (~1s), code-peek
evaluation (concurrent), map subagent (79–185s concurrent, never on the
critical path), CLI startup beyond what fewer calls already removes (~0.5–0.9s
per launch under tsx; ~16 launches/run).

## Hygiene noticed

`/Volumes/workspace/src/review/.git` is 79GB; pinned review checkouts live
under `.git/dev-fast/reviews/<uuid>/` and appear to accumulate.

## Overnight results (2026-09-03 night → 09-04 morning)

Runs at/after `20260903T0445` ran with #2 (trace changes) + #6 (publish) + the new skill; earlier runs are the baseline (the last few of those already had #6 and the skill). Medians per run id.

| run id | n before → after | time to visible | exploration | trace-show calls | R2 time in CLI | CLI processes | CLI time | turns |
|---|---|---|---|---|---|---|---|---|
| dev-898-fork | 3 → 1 | 539s → **651s** | 257s → **85s** | 0.0 → **0.0** | 6.5s → **3.5s** | 22 → **10** | 77s → **20s** | 78 → **101** |
| dev-898-fork-notrace | 0 → 1 | — → **199s** | — → **146s** | — → **0.0** | — → **0.0s** | — → **18** | — → **19s** | — → **62** |
| review-24-fork | 4 → 2 | 269s → **315s** | 207s → **243s** | 14 → **20** | 19s → **40s** | 28 → **34** | 43s → **38s** | 54 → **70** |
| review-24-fork-notrace | 0 → 2 | — → **219s** | — → **174s** | — → **0.0** | — → **0.0s** | — → **14** | — → **13s** | — → **52** |
| review-8-cold | 7 → 2 | 227s → **210s** | 163s → **138s** | 6.0 → **6.5** | 15s → **9.6s** | 27 → **22** | 41s → **29s** | 20 → **20** |
| review-8-cold-notrace | 0 → 2 | — → **183s** | — → **125s** | — → **0.0** | — → **0.0s** | — → **16** | — → **18s** | — → **16** |
| review-83-fork | 5 → 2 | 481s → **553s** | 323s → **374s** | 7.0 → **5.5** | 27s → **16s** | 36 → **27** | 59s → **29s** | 29 → **36** |
| review-83-fork-notrace | 0 → 2 | — → **288s** | — → **175s** | — → **0.0** | — → **0.0s** | — → **15** | — → **16s** | — → **18** |

### Traces on vs off (tonight's runs only, medians)

| run id | traces on: n, time to visible, exploration | traces off: n, time to visible, exploration |
|---|---|---|
| dev-898-fork | 1, 651s, 85s | 1, 199s, 146s |
| review-24-fork | 2, 315s, 243s | 2, 219s, 174s |
| review-8-cold | 2, 210s, 138s | 2, 183s, 125s |
| review-83-fork | 2, 553s, 374s | 2, 288s, 175s |

Fork runs tonight use the branch prompt (review target = session cut state); earlier fork runs reviewed the PR head, so their exploration numbers are not like-for-like.


Per-run detail (after):

- `20260903T044605Z-review-8-cold`: 240s — skill+setup 38s, scaffold 6.1s, exploration 163s, authoring 27s, publish loop 3.1s, show 3.1s; trace-show calls 6, R2 8.0s, CLI procs 22
- `20260903T045025Z-review-8-cold-notrace`: 196s — skill+setup 32s, scaffold 2.5s, exploration 135s, authoring 21s, publish loop 2.4s, show 3.5s; trace-show calls 0, R2 0.0s, CLI procs 16
- `20260903T045403Z-review-8-cold`: 180s — skill+setup 21s, scaffold 8.8s, exploration 113s, authoring 31s, publish loop 2.8s, show 3.1s; trace-show calls 7, R2 11s, CLI procs 23
- `20260903T045722Z-review-8-cold-notrace`: 169s — skill+setup 24s, scaffold 2.3s, exploration 116s, authoring 20s, publish loop 2.7s, show 3.7s; trace-show calls 0, R2 0.0s, CLI procs 15
- `20260903T050032Z-review-83-fork`: 739s — skill+setup 82s, scaffold 7.7s, exploration 545s, authoring 102s, publish loop 2.9s, show 0.0s; trace-show calls 6, R2 15s, CLI procs 28
- `20260903T051314Z-review-83-fork-notrace`: 340s — skill+setup 55s, scaffold 2.1s, exploration 220s, authoring 56s, publish loop 2.6s, show 4.1s; trace-show calls 0, R2 0.0s, CLI procs 15
- `20260903T051916Z-review-83-fork`: 367s — skill+setup 86s, scaffold 7.3s, exploration 203s, authoring 64s, publish loop 2.8s, show 4.3s; trace-show calls 5, R2 16s, CLI procs 26
- `20260903T052542Z-review-83-fork-notrace`: 236s — skill+setup 50s, scaffold 2.1s, exploration 131s, authoring 47s, publish loop 2.6s, show 3.5s; trace-show calls 0, R2 0.0s, CLI procs 15
- `20260903T052955Z-review-24-fork`: 309s — skill+setup 40s, scaffold 17s, exploration 237s, authoring 4.7s, publish loop 2.4s, show 8.0s; trace-show calls 17, R2 41s, CLI procs 30
- `20260903T053521Z-review-24-fork-notrace`: 210s — skill+setup 31s, scaffold 2.5s, exploration 163s, authoring 4.6s, publish loop 2.2s, show 7.2s; trace-show calls 0, R2 0.0s, CLI procs 13
- `20260903T053906Z-review-24-fork`: 322s — skill+setup 43s, scaffold 15s, exploration 250s, authoring 3.7s, publish loop 2.3s, show 7.3s; trace-show calls 24, R2 40s, CLI procs 38
- `20260903T054444Z-review-24-fork-notrace`: 229s — skill+setup 27s, scaffold 2.5s, exploration 186s, authoring 4.1s, publish loop 2.3s, show 6.3s; trace-show calls 0, R2 0.0s, CLI procs 14
- `20260903T060251Z-dev-898-fork-notrace`: 199s — skill+setup 41s, scaffold 3.1s, exploration 146s, authoring 6.7s, publish loop 2.2s, show 0.0s; trace-show calls 0, R2 0.0s, CLI procs 18
- `20260903T061425Z-dev-898-fork`: 651s — skill+setup 164s, scaffold 8.1s, exploration 85s, authoring 6.8s, publish loop 387s, show 0.0s; trace-show calls 0, R2 3.5s, CLI procs 10

## Harness realism notes (2026-09-03 evening)

- Fork worktrees share the repo's stash stack. A "perf WIP (stashed by agent-server refactor)" entry, created by the review#83 session itself, cost one warm run 20s of "important finding" detours. Dropped; keep the stash stack empty during experiments.
- The `review` shim broke whenever the agent's shell cwd was inside the fork worktree's `packages/progressive-review`: tsx reads tsconfig from the cwd, and the worktree's `paths` remapped `@dev.fast/local-vcs` onto the worktree's older source (no `setLocalVcsCommandObserver`). The agent then routed around the shim with the worktree's own `cli.ts`, silently changing the CLI under test (16:21 and 17:50 runs). Fixed: the shim pins `--tsconfig` to the instrumented checkout, and the runner aborts on any CLI load failure (`review-shim-stderr.log`).
- Rule placement matters more than wording: the typecheck/test reflex fires at call ~4, before any `references/*.md` is opened. Rules about what not to do before authoring belong in SKILL.md (loaded at invocation); `document-authoring.md` is only in context once the agent is about to write.

## code-search skill + effort experiments (2026-09-04, review-83-fork, traces off, warm)

All runs same night, same prefix, `code-search` skill installed (except the 00:57 baseline).

| variant | totals (s) | thinking tokens | thinking s | doc (KB / anchors / diagrams) |
|---|---|---|---|---|
| opus @ high, before code-search | 252 | 8.1k | 89 | 10.5 / 20 / 2 |
| opus @ high, with code-search | 319, 325, 336, 367 | 12.3k–15.9k | 145–193 | 11–13 / 18–22 / 1–2 |
| opus @ medium | 347, 412, 351 | 14.3k–16.5k | 172–199 | 11.5–13.9 / 21–26 / 1–2 |
| opus @ low | 270, 263, 309 | 9.0k–12.4k | 107–150 | 10.6–13.5 / 15–26 / 1–2 |

- code-search skill: every run loaded it unprompted, used `#name` and `inside:` rules, ran zero sed/cat after the scan, ran no tests. The scan→Write window did not shrink (95–120s either way): removing tool calls moved the thinking, it did not remove it. Wall-clock unchanged (median 330 vs 312).
- Pre-scan reads (3–4 `cat` calls of the files the session wrote) survive every wording tried; stop editing text for that.
- `--effort medium` produced the same thinking-token volume as high. `--effort low` cut thinking tokens ~30% and wall-clock ~60s (median 270 vs 330) with document shape unchanged. Effort is the first knob that moved time without moving shape. Next: low on the cold and traces-on variants, and on review-84/#24 to check it generalizes.
- Harness: runs now wrapped in `caffeinate -i -s` (machine slept mid-run once); shim pins `--tsconfig`; aborts on CLI load failure.

## Shipped shape of "faster code search" (2026-09-04)

- The ast-grep guidance lives in `skills/dev-review/references/code-search.md` (vendored ast-grep rule reference inlined at the bottom). No separate skill, no skill install gating. dev-review reads it whenever `ast-grep` is on PATH.
- Settings ▸ Experimental Features ▸ "Faster code search": shows whether ast-grep is on the machine and installs it with Homebrew (`review install --code-search` does the same headlessly). No off switch: the binary's presence is the state; removing it is `brew uninstall ast-grep`.
- Protocol: `ReviewCliInstallStatus.codeSearch = { binary: {installed, path?, version?}, brew: {available, path?} }`; apply request accepts `codeSearch: true`.
