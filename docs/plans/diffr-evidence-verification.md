# Direct diffr evidence: verification

Review's contract scaffold is `bb635df4`; implementation starts with `2a7b8dfb`. Diffr's contract scaffold is `a4f76a4ad`; implementation starts with `71d8db355`.

## Automated checks

- 101 focused Review tests pass, including persistence/reopen, invalid pins/text/blob rejection, stale evidence after repin, mixed glob/result targets, authoring API behavior, and lens UI lifecycle.
- 132 native tests pass, including UTF-8 highlight conversion, one-sided rows, nested fold expansion, paired changed lines, pinned source reads, and separate evidence/navigation/viewed actions for two sections of the same file. The desktop script tests also pass.
- All 9 diffr code-mode tests pass. Existing pretty-output snapshots are unchanged; the new schema test round-trips real hydrated and postprocessed results.
- Review, native, and diffr TypeScript checks pass. The dev build succeeds.

## Real API-to-app run

`diffr-search/tests/code-mode/review.live.ts` queried `Diffr evidence text differs` in this implementation's `local-data.ts`, comparing `e54665e3` with `90d7288c`. It used the real diffr JS binding, hydrated and postprocessed the query, and submitted structured results through Review's HTTP authoring API. It also selected a base-side result and a wholly unchanged `AGENTS.md` result.

The saved review includes a head-only excerpt, head-only and paired lenses, a mixed file-glob/result lens, an unchanged-file excerpt, and two diagram steps with distinct side selections on the same file. The script removed the query worktrees before reading back and opening the saved document.

The completed dev Review is `cc4f1cc1-1fbf-40d1-b42c-df4dafece6e6`, version 7. It remains open in the isolated `/tmp/review-evidence-dev` app instance. Local artifacts are in `/tmp/review-evidence-e2e-final/` (`evidence.json`, `pretty.txt`, `review.json`), with no server credentials.

Computer-use verification confirmed:

- Head-only code displays with search highlighting; Open File selects its matched line 739 in pinned source.
- The mixed lens retains both the glob-selected `source.ts` and the supplied search results, including unchanged `AGENTS.md`.
- The diagram has separate head-only and paired sections; selecting the paired step navigates to its section.
- Marking the head-only section viewed marks 76 added lines and leaves all five base deletions unread. The paired section changes to +0/-5. Viewed state was reset afterward.
- Earlier checks confirmed local nested fold toggling, find over visible evidence, and paired deleted/added rows.

The larger two-result sequence initially hit the old 1 MiB authoring limit. The command endpoint now permits 8 MiB, matching resource uploads; the unchanged live test then passed. No evidence was truncated or replaced with ranges to pass the test.

## Contracts and remaining environment limitation

The approved `targets` ADT now flows through `DiagramLens` and native `ReviewDiffSection`. `sources` remains a coverage/navigation projection. No SQL schema, computed-diff cache schema, upload requirement, or evidence wire-field rename was introduced. The shared diffr contract is installed from a pinned Git revision.

The dev app reports a language-environment preparation failure on both tested revisions: its setup runs the review-protocol build before the `@dev.fast/json` and trace-protocol declaration outputs exist. Pinned-source opening and line selection were verified despite this warning; LSP definition navigation is not claimed as verified.

## Review order

- diffr: #6 contracts/output → #7 plugins → #20 Rust storage → #8 search/bindings → #10 Jev → [#13 Review evidence](https://github.com/devdotfast/diffr/pull/13)
- Review: [#369 contracts](https://github.com/devdotfast/review/pull/369) → [#381 validation/storage](https://github.com/devdotfast/review/pull/381) → [#370 rendering](https://github.com/devdotfast/review/pull/370)

Both are draft stacks. History now groups the final contracts, consumers, and implementations by system boundary; superseded approaches and follow-up corrections are folded into their owning changes. The rewritten diffr tip has the exact original Git tree; Review application code is unchanged, with its dependency repinned to that rewritten tip. The verification identities below record the original runs.

## Structural Diff renderer correction

The initial integration routed explicit lenses through an inline-editor container. That preserved evidence coordinates but bypassed the established structural Diff UI; the initial E2E did not establish UI parity. This path, its bespoke toolbar/file list, and its implementation-coupled DOM test have been removed.

Both retained results and ordinary range lenses now use ReviewFilesDiffView and the existing structural provider. Retained trees seed the existing alignment, fold bands, labels/pseudocode, and collapse controls. Search decorations are blue. Model-pair identity separates two same-file results/sections. Explicit side selection is preserved, with a native internal forceInline option preventing an empty counterpart pane. No public evidence DTO or stored schema changed.

Validation: 133 native tests and native typechecking pass; the dev build succeeds. The new checks cover head-only pseudocode bands and UTF-16 search spans, JSON-transported section targets, and one-sided range navigation. Visual checks against the saved real search results confirmed the native file header, fold expansion, blue highlight, full-width head-only layout, mixed targets (three files), and navigation between the head-only and paired diagram sections. Pseudocode label conversion is covered by tests; the saved query's labels are unchanged-line summaries.


## Complete comparisons and shared unchanged sources

Diffr now retains complete comparison trees through hydration and postprocessing.
The public Comparison union couples file references to sources, stores unchanged
content once as `sources.same`, and uses `display` solely for presentation. Review
validates both retained sides and upgrades older saved `kind` payloads on read.
It keeps using the existing structural Diff component; no replacement view was added.

Validated against diffr `9516f12f4` and Review `b1c608ee`: 262 Rust library tests,
11 JS integration tests (unchanged pretty-output snapshot), 68 focused Review tests,
20 native presentation tests, and TypeScript checks. The dev build succeeds.

The live query selected evidence from Review's own `e54665e3..b1c608ee` diff,
submitted head-only, paired, shared-unchanged and base-only displays, removed the
query worktrees, and verified the saved evidence round trip. Review
`0aabeb9f-e593-4b98-bf8c-dad4dbad66f4`, version 7, remains in the isolated dev app.
Artifacts: `/tmp/review-evidence-comparison/{evidence.json,pretty.txt,review.json}`.
Computer-use checks confirmed the full-width head-only structural view, blue
matched-line highlight, native fold expansion revealing retained lines 9–24,
and shared unchanged AGENTS.md displayed in the mixed-results lens.

The separate language-environment warning remains. A normal whole-file entry in
the mixed lens also reported a busy pinned checkout during preparation; retained
search evidence displayed successfully. This check does not establish LSP readiness.
