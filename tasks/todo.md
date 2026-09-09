# Trace storage rewrite (feat/trace-storage-rewrite)

Plan: /Users/aiansiti/.claude/plans/witty-zooming-engelbart.md
Design: /Users/aiansiti/workable/trace-storage-design.md

## Commit 1: extract direct storage behind the interface
- [x] trace-storage/types.ts (TraceStorage interface, targets, publish input/result)
- [x] trace-storage/direct-config.ts (unified legacy resolver: env → file, AWS_* fallback, mock mode)
- [x] trace-storage/direct.ts (AWS CLI transport, by-session/by-commit layout, meta merge, doctor)
- [x] trace-storage/resolve.ts (direct-or-null resolver)
- [x] Rewire review-agent-traces.ts, trace-git-hook-runner.ts, trace-machine-setup.ts, review-api.ts
- [x] Existing suites pass; typecheck/lint/format clean

## Commit 2: v2 config, selection, migrate, storage commands
- [x] config.ts v2 schema + v1 consent read + atomic private write + concurrent-edit check
- [x] resolve.ts selection table
- [x] `review trace config migrate [--dry-run] [--json]`
- [x] `review trace storage use direct [--endpoint …]` (hosted branch lands in Commit 3)
- [x] `review trace status` mode/destination/sources
- [x] Setup writes to active source (v2 when fresh)
- [x] Tests per selection row, migrate cases, precedence

## Commit 3: hosted backend
- [x] Restore packages/trace-shared 0.2.0
- [x] Copy store-origin/store-client/transport/sync-status/provenance/repository-target
- [x] Consent module on the v2 file (trace-user-config.ts); store-auth kept whole
- [x] hosted.ts TraceStorage
- [x] Hook gates (consent + provenance), detached sync re-check
- [x] login/logout/whoami, onboard/allow/deny; hosted contract validation on switch
- [x] Tests

## Commit 4: reads, --storage override, product surfaces
- [x] Source identity in cache metadata (storage + contentId), per-store cache scope, offline/stale labels
- [x] --storage flag on list/show/pull/blame; /agent-traces?storage=
- [x] Desktop trace-source control + Agent Setup mode display
- [x] Docs, skill, telemetry vocabulary, protocol mirror

## Commit 5: validation evidence
- [x] MinIO upgrade gate (pre-upgrade CLI → new CLI, unchanged config, zero hosted requests)
- [x] Migration acceptance
- [x] Dev alpha-branch trace-api unit tests vs 0.2.0 tarball
- [x] Evidence doc; Review tests (1280), typecheck, lint, format, tutorial check pass. Desktop typecheck/tests need Code OSS node_modules (absent in this worktree); hosted CI covers them.
