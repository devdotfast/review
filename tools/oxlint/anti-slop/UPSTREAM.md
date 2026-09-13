# Anti-slop provenance

Source: https://github.com/dmmulroy/anti-slop

## Partial update

Incoming commit: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`.
Copied from `skills/install-anti-slop/assets/anti-slop` at that revision:

- `rules/no-array-filter-map.ts`
- `rules/no-reduce-accumulator-copy.ts`
- `rules/require-readable-spacing.ts`
- `shared/array-method.ts`
- `vendor/eslint-stylistic/` (including its license and provenance)

Registered the three new generic rules alongside the native
`oxc/no-accumulating-spread` companion. They landed at warning severity and were
promoted to `error` once their findings were cleared; see "Promotion to error"
below. Existing rules, error severities, overrides, and Effect opt-in behavior
are preserved. Dependencies remain pinned to `oxlint` and `@oxlint/plugins`
1.63.0.

The previous installation is recoverable from Review commit
`5037c504e` (PR #95); its exact upstream base revision is unknown.
This is not a whole-plugin baseline update. Changes to existing upstream rules
and the optional Effect group are not included in this additions-only update.

## Verification at the time of the update

- Temporary representative fixtures: each new generic rule and the native
  companion warned with exit 0; an existing `no-unknown-parameters` violation
  failed with exit 1; accepted code passed without diagnostics.
- `pnpm typecheck` after `protocol:sync`: Review package passed; Desktop was
  blocked by missing Code OSS `tsgo` dependencies in the fresh worktree.

## Promotion to error

All four rules are now `error`. The findings they reported on the update branch
were resolved in two pull requests:

- #247 restored the structural blank lines: 12,826 `require-readable-spacing`
  findings across 503 files, cleared entirely by `oxlint --fix`. The commit is
  whitespace-only and is listed in `.git-blame-ignore-revs`.
- #246 rewrote the 20 `no-array-filter-map` sites as lazy `.values()…toArray()`
  pipelines and flipped `require-readable-spacing`, `no-array-filter-map`,
  `no-reduce-accumulator-copy` and `oxc/no-accumulating-spread` to `error`.
  The latter two had no findings.

`no-array-filter-map`'s preferred fix needs iterator helpers, so every
workspace `tsconfig` sets `lib` to ES2025. The runtime floor supports them:
Node 24 (`engines`, and tsdown targets node24) and Electron 42 (Chromium 140)
for the canvas.

## Verification

- `pnpm lint`: 0 warnings, 0 errors with all four rules at `error`.
- `pnpm format:check`: passed.
- `pnpm typecheck`: passed for every package.
- Historical, at the time of the additions-only update: `pnpm lint --format
  json` exited 0 with 11,451 warnings (11,434 spacing and 17 filter/map). Those
  counts grew to 12,826 and 20 by the time they were cleared.
