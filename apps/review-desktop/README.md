# Review Desktop

Review Desktop is the global Progressive Review UI. It uses a pinned Code OSS
fork for editor and language services. The fork is tracked in `code-oss/`, and
Review-owned workbench code lives directly in `code-oss/src/vs/review/`. See
[`UPSTREAM`](UPSTREAM) for provenance and the complete divergence inventory.

One desktop window owns one embedded global server. The app opens on Home with
no repository. It opens pinned review worktrees only when a review needs them.
Home scans `${DEV_REVIEW_HOME:-~/.dev}/reviews/*/review.json`; opening a review
creates an in-memory active session rooted at that review's repository, while
`review publish` validates and seals the revision in the CLI and asks the
desktop (via `/publish-ready`) to materialize it, mount it off-screen, and
promote it only when that mount is clean. Session URLs are routes on that global server; session-scoped
document caches, file watchers, and event clients do not bind their own ports
or create additional HTTP servers.

## Build and run

### Prerequisites

- Node for the monorepo: the version in the root `.nvmrc`.
- Node for the Code OSS fork: the exact version in `code-oss/.nvmrc`.
  Install `fnm` or `nvm` so the build scripts can switch automatically.
- pnpm: the version in the root `package.json` `packageManager` field.
- Python 3 and a C/C++ toolchain (Xcode Command Line Tools on macOS) for
  native module builds.
- On Linux: `libx11-dev libxkbfile-dev libkrb5-dev libsecret-1-dev`.
- `zstd` (only for the release payload handoff).

From the monorepo root:

```sh
pnpm install
pnpm desktop:build
pnpm desktop:run
```

### Fast development builds

`pnpm dev` sets `REVIEW_DESKTOP_DEV_FAST=1` for the build step. This mode
skips current Code OSS client and extension outputs. A stale client uses the
esbuild `transpile-client` path without a typecheck. A stale extension build
uses the existing Gulp extension tasks.

The freshness stamps are under `code-oss/.build/dev-fast`. The checks include
source files, source directories, build tools, and the dependency digest.
`run.sh` continues to build the Review server and canvas when they are stale.

Run `pnpm desktop:build` without the flag for a full compile and typecheck.

To reset generated Code OSS artifacts and the local Desktop profile, run this
from the monorepo root:

```sh
pnpm clean
```

This does not remove authored reviews in `${DEV_REVIEW_HOME:-~/.dev}/reviews`.

`desktop:run` takes no repository argument. Global user data and discovery live
under `${DEV_REVIEW_HOME:-~/.dev}/review-desktop/`; discovery is the private,
atomic `server.json`, and Code OSS profile state is under `state/`.

The released macOS app uses `review app launch` as its command-line entry.
The app-managed CLI removes `ELECTRON_RUN_AS_NODE` and starts its exact
`process.execPath`. Thus, the app can live outside `/Applications`. A
repository or standalone CLI asks macOS to open bundle identifier
`dev.fast.review`. The command checks `/health` for the matching instance and
an attached Desktop client before it reports readiness.
Tests can set `DEV_FAST_REVIEW_DESKTOP_STATE_ROOT` to keep the Code OSS profile
under an isolated directory.

Run `review app pick [--review <uuid>]` after publication. Bare `review app`
starts the app. `review info` and `review publish` do not start it.

Create and publish reviews independently from any worktree:

```sh
pnpm --filter @dev.fast/review review info
pnpm --filter @dev.fast/review review publish
```

Home lists review descriptors derived from `review.json`. Missing worktrees or
documents remain visible but disabled. Reopening creates a desktop-owned active
session; candidates never appear on Home.

## Packaging and releases

macOS arm64 is the only packaged platform with release channels; Linux has a
packaging script but no distribution. Signed builds auto-update from
`https://update.dev.fast` on either the `stable` or `preview` channel.

### Local packaging

```sh
SKIP_NOTARIZE=1 pnpm --filter @dev-fast/review-desktop app:package:macos
```

