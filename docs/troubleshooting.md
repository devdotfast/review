# Troubleshooting

Start with the matching CLI and a running Desktop:

```sh
command -v review
review version
review host --help
review host capabilities
```

These instructions describe the JSON host. Use the app built from the checkout
when testing an unreleased change, not another installed copy.

## `review: command not found`

Open Review Desktop, open the Command Palette, and run **Review: Install CLI in
PATH**. Review refreshes `~/.local/bin/review` and removes the obsolete
`/usr/local/bin/review` symlink if it exists. Then open a new terminal and check
that `~/.local/bin` is on `PATH`.

A separately installed CLI can install agent skills with `review install all`.
Skill installation does not configure an MCP server entry; see
[Coding agents](agents.md#connect-to-the-host).

## Old commands or a protocol mismatch

Check `command -v review` and `review version`. Another executable may be
shadowing the matching CLI. The CLI does not automatically delegate to an
installed app's CLI. Use the same version as Desktop.

Legacy commands such as `review scaffold`, `review publish` and
`review threads` are not the JSON host API. Use `review host command/query`
or the corresponding MCP tools. See the [API reference](cli-reference.md).

## Desktop is closed or the connection is rejected

Start the intended Desktop explicitly. For the installed application:

```sh
review app launch --json
review host connection
review host capabilities
```

For checkout development, follow the [build instructions](../apps/review-desktop/README.md).
Review-data commands require a healthy host; there is no offline file-editing
fallback. Discovery is private and host-specific. Do not copy tokens between
installations or expose `host.json`.

## A review is missing from Home

Query `reviews.list` and inspect any filters, repository selection or trash
state. New reviews require `repository.register` when the repository is not
registered, then `review.create`. Opening uses
`review host open --review <uuid>`.

Old file-based reviews are not imported into the JSON host. Their data is left
untouched; do not delete or rewrite it to make it appear in Home.

## A mutation or publication fails

Read the returned error code and diagnostics. Rejected commands leave the
previous document and checkpoints intact. Common causes include invalid node
shapes, duplicate or missing IDs, invalid source evidence, stale resource
references, and version conflicts. There is no MDX compile or per-review
`npm test` step.

After an uncertain response, retry the **same command ID and identical input**
to recover its receipt. After a genuine version conflict, refetch the current
state, reconcile your changes and use a new command ID. Do not blindly replace
other clients' work.

Accepted mutations are live changes. Publishing requires the current document
and review metadata versions and exact selected map-version IDs. Query
`checkpoints.list` to confirm a publication; a historical canvas intentionally
does not follow later live changes.

## The branch moved or source is unavailable

Bindings use exact commits and do not silently follow a moving branch.
`review.repin.plan` proposes a new binding and conservative anchor relocations;
inspect it before `review.repin.apply`. Ambiguous or deleted ranges must be
resolved explicitly. Revalidate the affected document and select maps for the
new pins before publishing another checkpoint.

Source queries are bound to the observed document version. Retained quotations
remain readable even if the local repository is unavailable, but opening other
source requires the corresponding local Git objects. Never substitute today's
working-tree contents for a pinned file.

## A map or image does not render

Read `canvas.reports` and the node's error. Resources are review-scoped and
referenced by exact IDs. Upload image bytes through `asset.upload`; do not use
external URLs or local file paths. Maps must match the document's exact binding.
Repinning does not make an old map a map of the new commits.

## Comments, feedback and Ask are unavailable

Comments, feedback submission and Ask are unavailable for JSON reviews in this authoring-only version. They are deferred to the third PR in this stack. This is an intentional version boundary, not a missing harness
installation. Do not use old file-backed commands or enable hooks to work
around it. The bundled tutorial's attached Ask flow remains a trusted legacy
exception and is not the JSON review authoring path.

## A coding agent is not detected

Make sure the agent is installed, then reopen Review's welcome screen. You can
install skills explicitly:

```sh
review install codex
review install claude
review install cursor
```

See [Coding agents](agents.md) for locations and MCP setup.

## An update failed

Review shows **Update failed** after reopening on the previous working build.
Background checks do not repeatedly download that same failed build. Choose
**Review → Check for Updates...** to retry manually.

If it fails again, quit Review, [download the installer](https://install.dev.fast),
and replace the installed app. Reinstalling the application does not remove
reviews or settings under `~/.dev`.

## Logs and bug reports

Open the Command Palette and run **Developer: Open Logs Folder** after
reproducing the problem. Logs can contain paths and extension output; inspect
and redact them before sharing.

Review's **Report bug** dialog shows its optional attachments before sending.
Read [Privacy](privacy.md#user-initiated-bug-reports), especially the distinction
between JSON reviews and legacy source/author-session attachments.

Use [GitHub Issues](https://github.com/devdotfast/review/issues) for reproducible
bugs and [Discord](https://discord.gg/wYvd2cpMQg) for setup help. For suspected
vulnerabilities, follow the
[security policy](https://github.com/devdotfast/review/blob/main/SECURITY.md).
Do not post secrets or exploit details publicly.
