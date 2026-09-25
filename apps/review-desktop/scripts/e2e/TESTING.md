# End-to-end journeys

A manual suite. Each journey in `journeys/` launches Review Desktop once against
an isolated review home, profile, remote-debugging port and temp root, and drives
it through the JSON review API, the installed `review` CLI and Playwright over
CDP. Run `telemetry-contract` alone with
`pnpm --filter @dev.fast/review-desktop test:e2e:telemetry`.
`../e2e-runner.test.mjs` checks every journey exports `name`, `phase` and `run`.

## Prerequisites

macOS or Linux, Node 24, and a built Desktop from
`pnpm --filter @dev.fast/review-desktop app:build`. Windows runs only against an
installed build with `--app`: development mode launches `scripts/run.sh`. `go` and `cargo` are needed
only for the phase-2 journeys.

## Staging the runtime

`--runtime` must name a production install of the CLI, not this checkout:

```sh
pnpm --filter @dev.fast/review-desktop app:build
(cd packages/review && pnpm pack --pack-destination /tmp/review-pack)
mkdir -p /tmp/review-runtime && (cd /tmp/review-runtime && npm init -y >/dev/null && npm install --omit=dev /tmp/review-pack/dev.fast-review-*.tgz)
export REVIEW_E2E_RUNTIME=/tmp/review-runtime/node_modules/@dev.fast/review
```

## Running

```sh
node apps/review-desktop/scripts/e2e/run.mjs --runtime "$REVIEW_E2E_RUNTIME"
```

`--journey a,b` selects journeys by name, `--list` prints them without launching
anything, `--keep` keeps the temp root of a journey that passed, and
`--app` runs a packaged build: a macOS `.app`, or the installed executable on
Linux and Windows (pair it with `--runtime` pointing at that install's
`resources/app/review-runtime`). Each journey writes
`report.json`, `app.log` and, on failure, `failure.png` and `failure-dom.txt`
under `/tmp/review-e2e-<journey>-*` on macOS or `$TMPDIR/...` elsewhere. The run
prints a JSON summary on stdout, one entry per journey, `ok | failed | skipped`.

## Phases

Phase 1 runs offline, after a one-time network fetch of the curated VSIX cache
that `lsp-python` triggers. Phase 2 (`lsp-go`, `lsp-rust`) downloads toolchains
and runs only with `REVIEW_E2E_NETWORK=1`. In development mode each journey
re-materializes its extension group through `run.sh`, so this checkout's
`code-oss/extensions` holds the last journey's selection afterwards;
`node scripts/curated-extensions.mjs --only=all` restores it.

## Adding a journey

A journey module exports `name` (matching its basename), `phase`, `options`
passed to `createHarness`, and `run(ctx)`. Useful `ctx` helpers: `until` for
polling, `api` and `apiOk` for the JSON review API, `cli` and `cliRaw` for the
installed CLI, `appLog` for the Desktop's output so far, `check` to record
what the journey proved, plus `knownBug`, `restartDesktop` (`{ signal: "SIGKILL" }` for a crash, `beforeRelaunch` for
changes that need the Desktop stopped), `desktopPid`,
`quitAndRelaunchDesktop` (a real quit through the workbench), `createReview`,
`openHome`, `pickReview` and `sourceWindowFor` (the native Source window that
Go to Definition and Open file open). Throw `Error("skip: ...")` when the machine cannot
run the journey.

## Known bugs

Product bugs the suite finds live in `KNOWN_BUGS.md` beside this file. Never
weaken an assertion for one: assert the real behaviour, corroborate the bug's own
signature, then call `ctx.knownBug("<heading>")`. The harness fails the journey
when that heading is not in `KNOWN_BUGS.md`.
