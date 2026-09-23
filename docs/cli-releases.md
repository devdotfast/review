# Publishing the Review CLI

The `Review CLI Release` workflow publishes the public `@dev.fast/review` npm
package. The package contains `whiteboard server`, `whiteboard share`, `whiteboard trace`,
and the agent instructions. It runs independently of Desktop releases and requires
Node 24; building it does not install or launch Desktop.

## Release from GitHub

After this workflow reaches `main`:

1. Open the repository's **Actions** tab and select **Review CLI Release**.
2. Click **Run workflow**, select **main**, and choose **patch**, **minor**, or
   **major**. Check **dry_run** to rehearse without creating a tag or publishing.
3. Run it. The summary reports the version, source commit, and installation
   command. The tested npm tarball is retained as a workflow artifact.

GitHub provides the [manual workflow form](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow);
this workflow supplies the bump calculation.

The next version is calculated from the highest stable version among npm's
published versions, existing `review-vX.Y.Z` tags, and the source package version.
For example, from `0.2.10`:

| Selection | Next version |
| --------- | ------------ |
| patch     | `0.2.11`     |
| minor     | `0.3.0`      |
| major     | `1.0.0`      |

CLI tags use **`review-vX.Y.Z`**; Desktop tags keep **`vX.Y.Z`**. Prerelease tags
are not supported by this workflow. Releases always use a commit already on
`main`. A manual run uses the SHA selected when that run started, so a rerun
does not silently publish newer source.

Tags are the CLI release history. The workflow stamps the selected version
into the packed manifest and build metadata without committing
a version bump back to `main`. The source package version is a development
baseline, not the latest published version.

## Publish an explicit version tag

You can also tag an existing commit on `main` and push it:

```sh
git tag review-v0.3.0 <commit-on-main>
git push origin review-v0.3.0
```

That tag triggers the same build, clean-install smoke test, and publication.
Choose a stable version newer than every published stable version. The npm
`latest` tag advances only when publishing a new release.

The manual workflow reserves an annotated tag after validation, then publishes
in the same run. A tag pushed with `GITHUB_TOKEN` [does not trigger another workflow](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows),
so publication does not depend on a second tag event.

## Credentials and validation

Set the repository Actions secret **`NPM_TOKEN`** to an npm token permitted to
publish `@dev.fast/review` under the `@dev.fast` scope. For unattended publishing,
use a [granular token with bypass 2FA enabled](https://docs.npmjs.com/using-private-packages-in-a-ci-cd-workflow/).
Only the authentication and publishing steps receive the token. Dry runs do
not need it. The workflow also uses `GITHUB_TOKEN` to create the release tag and
GitHub OIDC to attach npm provenance; no release deploy key is needed.

Before publishing, the workflow tests release planning, trace behavior, and
headless authoring. It then builds one tarball, installs it in a temporary
prefix outside the workspace, and checks that its installed CLI can install
and remove agent hooks and commit a headless review without a display or Desktop.
The tarball includes the bundled product documentation.
The tested tarball is the one passed to `npm publish`.

The published `@dev.fast/review` package is the Node runtime shared by the CLI
and Desktop. Its production dependencies are declared directly in its manifest.
Workspace libraries and Git code that tsdown bundles are build dependencies.

The private `@dev.fast/review-canvas` workspace at `packages/review/app` owns
React, layout libraries, Vite, and browser tests. Desktop builds and copies that
canvas separately; the CLI neither builds nor ships it. Release packaging only
stamps metadata and stages docs; it never rewrites the dependency graph.

The clean-install check audits the entire production dependency tree and rejects
browser automation, Electron, TypeScript, and build/test tooling, including
transitive dependencies. Runtime dependencies such as the MCP SDK, Markdown
parsers, and Sharp (image validation, including native binaries) remain installed
normally.

## Retry a failed release

Use **Re-run all jobs** on the original run. If that run already reserved its
tag, it reuses the version. If npm already contains that version from the same
source commit, it reports success without republishing or moving `latest`.
A tag or npm version belonging to a different commit is an error; the workflow
never replaces it.

If publication failed after tag creation, rerun that run rather than starting a
new bump. Starting a fresh run treats the reserved tag as taken and computes the
next version. An explicitly pushed tag is retried by rerunning its workflow.

## Install and use in CI

```sh
npm install --global @dev.fast/review@<version>
whiteboard server start
```
