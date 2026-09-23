# Whiteboard public rename

This stack changes public names. It does not add workflows or rewrite saved sessions.

## Review order

Each row is a separate draft PR. The stack starts at `dev-review-skill-rewrite`; each branch builds on the preceding row.

| Layer | Change | PR |
| --- | --- | --- |
| Session API | Add session endpoints over the current store | [399](https://github.com/devdotfast/review/pull/399) |
| CLI | Add `whiteboard`, session tools, and explicit agent-session selectors | [400](https://github.com/devdotfast/review/pull/400) |
| Skills | Rename the rewritten skill to `/whiteboard`; keep `/dev-review` as a pointer | [402](https://github.com/devdotfast/review/pull/402) |
| Installation | Migrate app-managed launchers, MCP registrations, and hooks | [403](https://github.com/devdotfast/review/pull/403) |
| Visible names | Rename app titles and authored-session labels | [404](https://github.com/devdotfast/review/pull/404) |
| Packaging | Publishable package name and Whiteboard release filenames | [405](https://github.com/devdotfast/review/pull/405) |
| Public references | Update current docs and repository links | [406](https://github.com/devdotfast/review/pull/406) |
| Consumers | Move first-party requests to the session API | [407](https://github.com/devdotfast/review/pull/407) |
| Cutover | Return migration notices for retired interfaces | Top of stack |

The intermediate layers keep both interfaces available. The final layer retires the old CLI and HTTP API. The legacy MCP entry answers cached calls with reconnect instructions. It does not forward operations.

## Release sequence

The PRs can merge in order. Do not publish intermediate rename builds.

1. Review and merge the complete app stack. Keep publishing workflows paused until the gates below pass.
2. Build signed stable and preview candidates. Check a fresh install and an upgrade from the currently released Review app. Then check an update from Whiteboard to a second Whiteboard candidate.
3. Check saved sessions, historical versions, settings, PR links, and traces after the upgrade. Check installed skills, CLI selection, MCP registration, and trace hooks. Check stale agent calls receive migration instructions.
4. Rename `devdotfast/review` to `devdotfast/whiteboard` in GitHub. Update local remotes and known external Action callers. GitHub Action `uses:` references require the new repository name; repository redirects are not sufficient.
5. Check branch protections, required check names, release permissions, environments, secrets, badges, and release links. Keep the required `Review Desktop` check name until its ruleset changes with it.
6. Publish the new npm package and signed app artifacts. Upload both `Whiteboard.dmg` and the old `Review.dmg` aliases before updating each channel's feed. Check both aliases and the referenced payload.
7. Deploy the download landing change: [dev PR 1071](https://github.com/Fix-Fast/dev/pull/1071). Deploy repository links after the rename: [dev PR 1072](https://github.com/Fix-Fast/dev/pull/1072).

No mandatory preparatory release is required. Stop or restart an old headless server before replacing its executable. An already-running process keeps its loaded code until it exits. No upgrade drain or agent suspension system is part of this rename.

## Release gates still requiring the release environment

- Signed macOS install, old-to-new upgrade, and subsequent in-app update.
- New npm package ownership and publication permissions.
- Repository rename and known external Action callers.
- Stable and preview artifact aliases, update feed, and production download checks.
- README patch approval. The repository instructions require permission to edit README files. The proposed edits are separate from this stack until approved.

Local builds and tests do not prove signing, updater behavior, or production publication. Draft PR creation does not perform these release steps.

## Deliberately retained for later stages

| Retained names | Reason / next stage |
| --- | --- |
| Source directories, internal symbols, private workspace package names | Rename mechanically in small buildable layers after the public release. |
| SQLite schema and stored metadata keys; existing IDs and command receipts | Audit each field before changing it. An internal vocabulary change alone does not require rewriting user data. |
| Profile paths, bundle/application IDs, Linux package identity, theme IDs | Require separate install and update migration checks. |
| Historical share formats and published artifacts | Keep readers compatible; do not rewrite immutable content. |
| Ownership markers and legacy skill pointers | Identify app-managed installations without overwriting custom integrations. |
| Existing domains, artwork, telemetry keys, and required CI check name | Keep their identity until a separate coordinated change. |
| Code-review verbs and references to PR reviews | They describe activities, not the authored-session entity. |

Plans, specs, and workflow redesign remain separate work.
