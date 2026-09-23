# Whiteboard rename and session migration

The product becomes Whiteboard; authored reviews become sessions. Plans, specs, and other workflow changes are outside this migration.

## Reviewable layers

1. **Stored session model.** Rename owned identifiers and SQLite tables/columns together. Upgrade snapshots, command receipts, and workspace records once on startup. Preserve IDs, document contents, source pins, and history. Import historical shares and restore saved editor tabs at their persistence boundaries.
2. **Public interface.** Use one session tool catalog and one request/response model. Expose `whiteboard`, `/sessions-api`, and `session_*` tools. `--session` selects a Whiteboard session; `--agent-session` selects an agent conversation. Retired interfaces return migration instructions and do not execute requests.
3. **Managed installations.** Apply the user's committed skill text exactly. Recognize old installation ownership so updates can replace managed skills and MCP registrations. Upgrade enabled agent and Git trace hooks before retiring the old command, preserve custom hooks and tracing configuration, and leave disabled tracing disabled.
4. **Visible product names.** Update app titles, navigation, session labels, and theme display names.
5. **Private naming, packaging, and release references.** Rename private workspace packages, source paths, types, and canvas namespaces; publish the Whiteboard package and artifact names, update public repository references, and document the coordinated release steps.

These are review boundaries, not supported intermediate releases. Build and test each layer; release only the complete stack. No runtime dual vocabulary or per-handler translation layer is needed.

## Upgrade behavior

The store migrates in one SQLite transaction before new readers open. A malformed snapshot, conflicting identifier, or broken reference rolls the transaction back. Reopening an upgraded database is safe. Saved retry receipts remain usable with the canonical session command, so an acknowledged edit is not executed twice.

Workspace metadata lives in a separate database and upgrades under its existing owner transaction. Historical headless databases are copied before conversion and import; their originals remain backups. Published share bytes remain unchanged: only import/download parsing accepts the old envelope. The next saved editor state uses session identifiers.

Upgrades must stop the old app/headless server before replacing its executable and opening the migrated store. There is no mandatory intermediate release or new agent-suspension workflow. Cached old CLI, HTTP, and MCP calls receive instructions to reconnect using Whiteboard.

## Release sequence

1. Review and merge the complete stack. Keep publishing paused until candidate checks pass.
2. Deploy the hosted manifest compatibility change ([dev PR 1076](https://github.com/Fix-Fast/dev/pull/1076)) before the app release. It accepts session manifests without rewriting uploaded bytes.
3. Test a signed stable and preview candidate: fresh install, upgrade from released Review, and a subsequent Whiteboard update. Verify saved sessions, history, settings, links, MCP, skills, and tracing both enabled and disabled.
4. Rename `devdotfast/review` to `devdotfast/whiteboard`, update local remotes and external GitHub Action callers, and verify protections, checks, release permissions, and secrets. GitHub Action `uses:` references require the new repository name.
5. Publish the npm package and signed artifacts. Upload both Whiteboard and legacy download aliases before updating the channel feeds.
6. Deploy the coordinated download landing change ([dev PR 1071](https://github.com/Fix-Fast/dev/pull/1071)) and repository links ([dev PR 1072](https://github.com/Fix-Fast/dev/pull/1072)).

## Subsequent installation-identity stage

Profile directory names, OS bundle/application IDs, Linux package identities, URL schemes, and updater channels are a separate upgrade stage. The current release preserves those identities so the existing updater and profile discovery keep working. Renaming them requires a tested transfer of existing profiles and an old-to-new signed update, not just string replacement. Private packages and source directories are renamed in this stack without changing those persisted identities.

Old share formats and ownership markers remain recognized only where old data or installations enter the app. Existing domains, artwork, telemetry identities, and required CI check names need their own coordinated changes. References to code review remain valid descriptions of an activity.

README edits require the user's explicit approval and are not included. Local tests cannot establish signing, publication permissions, or production updater behavior; those are release-environment gates.

## Replacement review stack

- [1: stored session model](https://github.com/devdotfast/review/pull/478)
- [2: public session API](https://github.com/devdotfast/review/pull/479)
- [3: commands, skills, and tracing](https://github.com/devdotfast/review/pull/480)
- [4: visible product and session names](https://github.com/devdotfast/review/pull/481)
- [5: packaging and release preparation](https://github.com/devdotfast/review/pull/482)

The repository rename is a release operation and has not been performed by these PRs. README files have not been changed.
