# Bugs found by the e2e journey suite

One `## ` heading per bug; the heading text is what `ctx.knownBug("...")` references
(`harness.mjs` asserts the heading exists), so keep it stable once written. A journey
never weakens an assertion to pass: it asserts the real behaviour, corroborates the
bug's signature, then marks the check with `ctx.knownBug`, so the journey fails again
the day the bug is fixed.

Status values: `open`, `fix-pr #<n>`, `fixed`, `not-a-bug` (with the reason).

## Status

- `review info --review <uuid>` always fails with `Not found.` — open
- `review app pick --review <uuid>` never opens the review — open
- The first-run telemetry notice disappears before it can be used — open
- A community invitation dismissed before the first-run reload comes back — open
- The modal editor opened by Go to Definition ignores the first Escape — open
- The review topbar covers the Find widget and the contents pill — open
- A review whose repository directory moves or is deleted renders `ReviewApiError: Review operation failed.` — open
- `review app pick` goes to the launcher instead of reporting an unusable pointer — open
- One unreadable legacy `review.json` stops Review Desktop from starting — open
- Home says nothing about a legacy review directory left behind by the JSON cutover — not-a-bug
- Opening a Go file installs Go tools from the network without asking — open
- A review's Rust language server never starts when the extension wins a race with the workspace folder — open

## Template (copy, do not edit)

- **Journey:** `<journey name>` · **Found:** YYYY-MM-DD · **Status:** open
- **Repro:** the CLI / UI steps, exactly as the journey performs them.
- **Expected:** one sentence.
- **Actual:** one sentence, plus the assertion message or screenshot path.
- **Notes:** suspected cause with a `file:line` pointer if known.

## `review info --review <uuid>` always fails with `Not found.`

- **Journey:** `legacy-import` · **Found:** 2026-09-17 · **Status:** open
- **Repro:** with Review Desktop running and any review in the store, run
  `review info --review <uuid> --json`.
- **Expected:** the command prints the review's summary and exits 0.
- **Actual:** exits 1 with
  `{"name":"ReviewApiError","message":"Not found."}` thrown from
  `ReviewApiClient.response`. `review info` with no `--review` fails the same way,
  so the verb is unusable.
- **Notes:** `review-info.ts:33` calls `client.read("/")`, and
  `review-api-client.ts:75` builds `${serverUrl}/reviews-api${route}`, so the
  request goes to `/reviews-api/` with a trailing slash. The route is mounted at
  `/reviews-api` (`server/desktop-server.ts:159`) and Hono matches it strictly:
  a live probe returned 200 for `GET /reviews-api` and 404 for `GET /reviews-api/`.
  Passing `""` instead of `"/"` (or relaxing the mount) should fix it.

## `review app pick --review <uuid>` never opens the review

- **Journey:** `legacy-import`, `json-api-edit`, `home-multi-review` · **Found:** 2026-09-17 · **Status:** open
- **Repro:** with Review Desktop running and a review whose snapshot
  `GET /reviews-api/<uuid>?full=true` returns 200, run
  `review app pick --review <uuid> --json`.
- **Expected:** Desktop opens that review and the command exits 0.
- **Actual:** exits 1 with
  `{"name":"ReviewApiError","message":"Review or version not found."}` thrown from
  `ReviewApiClient.post`. Reproduced for both importable fixtures.
- **Notes:** `review-app.ts:63` does
  `review = await client.read("/<uuid>")` expecting
  `Pick<ReviewApiSummary, "reviewId" | "title">`, but `GET /reviews-api/:id`
  returns `inspectSnapshot(...)` — an array of blocks — unless `full=true`
  (`review-api/http.ts:620-637`). So `review.reviewId` is `undefined` and
  `review-app.ts:93` posts to `/reviews-api/undefined/open`, which 404s.
  `POST /reviews-api/<uuid>/open` works, so only the id lookup is wrong.

## The first-run telemetry notice disappears before it can be used

- **Journey:** `first-run` · **Found:** 2026-09-17 · **Status:** open
- **Repro:** launch Desktop on a fresh profile with telemetry live
  (`DEV_FAST_REVIEW_TELEMETRY_DISABLED` unset). The notification "Review sends
  anonymous usage data. You can change this in Settings." appears behind the
  modal "Join the Review community" dialog; dismiss the dialog and look for the
  notification.
