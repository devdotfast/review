# Worktree-first review targets

This replaces the pinned-source default proposed in #331. This first delivery requires
`base` for worktree targets. The optional worktree base described below is enabled
in the stacked second delivery. Source targets are
explicit; a saved **snapshot** remains the name for a version of the review
*document*, not a third source target.

```ts
type ReviewTarget =
  | { kind: "worktree"; repositoryId: string; base?: string }
  | { kind: "commits"; repositoryId: string; head: string; base?: string };
```

`repositoryId` identifies one registered local checkout. Worktree targets reuse
that checkout without preparation. Commit targets use Review-owned checkouts at
their resolved commits, prepared through the existing `devfast.prepare` Git config.
There is no separate environment-selection field or automatic repository selection.

| Target | Source | Comparison |
| --- | --- | --- |
| `worktree`, no base | Saved working files, including nonignored untracked files | Current HEAD to working files; empty baseline for unborn repositories |
| `worktree`, base | Saved working files | Resolved base commit to working files |
| `commits`, no base | Resolved head commit | None; equivalent to base=head |
| `commits`, base | Resolved commits | Exact base to head comparison |

Omitting a commit base does **not** infer its parent. To review changes introduced
by one commit, supply its parent as base. Explicit equal base/head remains valid.
Supplied revisions are resolved on command acceptance. Idempotent retries return
the original result even after a branch moves.

## Delivery phases

1. Restore prepared base/head environments for the existing JSON pins API (#332).
2. Restore working-file source and native local LSP through the JSON API (#335). Keep
   explicit committed targets and compatibility adapters for `pins` / `repin`.
   Retargeting preserves content and component IDs and returns repair warnings.
3. Support a whole worktree without base (#333), including clean and unborn repositories.
   Retain source generations independently of authored history; carry generations
   through source trees, peeks, full files, diffs and language-service requests.

The live-target phases use `review_create({commandId,title,target})` and
`review_set_target({commandId,reviewId,target})`. Existing records remain committed
reviews until explicitly retargeted. No migration rewrites historical versions.

## Source and language semantics

Worktree means saved filesystem bytes, including staged and unstaged changes.
Unsaved editor buffers are not captured. Native models provide normal project
language services for the live head; retained source uses conservative unchanged
line mapping when borrowing local language services. Edited/deleted ranges are
marked stale instead of clamped to unrelated code. Source context appears once.

Filesystem watchers cover the chosen checkout and Git metadata. Reopening or
restarting refreshes that checkout. It never switches directories to find a SHA.
Missing checkout context reports unavailability and retries when it returns.

Each source generation retains dirty bytes in the local resource store and uses
immutable Git objects for unchanged files. It does not write the user's index,
create synthetic commits, or copy checkout directories. Saved document versions
retain their generation. Filesystem updates notify viewers without adding document
versions. Requests carrying a generation read a consistent set of files and diffs;
explicit version reads use that version's retained source. File metadata caches
avoid rereading unchanged files on every save.

## Sharing integration boundary

Sharing implementation is still uncommitted in the separate `review-sharing-plan`
checkout. This change does not copy or mutate that work. Its exporter already
freezes a store read before calling `LocalReviewData.file/changes/commits`; those
methods now resolve retained generations, so export can freeze working bytes too.

When integrating that branch:

- Allow `target` and retained-source metadata in the saved-document schema. The
  existing strict importer currently accepts only commit-shaped pins; that needs
  updating before worktree reviews can be imported.
- Export all displayed source bytes into the immutable share package, including
  clean files backed by Git objects. Do not require recipients to have those Git
  objects or a local generation resource.
- Local LSP attachment must remain separate from displayed shared bytes. The
  branch's current native-file substitution must not make a share live.
- Prefer an explicitly selected, saved, or registered checkout. A unique known
  repository-identity match may be offered; ambiguous matches require selection.
  Missing checkout means unavailable/reconnect, not automatic cloning.
- Add sharing E2E for dirty-source export, offline import, and language attachment
  after the chosen checkout changes. These tests belong with that branch's
  importer and attachment implementation.

Commit targets automatically acquire matching prepared checkouts on open or language access.
Worktree targets, including their base side and retained versions, never do.
Historical worktree queries can therefore reflect current project semantics;
line mapping protects positions rather than reproducing historical dependencies.
Preparation status, logs, and retry are local state, excluded from shared documents.

## Validation

The native Desktop LSP E2E uses bundled TypeScript and Python language servers,
JSON-created reviews, an isolated profile and source repositories. It covers live
and committed reviews, both diff sides, inline navigation, installed dependencies,
source changes, stale mapping, multiple repositories, missing checkout recovery,
and restart. API behavior tests cover omitted base, immutable generations,
idempotency, source-range repair, unborn repositories, and symlink boundaries.
