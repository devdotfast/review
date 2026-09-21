# Review canvas

`@dev.fast/review-canvas` is the private browser workspace used by Review Desktop.
It owns the React UI, layout libraries, Vite build, and browser tests. It stays
under `packages/review/app` so the existing canvas assets and shared-source
imports keep their locations; it has its own dependency graph and test runner.

```sh
pnpm --filter @dev.fast/review-canvas build
pnpm --filter @dev.fast/review-canvas test
pnpm --filter @dev.fast/review-canvas typecheck
```

Desktop copies `dist/desktop` into its canvas directory. The public
`@dev.fast/review` Node runtime does not depend on or package this workspace.
Shared document models and pure helpers are imported from the Review workspace;
the canvas consumes those sources during its build, not through runtime npm
installation.