- **Expected:** the notice stays until the reader dismisses it or follows its
  "Open Settings" action.
- **Actual:** the workbench reloads itself about 1.8 s into the first run and
  the notification goes with it, and it never returns. Measured 8 s after
  launch: zero notices on screen with
  `review.telemetry.noticeShown.v1 = true` already in
  `<user-data>/User/globalStorage/state.vscdb`. A first click on "Open Settings"
  fails with `element was detached from the DOM`.
- **Notes:** `reviewTelemetry.contribution.ts:36-41` stores the shown flag
  before it calls `notificationService.prompt`, so the notice is spent whether
  or not anyone saw it, and
  `reviewCuratedExtensions.contribution.ts:664` runs
  `workbench.action.reloadWindow` on a fresh profile once the keymap defaults
  are seeded. Storing the flag when the notice is dismissed, or re-showing it
  after the seeding reload, would fix it.

## A community invitation dismissed before the first-run reload comes back

- **Journey:** `first-run` · **Found:** 2026-09-17 · **Status:** open
- **Repro:** on a fresh profile, tick "Don't show again" and click "Not now" on
  "Join the Review community" within the first two seconds, then wait for the
  automatic first-run reload.
- **Expected:** the invitation stays dismissed and
  `review.community.dontShowAgain` is stored.
- **Actual:** the invitation returns after the reload with its checkbox cleared,
  and the key is in neither `<user-data>/User/globalStorage/state.vscdb` nor the
  shared `sharedStorage/state.vscdb`. The journey corroborates the reading
  before it records this bug, and a stored flag would fail it instead with
  `the invitation returned although review.community.dontShowAgain is true`.
- **Notes:** `reviewCommunity.contribution.ts:35-38` stores the flag from the
  dialog's promise callback, and
  `reviewCuratedExtensions.contribution.ts:664` reloads the window on a fresh
  profile about 1.8 s in; the pending storage write does not survive that
  reload. A dismissal after the reload persists, so only the first-run window
  loses it.

## The modal editor opened by Go to Definition ignores the first Escape

- **Journey:** `tutorial` · **Found:** 2026-09-17 · **Status:** open
- **Repro:** open the tutorial, click `totalCents` in the Welcome inline editor
  (`src/orders/order-service.ts:13-29`), press `F12`, then press `Escape` once.
- **Expected:** one `Escape` closes the modal editor and returns the reader to
  the review, which is what the keybinding's own comment promises: "When a
  list/tree is focused, still close the modal … The selection is intentionally
  not cleared first so a single `Escape` closes the modal."
- **Actual:** the modal stays open. Measured twice on a fresh profile: when the
  modal mounts, `document.activeElement` is the modal's References tree
  (`div.monaco-list[role="tree"][aria-label="References"]`, inside
  `.monaco-modal-editor-block`); the first `Escape` only moves focus to the
  modal editor's `div.native-edit-context` and leaves the modal up; the second
  `Escape` closes it. The journey clicks the modal backdrop instead, which
  closes it in one action.
- **Notes:** the `Escape` binding for `workbench.action.closeModalEditor` has a
  list/tree arm at `KeybindingWeight.WorkbenchContrib + 1`
  (`editorCommands.ts:1587-1593`), but the References list's own `Escape`
  handling appears to win and refocus the editor instead, so the documented
  single-press close never happens. No assertion is weakened by this: the
  journey does not call `ctx.knownBug` for it, it only records why the backdrop
  click replaced `Escape`.

## The review topbar covers the Find widget and the contents pill

- **Journey:** `reader-navigation` · **Found:** 2026-09-17 · **Status:** open
- **Repro:** open any JSON review with two or more headings in a 1200x800
  window. Click the contents pill at the top left; press `Cmd+F` and click
  `Match Whole Word` or `Use Regular Expression` in the Find widget.