builds an unsigned `VSCode-darwin-arm64/Review.app` and skips
signing, notarization, and artifact creation. A full run needs the signing
environment and produces `dist/Review-darwin-arm64-<version>.zip` (the
Squirrel update payload) and the matching `.dmg`, both notarized and stapled:

- `CODESIGN_IDENTITY` — the Developer ID Application identity string.
- Keychain: `CODESIGN_KEYCHAIN` (explicit path), or `AGENT_TEMPDIRECTORY`
  pointing at a directory containing `buildagent.keychain` (the CI shape);
  leave both unset to use the login keychain.
- Notarization, first match wins: `NOTARY_KEYCHAIN_PROFILE` naming a stored
  `notarytool` profile (preferred locally — no credentials in the
  environment); `APPLE_API_KEY_PATH` + `APPLE_API_KEY_ID` +
  `APPLE_API_ISSUER_ID` for an App Store Connect team key (what CI sets); or
  `APPLE_ID` + `APPLE_TEAM_ID` + `APPLE_ID_PASSWORD`.

### Cutting a release

Run the **Review Desktop Release** workflow from the Actions tab (or
`gh workflow run review-desktop-release.yml -f bump=patch`) with a
patch/minor/major bump. The workflow:

1. bumps `apps/review-desktop/package.json`, commits `[skip ci]`, tags
   `vX.Y.Z`, and creates a draft GitHub release;
2. compiles the platform-independent Code OSS, Review canvas, Review server,
   workspace packages, and pinned `darwin-arm64` curated extensions on Linux,
   then uploads one `darwin-payload` artifact;
3. extracts that payload on `macos-15-xlarge`, performs only the native Darwin
   package assembly, stages the runtime, tools, and extensions, then signs and
   notarizes via `app:package:macos`;
4. gates the upload with `scripts/validate-release-artifacts.mjs` (curated
   extension closure, staple and Gatekeeper checks, and packaged `product.json`
   commit/quality/updateUrl assertions), which also emits the `latest.json`
   feed manifest;
5. uploads to R2 in two passes — zip and dmg payloads first, `latest.json`
   last — so a client can never see a manifest whose payload is missing;
6. curls the live feed to confirm the new release is served, attaches the dmg
   to the GitHub release, and publishes it.

### Preview builds

Run the **Review Desktop Preview** workflow from `main`, and pass the branch,
tag, or commit to build as its `ref` input:

```sh
gh workflow run review-desktop-preview.yml -f ref=<branch>
```

The workflow makes no commit, tag, or GitHub release. It stamps the working
tree with the next patch version plus
`-preview.<yyyymmdd>.<run-number>`, then publishes only to preview R2 keys.
The ref must include the preview tooling, so branch it from a `main` that
already contains this workflow and its scripts. Updates are keyed by commit;
publishing an older commit intentionally rolls preview installations back to
that build.

Install the latest preview from <https://install.dev.fast/preview>. It installs
as `Review Preview.app`, displays as `/dev/fast Review Preview`, and uses an
orange app-icon background so it stays visually distinct from stable in Finder,
the Dock, and the app switcher.

Preview uses its own bundle identifier, URL scheme, CLI name, and data folders,
so it can run beside stable without replacing the stable app or sharing its
settings. Preview updates continue to use the preview feed. To return to stable,
open the existing `Review.app` or install it from <https://install.dev.fast>.

Builds from before the preview identity split installed as `Review.app`.
Reinstall once from <https://install.dev.fast/preview> after the split so the
preview lands at the new application path; later preview updates retain it.

### Linux-to-macOS build handoff

The release is a split build. Linux is not only a cache warmer: it is the
authoritative producer for everything that does not require a Darwin host.
`scripts/compile-darwin-payload.sh` creates the archive, and
`REVIEW_DESKTOP_PRECOMPILED=1 scripts/package-macos.sh` consumes it.

| Produced on Linux and transferred | Produced or assembled on macOS |
| --- | --- |
| Code OSS `out-build`, `out-vscode-min`, and `out` | Electron application bundle |
| Compiled built-in extensions in `.build/extensions` | Darwin-native npm closure installed by `pnpm` |
| Manifest-selected `darwin-arm64` VSIX payloads, including `ty`, Ruff, and rust-analyzer | Manifest-selected extensions copied into the final app |
| Review canvas/server and required workspace `dist` directories | App icon, signatures, notarization, ZIP, and DMG |

