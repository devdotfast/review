# Legacy review import: live test plan

For a tester driving the real app (computer use). Run it from the branch under test, in its worktree.

The automated gates already prove the mechanics (`native-authoring-e2e.mjs` on the schema-4 fixtures; `legacy-import-smoke.mjs` on a copy of the real reviews). This plan covers what a script cannot judge: how imported reviews look and behave in the app, the Home cards, the CLI experience now that the MDX verbs are gone, persistence across restarts, and the tutorial.

Report every step as pass, fail, or blocked, with a screenshot for anything visual and the exact terminal output for anything in a shell. Do not fix anything; capture and move on.

## Setup

The real `~/.dev/reviews` rarely contains every state at once (reviews never upgraded, reviews already on sealed JSON, reviews whose worktree is gone), so build a disposable home that does. The recipe copies the live reviews, adds the three schema-4 fixtures that were never upgraded, clones this repository into the home with every pinned commit, and points any review whose worktree no longer exists at that clone. The live `~/.dev` is never modified.

1. Build the home and launch the Desktop on it:

   ```sh
   cd <worktree for the branch under test>
   pnpm install
   HOME_DIR=$(bash apps/review-desktop/scripts/legacy-import-live-home.sh | head -1)
   cat "$HOME_DIR/TESTER-README.md"     # inventory, expected outcomes, CLI env
   DEV_WHITEBOARD_HOME="$HOME_DIR" DEV_FAST_WHITEBOARD_TELEMETRY_DISABLED=1 DEV_FAST_WHITEBOARD_CLI_NO_DELEGATE=1 DEV_WHITEBOARD_EXTENSIONS=none pnpm dev
   ```

   Keep this terminal open; the server logs `[Review import] <uuid>: imported as version N` or `skipped (<reason>)` here. Save the whole log at the end.

2. In a second terminal, every CLI command in this plan runs with the same home and without delegation to the app's bundled CLI. Run `review` from inside `$HOME_DIR/repos/review-scratch`, the repository every review in the home pins:

   ```sh
   export DEV_WHITEBOARD_HOME="$HOME_DIR" DEV_FAST_WHITEBOARD_CLI_NO_DELEGATE=1 DEV_FAST_WHITEBOARD_TELEMETRY_DISABLED=1
   cd <worktree for the branch under test>
   alias review='pnpm --filter @dev.fast/review review'
   ```

3. Make sure no other Review Desktop instance is running before launching, or screenshots and `app pick` will target the wrong window: `pgrep -fl "code-oss/.build/electron|Review.app"` should be empty, and `pkill -f review-live-` clears instances left by an earlier run of this plan. Do not kill an instance running on the live `~/.dev` home unless it is yours.

4. The inventory table in `TESTER-README.md` lists each review's uuid, schema, whether a sealed bundle exists, and whether it is a system review. Expected after the first Home list: schema-4 reviews with a worktree are upgraded to sealed JSON and imported; schema-5 JSON reviews are imported; the system review (the tutorial sample) is skipped; anything whose worktree is still missing stays legacy.

## A. Home after startup (import on list)

| # | Step | Expected |
|---|---|---|
| A1 | Wait for Home. | Every published review whose `worktreePath` exists appears **once**, not twice. The terminal shows one `imported as version N` line per such review. |
| A2 | Compare a card for an imported review with its legacy `review.json`. | The card shows the branch name (`sourceIdentity.name`) and, when the record has one, the PR number/link. Title matches. |
| A3 | Find a review whose `worktreePath` no longer exists. | It still appears as a legacy card, marked unavailable, and the terminal shows `skipped (repository unavailable at …)`. Opening it behaves as it did before this change. |
| A4 | Find a never-published review (draft). | It appears as a legacy card. Terminal: `skipped (never published)`. |
| A5 | Hover/inspect Home for the tutorial entry. | The tutorial is not on Home (it never was) and the terminal does not mention its uuid as imported. |

## B. Opening an imported review

Pick the imported review with the richest content (peeks, a diagram, a database lens, a map if any).