- **Expected:** the pill opens the contents drawer and the toggles flip.
- **Actual:** neither click reaches its button. Playwright reports
  `<header class="review-topbar">…</header> intercepts pointer events` for the
  pill and `<div class="review-topbar-actions">…</div> … subtree intercepts
  pointer events` for the toggles, and `document.elementFromPoint` at the
  centre of each control returns an element inside `.review-topbar`.
- **Notes:** measured in the workbench renderer (viewport 1200x800): the review
  canvas starts at y=74, `.review-topbar` is `position: sticky` from 74 to 109
  with `z-index: var(--review-debug-layer)` (`styles.css:2318`), and the whole
  review scroll region starts at 109. That token is `2147483000`
  (`styles.css:140`) and five rules share it (`:1704`, `:1770`, `:2318`,
  `:3137`, `:3896`), so a fix belongs on the token or on the overlays, not on a
  literal; the prebuilt canvas CSS the staged runtime ships still carries an
  older `2147480000`, which is the number the measurement reports. Both
  overlays are laid out against a containing block whose top is y=40 — 34 px
  above the canvas — so they land inside that band: `.review-toc-toggle`
  (`position: fixed; top: calc(32px + var(--review-page-top))`,
  `styles.css:4641-4646`) measures 92–124, and
  `.review-find-widget` (`position: absolute; top: 48px; z-index: 120`,
  `styles.css:503-519`) puts its toggles at 95–115. The topbar's near-maximum
  `z-index` beats both, so the covered part of each control is dead. The pill is
  the only way into the contents below a 1360 px shell (`review-toc.tsx:25`,
  `:216`), so in a normal window the reader has no working table of contents at
  all. The journey corroborates each failure with both Playwright's
  interception message and `elementFromPoint` before it falls back to
  `dispatchEvent("click")`.

## A review whose repository directory moves or is deleted renders `ReviewApiError: Review operation failed.`

- **Journey:** `worktree-drift` · **Found:** 2026-09-17 · **Status:** open
- **Repro:** create a review with a `commits` target in a git repository, let it
  render, quit Review Desktop, `mv <repo> <repo>-moved` (or `rm -rf` it),
  relaunch Desktop and open the review from Home or with
  `POST /reviews-api/<uuid>/open`.
- **Expected:** the canvas either renders the review from the pinned checkout —
  after the rename it is intact, it lives at
  `<repo>-moved/.git/dev-fast/reviews/<uuid>/head/<sha>` and moved with the
  repository — or says which checkout it can no longer find.
- **Actual:** the canvas renders only
  `<p role="status">ReviewApiError: Review operation failed.</p>` inside
  `.review-canvas-root [data-review-api]`, with no title, no document and no
  path. `GET /reviews-api/<uuid>/commits?version=<n>` answers 500 with
  `{"error":"Review operation failed."}`; `GET /reviews-api/<uuid>?full=true`
  and `GET /reviews-api` still answer 200 with the whole document, so the
  document is intact and only the source-backed read fails. A plain restart
  with the repository left in place renders the same review normally, so the
  move is the cause.
- **Notes:** the stored `repositoryPath` is absolute and is never re-resolved —
  the summary list still reports `repositoryPath: "/…/repo"` after the rename,
  and Home keeps offering the review (and a `View source →` link) under a
  directory that no longer exists. `api-document.tsx:100-105` loads
  `/<id>/commits` before anything else renders, and every provider failure
  becomes the generic 500 at `review-api/http.ts:50`, which
  `api-canvas.tsx:166` shows verbatim. A graceful degradation exists —
  `sourceUnavailable`, rendered as "Local checkout unavailable. Showing
  retained source." (`api-document.tsx:224-228`) — and one of its two writers
  is not gated on the target kind: `GET /:id?full=true` sets it for any target
  when `data.sourcePins(snapshot)` throws a 404 `ReviewInputError`
  (`http.ts:620-633`). That path was not taken here — `?full=true` answered 200
  and did not degrade, so `sourcePins` still resolved after the rename, and
  whatever `/:id/commits` needs from the repository is not what `sourcePins`
  needs. The `/commits` route has no equivalent degradation at all, so it has
  nothing to fall back to. (The other writer, the worktree refresh at
  `store.ts:186-198` and `:225-243`, *is* gated on
  `target.kind === "worktree"` and cannot fire for this review either.) The
  `Worktree unavailable` state at `desktop-entry.tsx:38-46` is unreachable
  today: the only `{ kind: "source" }` render (`reviewCanvasPart.ts:308`) never
  sets `error`, so no journey can assert that string.