The curated-extension handoff is manifest-driven. Linux materializes the
target variants, copies them into
`.build/review-curated-extensions/darwin-arm64`, and includes that directory in
the archive. macOS requires that directory before packaging and verifies every
manifest entry while copying it into the app. Release validation verifies the
same complete set again after notarization and before upload.

`scripts/darwin-payload-manifest.sh` is the source of truth for archive paths.
Its required paths must exist before macOS packaging starts. Its archive-only
paths are build intermediates that Gulp consumes without a direct wrapper check.

When a new packaged artifact bypasses the normal Gulp output, update all four
parts of the contract in the same change:

1. produce it in `build.sh` or `compile-darwin-payload.sh`;
2. add its repo-relative path to the required or archive-only manifest list;
3. stage required app content in `package-macos.sh` before signing;
4. assert it through an existing manifest-driven verifier or
   `packaged-runtime.test.mjs`, and repeat critical closure checks in
   `validate-release-artifacts.mjs` before upload.

### Install and update hosts

The update Worker serves both `install.dev.fast` and `update.dev.fast`
in front of a private R2 bucket. The routes are
disjoint, so both hostnames answer all of them and the Worker needs no
host discrimination; the two names exist to give humans and Squirrel separate
front doors.

`GET /` is the stable install landing: it redirects to the
`releases/latest/darwin-arm64/Review.dmg` alias, while `GET /preview` redirects
to `releases/preview-latest/darwin-arm64/Review.dmg`. For example,
`curl -fLOJ https://install.dev.fast` downloads the current disk image. It
deliberately does not read `latest.json` — the alias is uploaded with the
payloads, so the download keeps working while the manifest is mid-upload. The
keys stay version-free for that reason, so the version rides on each object's
`Content-Disposition` instead and the saved file names itself. Stable uses
`df-review-<version>.dmg`; preview uses
`df-review-preview-<preview-version>.dmg`. curl only honours that with `-J`; a
browser download always does.

```
update/stable/darwin-arm64/latest.json     current-release manifest
update/preview/darwin-arm64/latest.json    current-preview manifest
releases/<version>/darwin-arm64/           Review-darwin-arm64-<version>.zip + .dmg
releases/latest/darwin-arm64/Review.dmg    direct-download alias, saved as
                                           df-review-<version>.dmg
releases/preview-latest/darwin-arm64/Review.dmg
                                           preview-download alias, saved as
                                           df-review-preview-<preview-version>.dmg
```

`GET /api/update/:platform/:quality/:commit` answers 204 when the caller's
stamped commit matches the manifest (or no manifest exists yet) and Squirrel
JSON otherwise; `GET /releases/*` streams payloads. Because the feed keys its
answer off the caller's commit, the fork's `doDownloadUpdate` sends the
installed commit — not the target commit — when re-checking (see `UPSTREAM`).

### CI credentials

Repository secrets: `APPLE_CERT_BASE64`, `APPLE_CERT_PASSWORD`,
`APPLE_KEYCHAIN_PASSWORD`, `APPLE_API_KEY_P8`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`. Repository variables: `APPLE_SIGN_IDENTITY`,
`APPLE_TEAM_ID`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID`,
`R2_ENDPOINT_URL`, `R2_RELEASE_BUCKET`, `REVIEW_POSTHOG_KEY` (telemetry key
embedded into release builds; source builds embed none), and `SKIP_NOTARIZE`
(normally unset; set to `1` only to dry-run the workflow without signing).

Normal CI uses GitHub's standard Ubuntu runner. The manual release workflow
uses the `review_big_boy` larger runner. Its `review_release` runner group
allows `review-desktop-release.yml` and `review-desktop-preview.yml` from
`main`. The first stable or preview job also uses the `review-release`
environment, which requires repository-admin approval before downstream jobs
can use the release infrastructure. Adding the preview workflow requires a
repository admin to add `review-desktop-preview.yml @ main` to that runner
group's allowed-workflows list.