| # | Step | Expected |
|---|---|---|
| B1 | Click the card. | The JSON canvas opens (toolbar shows `Version N` with a date, "Open source tree", no Review/Commits/Diff/Map tab row from the legacy canvas). No blank canvas, no "Layout failed". |
| B2 | Read the document top to bottom. | Headings, paragraphs, bold/italic/code, lists and task lists, tables (check column alignment), fenced code with syntax highlighting, and links all render. Compare against your memory of the legacy rendering or against the same review in the released app if available; note any visible difference. |
| B3 | If the document starts with a callout "Imported from the MDX review". | Read the warnings. Each should describe something real (a source range that no longer resolves, a trace that could not be loaded). Screenshot it. |
| B4 | Click an inline source link (text linked to code). | An inline editor peek opens at the right file and lines. |
| B5 | Expand a code peek block. | The pinned source shows at the right range; the diff side (base/head) matches the legacy peek. |
| B6 | Sequence diagram, call stack, database lens (if present). | Each renders and is interactive (step through the sequence, expand storage details, select a use case). |
| B7 | If the review had a map: expand the "Software map" section at the end. | Two map blocks render (base and head); nodes are labelled and clickable. |
| B8 | Footnotes (if any). | Reference superscript is a link; clicking it scrolls to the definition at the bottom. |
| B9 | Version dropdown. | Lists one entry per sealed revision the legacy review had (oldest first). Selecting an older version renders that document; "Back to latest version" returns. |
| B10 | "Open source tree". | The Source view opens rooted at the review's repository. |
| B11 | Dismiss, then Restore from Home. | Attention state works on the imported entry; the card moves between sections accordingly. |

## C. Import on open

| # | Step | Expected |
|---|---|---|
| C1 | Seed one more published review into `<home>/reviews/<uuid>/` **while the app is running** — copy it from `~/.dev/reviews` (one whose worktree exists), or extract a `packages/review/src/fixtures/legacy-reviews/*.tgz` into a directory named after its `sourceUuid` — then run `review app pick --review <uuid>` from its repository. | The CLI exits 0 and prints the pick event. The JSON canvas opens for it. The terminal shows `imported as version N`. Home shows it once. |
| C2 | Run `review app pick --review <uuid>` again. | Exit 0, the JSON tab is focused, no second import line. |

## D. The JSON API is the only authoring route

There is no MDX authoring path left: `review scaffold`, `review publish`, `review repair`, `review rebind` and `review map publish` are gone. A review reaches the store by import (sections A and C) and changes only through `review api` or the MCP tools.

| # | Step | Expected |
|---|---|---|
| D1 | `review scaffold --help`, `review publish --help`, `review repair --help`. | Each exits non-zero with an unknown-command error. Nothing offers to author MDX. |
| D2 | `review info --review <uuid>` for an imported review. | Still works and prints the legacy record; nothing about it should look broken. |
| D3 | Edit the imported review through the JSON API: `review api tools`, then `review api review_edit "{\"commandId\":\"$(uuidgen | tr A-Z a-z)\",\"reviewId\":\"<uuid>\",\"edit\":{\"type\":\"insert\",\"content\":{\"type\":\"markdown\",\"markdown\":\"Edited after import.\\n\"}}}"` (every command tool needs a fresh `commandId`). | The edit lands; the canvas shows the new paragraph; the version number increments. |

## E. Restart and persistence

| # | Step | Expected |
|---|---|---|
| E1 | Quit the app (Cmd+Q), relaunch with the same `DEV_WHITEBOARD_HOME`. | Home lists the same imported reviews once each. The terminal shows **no** new `imported` lines for them (they are `current`). |
| E2 | Open one imported review. | Same content and version as before the restart. |
| E3 | Delete an imported review from Home (the JSON entry's Delete). | It disappears. On the next Home refresh it is imported again from the legacy directory (the legacy record still exists); note this as expected behavior for now. |

## F. Tutorial

| # | Step | Expected |
|---|---|---|
| F1 | Open the tutorial from the Welcome rail or Help. | It opens and works as before (legacy path). The terminal shows `skipped (system review)` at most once, or nothing. |

## G. Failure capture

For any fail: the screenshot, the `[Review import]` lines and any `[Review Desktop]` errors from the `pnpm dev` terminal, the review's uuid, and for terminal steps the full command output. If the JSON canvas is blank, also capture the DevTools console (Help → Toggle Developer Tools) errors.

## Out of scope

MDX authoring of any kind (the verbs are gone), Ask/comments (removed earlier), and reviews whose repository is gone (stay legacy by design).
