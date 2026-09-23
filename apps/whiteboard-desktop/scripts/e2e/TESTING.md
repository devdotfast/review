# End-to-end journeys

A manual suite. Each journey in `journeys/` launches Review Desktop once against
an isolated review home, profile, remote-debugging port and temp root, and drives
it through the JSON review API, the installed `review` CLI and Playwright over
CDP. Nothing runs it in CI; the only automated gate is `../e2e-runner.test.mjs`,
a contract test that checks every journey exports `name`, `phase` and `run`.

## Prerequisites

macOS or Linux, Node 24, and a built Desktop from
`pnpm --filter @dev.fast/whiteboard-desktop app:build`. `go` and `cargo` are needed
only for the phase-2 journeys.

## Staging the runtime

`--runtime` must name a production install of the CLI, not this checkout:

```sh
pnpm --filter @dev.fast/whiteboard-desktop app:build
(cd packages/whiteboard && pnpm pack --pack-destination /tmp/review-pack)
mkdir -p /tmp/review-runtime && (cd /tmp/review-runtime && npm init -y >/dev/null && npm install --omit=dev /tmp/review-pack/dev.fast-review-*.tgz)
export WHITEBOARD_E2E_RUNTIME=/tmp/review-runtime/node_modules/@dev.fast/review
```

## Running

```sh
node apps/whiteboard-desktop/scripts/e2e/run.mjs --runtime "$WHITEBOARD_E2E_RUNTIME"
```

`--journey a,b` selects journeys by name, `--list` prints them without launching
anything, `--keep` keeps the temp root of a journey that passed, and
`--app /path/Review.app` runs a packaged build. Each journey writes
`report.json`, `app.log` and, on failure, `failure.png` and `failure-dom.txt`
under `/tmp/review-e2e-<journey>-*` on macOS or `$TMPDIR/...` elsewhere. The run
prints a JSON summary on stdout, one entry per journey, `ok | failed | skipped`.

## Phases

Phase 1 runs offline, after a one-time network fetch of the curated VSIX cache
that `lsp-python` triggers. Phase 2 (`lsp-go`, `lsp-rust`) downloads toolchains
and runs only with `WHITEBOARD_E2E_NETWORK=1`. In development mode each journey
re-materializes its extension group through `run.sh`, so this checkout's
`code-oss/extensions` holds the last journey's selection afterwards;
`node scripts/curated-extensions.mjs --only=all` restores it.

## Adding a journey

A journey module exports `name` (matching its basename), `phase`, `options`
passed to `createHarness`, and `run(ctx)`. Useful `ctx` helpers: `until` for
polling, `api` and `apiOk` for the JSON review API, `cli` and `cliRaw` for the
installed CLI, `check` to record what the journey proved, plus `knownBug`,
`restartDesktop`, `createWhiteboard`, `openHome` and `pickWhiteboard`. Throw
`Error("skip: ...")` when the machine cannot run the journey.

## Known bugs

Product bugs the suite finds live in `KNOWN_BUGS.md` beside this file. Never
weaken an assertion for one: assert the real behaviour, corroborate the bug's own
signature, then call `ctx.knownBug("<heading>")`. The harness fails the journey
when that heading is not in `KNOWN_BUGS.md`.