## Curated extensions

Review has a fixed extension catalog and no marketplace. Each VSIX has an exact
version, target, size, and SHA-256 hash in
`scripts/curated-extensions.manifest.mjs`. Nothing binary is committed.

### Bundled extensions

The build fetches bundled extensions from Open VSX. It checks each hash and
unpacks the extension into `code-oss/extensions/`.

| Extension | Notes |
| --- | --- |
| ty, ruff | Same; `ms-python.python` rides along as their extension dependency |
| Go | Bundles nothing and prompts to `go install gopls` against your own Go toolchain |
| Vim, Emacs | Adopted from the host VS Code install on first launch; otherwise off, and mutually exclusive |

### Optional extensions

Review downloads an optional group only after the user selects it in
**Manage Extensions...**. Review checks the downloaded VSIX before installation.
The application reloads once after a successful change.

| Group | Requirements |
| --- | --- |
| Rust | rust-analyzer includes its server. Rust moved from bundled to optional. |
| Swift | Install a Swift toolchain and expose `swift` on the shell `PATH`. The group includes LLDB DAP support. |
| C# | Install a system .NET SDK and expose `dotnet` on the shell `PATH`. Review does not download .NET. |

Review updates installed optional groups to the catalog pins in the background.
The update does not reload the window. A new pin takes effect on the next reload.

Install, enable, or disable them with **Manage Extensions...** from the command palette,
or from **Preferences ▸ Settings...** (⌘,). The choice persists per profile and
reloads the window, since extension enablement only applies when the extension
host restarts.

## Settings

**Preferences ▸ Settings...** (⌘,) opens the Settings tab. It is a canvas tab
like Home and Agent Setup, not the stock VS Code settings editor. It holds:

| Section | Setting |
| --- | --- |
| Privacy | Share anonymous usage data — see [docs/telemetry.md](../../docs/telemetry.md) |
| Editor | Theme, Keymap |
| Tools | Extensions |
| Experimental Features | Software Map, Trace capture |

Software Map defaults to off. Enable it to add the Map tab to reviews.
Disable it to remove Map entry points. This preference persists in the
application profile. The change does not require a reload.

Trace capture defaults to off and is not part of onboarding. Enabling it
takes R2 credentials, installs the agent session hooks and the
`trace-archaeology` skill for every installed agent, and lets reviews quote
agent sessions. Disabling removes the hooks and skill again. The state lives
in the review server's machine trace settings, not the application profile.

The application menu is macOS only. On Windows and Linux the same surfaces are
available from the command palette (`review.openSettings`).

## VS Code settings and keybindings

On first launch, Review adopts the default profile from the most recently
modified Code, Code - Insiders, VSCodium, or Cursor installation. It copies
`keybindings.json` byte-for-byte and imports user-facing settings such as
`editor.*`, `vim.*`, `emacs-mcx.*`, `files.*`, themes, and fonts. Review's
hardening, telemetry, update, extension, remote, and trust settings are never
imported.

If the selected install has VSCodeVim or Emacs MCX installed, Review records
`"review.keymap": "vim"` or `"emacs"` and enables the matching curated
extension on its one-time seed reload. **Manage Extensions...** keeps that
setting in sync with the picker.

The import is idempotent: `User/.review-import.json` records the source, and
pre-existing Review `keybindings.json` or `settings.json` files are never
overwritten automatically.
Run **Review: Import VS Code Settings and Keybindings...** from the command
palette for an explicit re-import; Review previews any files it would overwrite
and offers a reload afterward.

Set `DEV_REVIEW_IMPORT_FROM` to a VS Code-family configuration directory (or
its `User` directory) to choose a source. Set it to `none` to disable importing.

`DEV_REVIEW_EXTENSIONS` controls build-time materialization. `all` is the
default and includes only bundled groups. `none` downloads nothing. A
comma-separated list accepts `python,go,vim,emacs,rust,swift,csharp`. An
explicit optional group materializes its pinned VSIX files for development or
packaging checks. It does not install or enable that group for a user.