## `review app pick` goes to the launcher instead of reporting an unusable pointer

- **Journey:** `cli-desktop-edges` · **Found:** 2026-09-17 · **Status:** open
- **Repro:** put an unusable pointer in `<home>/review-desktop/server.json` —
  `version: 999`, or unparseable text, or a url nothing listens on — and run
  `review app pick --review <uuid>`.
- **Expected:** the same message `review info` prints for that pointer:
  "Review Desktop uses protocol 999, but this Review CLI needs protocol 3.
  Update Review and Review Desktop to compatible versions, then try again.",
  "Review Desktop discovery is unreadable at …", or "Review Desktop is not
  ready. Run `review app launch`, then retry …".
- **Actual:** the CLI prints none of them. It goes to the launcher, which runs
  `/usr/bin/open -b dev.fast.review` and then polls for up to 90 s for a pointer
  it can use. Measured with a 25 s cap and no intervention, the command produced
  no output at all and had to be killed. Measured again with the pointer
  replaced by a working one three seconds in, the command silently picked the
  replacement up and carried on to that Desktop — it had been sitting in the
  poll loop the whole time, with the diagnosis in hand and nothing printed.
  Whether a second Desktop actually starts depends on the machine, not on the
  pointer: `open -b` only activates an installed Desktop that is already
  running, whatever home it was started for, so a user with Review open gets a
  silent 90 s hang and a user without it gets a second Desktop. The journey
  asserts no pointer error reached the output, and that the command either
  reached a Desktop after the replacement or reported that it could not launch
  one; it kills whatever it started, identified by `DEV_REVIEW_HOME` in the
  process environment so a Desktop belonging to another session is never
  touched.
