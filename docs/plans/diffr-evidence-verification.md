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

- diffr: https://github.com/devdotfast/diffr/pull/12 → https://github.com/devdotfast/diffr/pull/13
- Review: https://github.com/devdotfast/review/pull/369 → https://github.com/devdotfast/review/pull/370

Both are draft stacks. Implementation commits separate validation/storage, rendering, live-check corrections, target propagation, dependency packaging, and request sizing.