Language extensions activate when you open a file of that language.

Known limits:

- Only the default VS Code-family profile is imported.
- Imported bindings for commands Review does not register (for example Git,
  terminal, task, or debug commands) remain inert.
- The Review canvas is an iframe, so Vim and Emacs keymaps apply to workbench
  file, diff, and multi-diff editors, not the canvas's inline comment editors.

## Development and validation

Canvas changes need `pnpm --filter @dev.fast/review app:desktop:build` and a
window reload. For fork workbench changes, run the incremental compiler in a
separate terminal, edit under `code-oss/src/vs/review/`, then use **Developer:
Reload Window**:

```sh
pnpm desktop:watch
```

If `packages/review-protocol/src/index.ts` changes, regenerate the committed
fork copy and verify it has not drifted:

```sh
pnpm --filter @dev-fast/review-desktop protocol:sync
pnpm --filter @dev-fast/review-desktop test
```

Run Code OSS commands with npm from `code-oss/`, never with the monorepo's
pnpm.

Keep fork divergence enumerable as direct commits above the
`code-oss-upstream-8a7abeba` tag. Every upstream exclusion or intentional edit
must be recorded in `UPSTREAM`, and `src/vs/review/` tests must pass both the
fast monorepo tier and the Code OSS test harness.

### The main-process pre-bootstrap window

`code-oss/src/main.ts` runs in the Electron main process before anything else.
Its `startup()` calls `bootstrapESM()` — which installs
`globalThis._VSCODE_NLS_MESSAGES` — and only then dynamically imports
`vs/code/electron-main/main.js`. Every *static* import at the top of `main.ts`,
and everything those pull in transitively, is evaluated before that message
table exists.

In a packaged build the NLS mangler rewrites `localize('someKey', "Text")` into
`localize(2488, null)`, and `vs/nls.ts` throws `!!! NLS MISSING: 2488 !!!` when
index 2488 is absent. Thrown there, Electron shows a modal that blocks the main
thread before any window, renderer, or log file exists: the app never starts and
leaves no trace to debug. **This is invisible from sources** — running from
`out/` keeps NLS keys as strings and `localize` returns the English fallback, so
`pnpm dev` can neither reproduce nor refute it. Review Desktop 0.0.4 shipped
exactly this and could not launch at all.

The usual way in is a configuration registry. Importing
`vs/platform/configuration/common/configurationRegistry.js` is by itself fatal:
it runs `new ConfigurationRegistry()` at module scope, and that constructor
localizes. Deleting the `registerConfiguration` calls from a module while
keeping a value import of `Extensions` or `ConfigurationScope` does not help —
the import edge has to be severed.

So, for anything `src/main.ts` can reach — in practice `vs/review/node/**` and
`vs/review/electron-main/**`:

- Do not import `vs/nls.js`, `vs/platform/registry/common/platform.js`, or
  `vs/platform/configuration/common/configurationRegistry.js`, directly or
  transitively.
- Keep shared data in import-free modules. Setting keys and default values live
  in `vs/review/common/reviewConfigurationDefaults.ts`, which imports nothing;
  `vs/review/common/reviewConfiguration.ts` imports it and owns the registry
  calls. Never re-export the data back through the registration module — that
  would put the registry back on the main process's import path.
- Anything that genuinely needs the registry belongs behind the dynamic import
  in `startup()`, or in the renderer.

`scripts/main-bootstrap-imports.test.mjs` walks the static import graph from
`main.ts` and fails on a violation, printing the offending chain. It runs in the
monorepo test tier and takes about a second, so run it before packaging rather
than discovering this from a dead `.app` bundle.

Signing and notarization say nothing about whether the app runs, so
`scripts/smoke-launch-packaged.mjs` launches the packaged bundle and requires a
renderer process and the embedded Review server ready event to appear. Smoke
failures include the captured main log. The release workflow runs it after
`validate-release-artifacts.mjs` and before the R2 upload. Point it at a local
bundle with `--app` when packaging by hand.