- **Notes:** `review-app.ts:49-50` calls `runtime.launch()` before it reads the
  pointer, and `review-app-launcher.ts:281-289` catches every discovery error on
  purpose ("Launch must recover from stale, malformed, and incompatible
  discovery") and returns `null`, which the launcher reads as "nothing is
  running". Recovering by launching is right for `review app launch`, which the
  user asked to start something; for every other verb it turns a one-line
  diagnosis into a second Desktop and a 90 s wait. Reading the pointer first and
  rethrowing anything but `null` from `runReviewAppPick` would fix it. Two
  consequences beyond the message: the launched app inherits the caller's
  environment (`open`(1) propagates it), so it attaches to whichever
  `DEV_REVIEW_HOME` the CLI had; and the "Review Desktop is not ready. Run
  `review app launch` and retry `review app pick`." throw at `review-app.ts:52-55`
  is unreachable, because a null pointer read means the launcher already gave up.

## One unreadable legacy `review.json` stops Review Desktop from starting

- **Journey:** `settings-and-migration` · **Found:** 2026-09-17 · **Status:** open
- **Repro:** take a Review home that has not been through the JSON cutover (no
  `<home>/json-cutover.json`) and put one unreadable record in it —
  `<home>/reviews/11111111-1111-4111-8111-111111111111/review.json` holding
  `{"schemaVersion":1,"uuid":"11111111-1111-4111-8111-111111111111"}` — then
  start the Desktop's server host against that home
  (`node <runtime>/dist/server/desktop-host.js` with `DEV_REVIEW_HOME=<home>`,
  `DEV_FAST_REVIEW_SERVER_PORT=0`, `DEV_FAST_REVIEW_APP_PID=<a live pid>`).
- **Expected:** the host starts, the reviews it can read are available, and the
  one it cannot is reported to the reader with the command its own error text
  names: "Invalid review.json; run `review migrate apply`"
  (`review-home.ts:364-366`, `:706-710`).
- **Actual:** the host exits 1 before it ever listens, and nothing starts. It
  prints `Error: Review migration could not finish. The original database is
  unchanged. Report: <home>/.json-cutover-XXXXXX/report.json`, followed by the
  review's uuid and the raw Zod union failure — three alternatives, roughly 90
  lines of `"code": "invalid_type"` entries naming `repoKey`, `worktreePath`,
  `baseRef` and the rest. The words `review migrate apply` do not appear. The
  journey asserts the exit code, the message and that absence before it records
  this bug; a host that started, or one that named the command, fails it
  instead.
- **Notes:** `json-cutover.ts:92-109` collects a parse failure into
  `report.errors`, `:206` refuses to install the converted database when that
  list is non-empty, and `ensureJsonCutover` (`:275-281`) turns it into the
  throw above; `desktop-host.ts:64` is inside no try, so the host dies with it.
  In the app this is not a message the reader gets: the supervisor restarts the
  host on each exit and, once the delay budget runs out, fails with the generic
  "The Review server exhausted its restart budget without becoming ready."
  (`reviewServerSupervisor.ts:290-313`), leaving the schema dump in the log.
  The advice the record's own error carries does not help either: `review
  migrate apply` on this record reports `<dir>: current artifact migration
  failed: Unsupported Review schema; the record was preserved.` and exits 1
  (`stored-review-migration.ts:95-100`, `:190-194`), so a reader whose Desktop
  will not start has no way forward but to find and move the directory by hand.
  Skipping the unreadable directory — the cutover already records it in
  `report.errors`, and `migrateJsonReviews` leaves every original untouched —
  and surfacing it once the app is up would keep the safety and the app.
- **Also found, not a bug:** "Home says nothing about a legacy review
  directory left behind by the JSON cutover", below.

## Home says nothing about a legacy review directory left behind by the JSON cutover

- **Journey:** `settings-and-migration` · **Found:** 2026-09-17 · **Status:**
  not-a-bug — the JSON store is the catalog, and the cutover that fills it is a
  one-time storage migration, not a Home refresh task. A directory left in
  `<home>/reviews` afterwards is dead data, and nothing writes one any more.
- **Repro:** with a Review home that has already been through the cutover
  (`<home>/json-cutover.json` present), add
  `<home>/reviews/11111111-1111-4111-8111-111111111111/review.json` holding
  `{"schemaVersion":1,"uuid":"11111111-1111-4111-8111-111111111111"}`, restart
  Review Desktop and open Home.
- **Expected (by the plan):** Home lists the review as needing migration and
  names the command to run, from the `MIGRATION_REQUIRED` `ReviewHomeError`
  whose message is "Invalid review.json; run `review migrate apply`: …"
  (`review-home.ts:364-366`, `:706-710`).
- **Actual:** Home renders the empty-Home onboarding rail and mentions neither
  the review nor the command; `GET /reviews-api` answers 200 without it; the
  directory is left byte-for-byte as seeded. The journey asserts all three, and
  keeps the plan's assertion behind a branch that fires if a build grows the
  guidance, so the expectation is recorded rather than dropped.
- **Notes:** `ensureJsonCutover` (`json-cutover.ts:238-270`) returns on its
  marker without reading `<home>/reviews` again, and Home lists from the JSON
  store (`review-api/store.ts:485`). The `MIGRATION_REQUIRED` error has no
  Desktop consumer at all: it reaches only `ListReviewsResult.errors`
  (`review-home.ts:139-143`), `listReviews` has one non-test caller,
  `publish-preparation.ts:24` — the only place that sets
  `reportUnreadableReviews` — and `ReviewHomeError` appears nowhere in
  `packages/review/app/src`. What is worth fixing is the path where such a
  directory still matters, which is the entry above: before the cutover has run,
  the same record stops the Desktop from starting.

## Opening a Go file installs Go tools from the network without asking

- **Journey:** `lsp-go` · **Found:** 2026-09-17 · **Status:** open
- **Repro:** launch Desktop with the curated `go` group materialized
  (`DEV_REVIEW_EXTENSIONS=go`) on a machine whose PATH and GOPATH have no
  `gopls`, then open a review with a `code_peek` over a `.go` file.
- **Expected:** Review asks before it downloads and builds a language server,
  the way it asks before downloading an optional extension
  (`reviewCuratedExtensions.contribution.ts:244-527`), or at least the way the
  Go extension's own `promptForMissingTool` asks —
  `The "gopls" command is not available. Run "go install -v
  golang.org/x/tools/gopls@latest" to install.` with an `Install` action.
- **Actual:** no notification appears. Within seconds of the peek rendering,
  `golang.go` has run `go install github.com/golang/vscode-go/vscgo@v0.56.0`
  and `go install -v golang.org/x/tools/gopls@latest` against the reader's Go
  toolchain and written a 41 MB `gopls` into `$GOPATH/bin`. Observed in
  `<profile>/user-data/logs/*/window1/exthost/golang.go/Go.log`:
  `Installing 1 tool at <GOPATH>/bin` / `gopls` / `Installing
  golang.org/x/tools/gopls@latest (…) SUCCEEDED`. The journey asserts the
  binary appears with no prompt having been shown.
- **Notes:** `golang.go@0.56.0` `dist/goMain.js:32837` `maybeInstallImportantTools`
  installs every missing `isImportant` tool on activation
  (`:32860`, `installTools(missing, goVersion, { toolsManager: tm,
  skipRestartGopls: true })`), which is reached before any code path that
  prompts: `promptForMissingTool` (`:32675`, the `Install` / `Install All`
  error notification at `:32696-32710`) only ever sees tools that go missing
  after that pass. `curated-extensions.manifest.mjs:247-248` describes the
  extension as prompting, which was true of older releases and is not true of
  the pinned one.
  `reviewConfigurationDefaults.ts:104-107` already turns off that extension's
  survey and update prompts; it has no setting for this one, because the
  extension offers none — `go.toolsManagement.checkForUpdates: 'off'` only
  covers updates of tools that are already installed. Review chooses which
  extensions it bundles, so the honest fixes are to gate the Go group behind
  the same consent the optional groups get, or to ship `go.alternateTools` /
  an activation guard that keeps the extension from installing anything until
  the reader asks. This is what the `go` group's "no server is bundled" note
  costs in practice.

## A review's Rust language server never starts when the extension wins a race with the workspace folder

- **Journey:** `lsp-rust` · **Found:** 2026-09-17 · **Status:** open
- **Repro:** install the Rust group through Settings → Tools → Extensions, then
  open a review with a `code_peek` over a `.rs` file in a Cargo project. Two
  windows out of three, no hover, no Go to Definition, no `cargo` process and
  no `target/` or `Cargo.lock` in the review's pinned checkout; the third
  window works.
- **Expected:** opening the peek starts rust-analyzer against the review's
  checkout every time.
- **Actual:** in a losing window
  `<profile>/user-data/logs/*/window1/exthost/rust-lang.rust-analyzer/rust-analyzer Extension.log`
  ends at `Starting language client` and never reaches
  `Using server binary at …`, which is the line the extension logs once it has
  decided it has a workspace. Nothing recovers it: the journey asserts that
  signature before it retries in a new window.
- **Notes:** `reviewLocalLanguageFeatures.acquire` (`:152-166`) adds the
  checkout as a workspace folder and then calls
  `extensions.activateByEvent("onLanguage:rust")` — but `addFolders` resolving
  in the renderer (`workspaceContextService.ts:72-74`, `:110-166`) does not mean
  the extension host has applied the change, so the activation can reach
  `rust-analyzer` first. `rust-analyzer`'s `activate` captures
  `fetchWorkspace()` once (`out/main.js`, `new Ctx(context, …, fetchWorkspace())`);
  with no folders and no open Rust document it is `{kind: "Empty"}`,
  `getOrCreateClient` returns without starting anything, and
  `onWorkspaceFolderChanges` only restarts a client that is *already running*,
  so the later folder change is ignored and even `rust-analyzer: Restart
  Server` cannot help — the captured workspace is never re-read. The fix
  belongs on Review's side: activate only after the extension host has the
  folder (or open the document first, which would at least yield
  `{kind: "Detached Files"}`). The same ordering is what
  `curated-extensions.manifest.mjs:86-95` already works around for
  `workspaceContains:`.
