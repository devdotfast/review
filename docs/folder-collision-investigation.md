# First-run folder collision investigation

Status: filesystem guard reproduced; production cause and implementation remain unresolved.

PostHog issue `01a0d49f-9dc7-7db1-87aa-60419d73d04d` contains one reported
exception on September 24, 2026 in Whiteboard 0.1.1. The message says an existing
path is not a directory. Both the path and its category are unavailable in the
redacted event. No user paths or telemetry identities are retained here.

The two bundle frames are `vs/review/review.desktop.main.js:1886:81871` and
`:1886:81605`. Comparing those positions against the installed 0.1.1 bundle
(commit `c14db218df246b305d1c2a391eb64435b902e83e`) identifies
`FileService.mkdirp` and `FileService.createFolder`. There is no calling feature
in the captured stack. The current source retains the same guard in
`apps/review-desktop/code-oss/src/vs/platform/files/common/fileService.ts`.

## Timeline

An analytics query of the same telemetry identity, restricted to 18:10–18:17 UTC,
returned this sequence. `review_client_error` and `$exception` are the paired
reports of the same exception, not two separate incidents.

| UTC time | Event |
| --- | --- |
| 18:13:39.031 | `review_installation_created` |
| 18:13:39.071 | `review_client_error`, folder collision |
| 18:13:39.093 | `$exception`, same folder collision |
| 18:13:39.116 | `review_home_empty_state_viewed` |
| 18:13:40.278 | `review_app_ready` |
| 18:14:00.119 / .125 | command started / succeeded |
| 18:16:15.706 / .752 | command started / succeeded |

This suggests a first-run startup operation. It does not establish that startup
failed: the ready event and successful commands follow. User-snippet initialization
is one startup caller of `createFolder`, but the evidence cannot distinguish it
from other callers or identify the colliding folder. Treating snippets, settings
import, or a cache as the proven cause would be speculative.

## Reproduction

From `apps/review-desktop` after installing workspace dependencies:

```sh
TSX_TSCONFIG_PATH=tsconfig.test.json node --import tsx scripts/repro-folder-collision.mjs
```

The harness calls the actual `FileService.createFolder` implementation through a
small provider backed by Node filesystem operations. It uses a fresh temporary
directory and removes only that fixture afterward. It verifies that:

- A regular file occupying the requested directory produces the reported error,
  keeps its bytes, and emits no successful create operation.
- An ancestor that is a file also rejects creation and preserves the file.
- Explicitly renaming the fixture file permits creation without losing its bytes.
- Calling creation on an existing directory succeeds.

All assertions passed on September 24, 2026 against base `cc43318e`, using an
isolated installation of tsx 4.21.0. This reproduces the low-level condition, not
the user's first-run sequence. No Electron build or end-to-end reproduction was
performed. This is a standalone investigation harness, not a test of a new fix.

## Why there is no production patch yet

Rejecting an existing regular file is correct and protects user data. Swallowing
the error, replacing the file, or choosing an arbitrary alternative directory
could break the feature or destroy data. Broad telemetry changes would not
resolve the unknown caller. Existing `createFolder` callers have different
recovery requirements, so a feature-specific fix needs the path category or a
caller stack first.

The next useful evidence is the calling feature and a safe category for the
colliding path (profile snippets, logs, configuration cache, or another location),
obtained from a local reproduction/debugger or a user-approved diagnostic.
Only then should recovery be implemented at that caller. Do not auto-delete or
overwrite the colliding file. Error-tracking issue APIs were unavailable with the
current key; permitted analytics SQL provided the frames and timeline above.

The workspace root and code-oss AGENTS.md instructions were read. The latter
references `.github/copilot-instructions.md`, which is absent from this checkout.
No README files were changed.
