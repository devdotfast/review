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

Registered the three new generic rules at warning severity, alongside the native
`oxc/no-accumulating-spread` companion. Existing rules, error severities, overrides,
and Effect opt-in behavior are preserved. Dependencies remain pinned to
`oxlint` and `@oxlint/plugins` 1.63.0.

The previous installation is recoverable from Review commit
`5037c504e` (PR #95); its exact upstream base revision is unknown.
This is not a whole-plugin baseline update. Changes to existing upstream rules
and the optional Effect group are not included in this additions-only update.

## Verification

- `pnpm lint --format json`: exit 0, no errors; 11,451 warnings on the
  update branch (11,434 spacing and 17 filter/map findings).
- `pnpm format:check`: passed.
- Temporary representative fixtures: each new generic rule and the native
  companion warned with exit 0; an existing `no-unknown-parameters` violation
  failed with exit 1; accepted code passed without diagnostics.
- `pnpm typecheck` after `protocol:sync`: Review package passed; Desktop was
  blocked by missing Code OSS `tsgo` dependencies in the fresh worktree.
