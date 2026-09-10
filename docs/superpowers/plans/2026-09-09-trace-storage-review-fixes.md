# Trace Storage Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply every verified finding from the 2026-09-09 three-reviewer code review of the hosted trace store, on the Review side (PR devdotfast/review#207) and on the Dev side (Fix-Fast/dev branch `fix/hosted-traces-alpha`), without changing behavior for existing S3/R2 bucket users.

**Architecture:** Two independent parts. Part A runs in the Review worktree and fixes the client, the Desktop surfaces, and the shared contract package `@dev.fast/trace-shared` (0.2.0, unpublished, so contract changes need no version bump). Part B runs in the Dev worktree and fixes the server against the contract that Part A packs into a tarball. Part A must finish before Part B starts because B installs A's tarball.

**Tech Stack:** TypeScript, vitest (shared module graph, `isolate: false` on Review), zod 4, Hono (Review API), Cloudflare Workers + D1 + drizzle (Dev), pnpm workspaces.

**Spec:** The review report delivered in the session on 2026-09-09 (this plan restates each finding at its task). Design context: `/Users/aiansiti/workable/trace-storage-design.md` and `docs/superpowers/plans/2026-09-09-trace-storage-upgrade-gate.md` (Review worktree).

## Global Constraints

- **Worktrees.** Part A: `/Users/aiansiti/workable/review-trace-storage`, branch `feat/trace-storage-rewrite`. Part B: `/Users/aiansiti/workable/dev-hosted-traces`, branch `fix/hosted-traces-alpha`. Never touch `/Users/aiansiti/workable/review` or `/Users/aiansiti/workable/dev`. Do not switch worktrees inside one session: run Part A in one session and Part B in another.
- **Commits.** No `Co-Authored-By` lines. Review commit messages are plain sentences ("Propagate hosted refusals instead of serving another store's copy"). Dev commit messages use the conventional prefix `fix(review-web): ...` / `feat(review-web): ...` / `docs(review-web): ...`.
- **Bucket compatibility.** Nothing in Part A may change the S3/R2 object layout, credential precedence, legacy `~/.config/dev-trace` handling, or `TRACE_R2_MODE=mock`. `pnpm --filter @dev.fast/review test` must stay at 100% pass.
- **Review test invocation.** Always run Review tests with `GITHUB_REPOSITORY=devdotfast/review` exported (CI exports it; vitest clears it, but exporting proves the clearing works): `GITHUB_REPOSITORY=devdotfast/review pnpm --filter @dev.fast/review test -- <file>`. Single files: `pnpm --filter @dev.fast/review exec vitest run <path relative to packages/progressive-review>`.
- **Review lint.** The anti-slop lint rejects conditional object spreads, `unknown`/`object` parameter types where a real type exists, `typeof x === "object"` guards, unsorted imports, and names containing "shape". Run `pnpm -w lint`, `pnpm -w format:check`, and `pnpm --filter @dev.fast/review typecheck` before every commit. Format with `pnpm -w format` if the check fails.
- **Shell.** `ls` is aliased to `exa`; use `command ls`. `grep` is `ugrep`; quote globs. BSD `sed` has no `\b`; use `perl -pi -e` for word-boundary edits.
- **Dev tests.** `pnpm --filter @dev-fast/review-web test` (unit), `pnpm --filter @dev-fast/review-web test:worker` (D1 worker tests, applies `drizzle/migrations`), `pnpm --filter @dev-fast/review-web typecheck`. The Dev worktree has an uncommitted, deliberate override in `pnpm-workspace.yaml` and `pnpm-lock.yaml` pointing `@dev.fast/trace-shared` at a local tarball. Never commit those two files. Never remove the override.
- **Vocabulary.** User-facing word is `s3`, never `direct`.
- **Protocol mirror.** After any change to `packages/review-protocol/src/contracts.ts`, run `pnpm --filter @dev.fast/review-desktop protocol:sync` and commit the regenerated `apps/review-desktop/code-oss/src/vs/review/common/reviewProtocol.ts`.

---

# Part A: Review (`/Users/aiansiti/workable/review-trace-storage`)

Before Task A1: `git status` must be clean and `git log --oneline -1` must show `5385b1b7` or a descendant. Run `pnpm install` once.

### Task A1: Extend the shared contract (`@dev.fast/trace-shared`)

Every later client and server task reads these schemas. All additions are optional fields, so an unmodified server still validates.

**Files:**

- Modify: `packages/trace-shared/src/store-api.ts`
- Test: `packages/trace-shared/src/store-api.test.ts`

**Interfaces:**

- Produces: `storeResponseSchema.bytesStored?: number`; `completeUploadRequestSchema.branch?: string | null`, `.author?: string | null`; `sessionDownloadSchema.branch?: string | null`, `.author?: string | null`; `listSessionsQuerySchema.limit?: number` (1..200), `.cursor?: sessionId`; `listSessionsResponseSchema.nextCursor?: sessionId`; constant `MAX_TRACE_SESSIONS_PAGE = 200`, `DEFAULT_TRACE_SESSIONS_PAGE = 100`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/trace-shared/src/store-api.test.ts` inside the `describe("store-api contracts")` block:

```ts
it("accepts the optional byte counter on a store", () => {
  const base = {
    repositoryId: 1,
    storeId: id,
    displayName: "acme/app",
    status: "active",
    createdAt: "2026-09-01T00:00:00.000Z",
  };
  expect(storeResponseSchema.safeParse(base).success).toBe(true);
  expect(
    storeResponseSchema.safeParse({ ...base, bytesStored: 12 }).success,
  ).toBe(true);
  expect(
    storeResponseSchema.safeParse({ ...base, bytesStored: -1 }).success,
  ).toBe(false);
});

it("carries optional branch and author through completion and listing", () => {
  expect(
    completeUploadRequestSchema.safeParse({
      commits: [],
      branch: "main",
      author: "dev@example.test",
    }).success,
  ).toBe(true);
  expect(
    completeUploadRequestSchema.safeParse({ commits: [], branch: null })
      .success,
  ).toBe(true);
  expect(
    completeUploadRequestSchema.safeParse({
      commits: [],
      branch: "x".repeat(201),
    }).success,
  ).toBe(false);
  const session = {
    sessionId: "session-0001",
    harness: "claude",
    uploadId: id,
    generation: 1,
    updatedAt: "2026-09-01T00:00:00.000Z",
    commits: [],
    objects: [],
  };
  expect(sessionDownloadSchema.safeParse(session).success).toBe(true);
  expect(
    sessionDownloadSchema.safeParse({
      ...session,
      branch: "main",
      author: null,
    }).success,
  ).toBe(true);
});

it("pages the session listing with a bounded limit and a session cursor", () => {
  expect(
    listSessionsQuerySchema.safeParse({ commit: sha.slice(0, 40) }).success,
  ).toBe(true);
  expect(
    listSessionsQuerySchema.safeParse({
      commit: sha.slice(0, 40),
      limit: "50",
      cursor: "session-0009",
    }).success,
  ).toBe(true);
  expect(
    listSessionsQuerySchema.safeParse({ commit: sha.slice(0, 40), limit: "0" })
      .success,
  ).toBe(false);
  expect(
    listSessionsQuerySchema.safeParse({
      commit: sha.slice(0, 40),
      limit: String(MAX_TRACE_SESSIONS_PAGE + 1),
    }).success,
  ).toBe(false);
  expect(
    listSessionsResponseSchema.safeParse({
      sessions: [],
      nextCursor: "session-0009",
    }).success,
  ).toBe(true);
});
```

Add `MAX_TRACE_SESSIONS_PAGE`, `listSessionsQuerySchema`, `listSessionsResponseSchema`, `sessionDownloadSchema`, `storeResponseSchema` to the import list at the top of the test.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @dev.fast/trace-shared test`
Expected: FAIL (the new imports are undefined or the schemas reject the new fields).

- [ ] **Step 3: Implement the schema additions**

In `packages/trace-shared/src/store-api.ts`:

After `MAX_TRACE_METADATA_BODY_BYTES` add:

```ts
/** Most sessions one listing page returns. */
export const MAX_TRACE_SESSIONS_PAGE = 200;
/** Sessions per page when the client names no limit. */
export const DEFAULT_TRACE_SESSIONS_PAGE = 100;

/** A branch or author label a client attaches to a publication. */
const sessionLabelSchema = z.string().max(200).nullable();
```

In `storeResponseSchema`, after `created: z.boolean().optional(),` add:

```ts
  /** Bytes of every completed upload in this store instance. Absent from older servers. */
  bytesStored: z.number().int().nonnegative().optional(),
```

In `completeUploadRequestSchema`, after the `commits` field add:

```ts
  /** The checkout branch and author at publication, kept with the upload. */
  branch: sessionLabelSchema.optional(),
  author: sessionLabelSchema.optional(),
```

Replace `listSessionsQuerySchema` with:

```ts
export const listSessionsQuerySchema = z
  .object({
    commit: commitShaSchema.optional(),
    session: sessionIdSchema.optional(),
    /** Page size; the server caps it at MAX_TRACE_SESSIONS_PAGE. */
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_TRACE_SESSIONS_PAGE)
      .optional(),
    /** The last session id of the previous page. */
    cursor: sessionIdSchema.optional(),
  })
  .refine((q) => q.commit !== undefined || q.session !== undefined, {
    message: "commit or session is required",
  });
```

In `sessionDownloadSchema`, after `commits: z.array(commitShaSchema),` add:

```ts
  branch: sessionLabelSchema.optional(),
  author: sessionLabelSchema.optional(),
```

Replace `listSessionsResponseSchema` with:

```ts
export const listSessionsResponseSchema = z.object({
  sessions: z.array(sessionDownloadSchema),
  /** Present when another page follows; pass it back as `cursor`. */
  nextCursor: sessionIdSchema.optional(),
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @dev.fast/trace-shared test`
Expected: PASS.

- [ ] **Step 5: Build and commit**

```bash
pnpm --filter @dev.fast/trace-shared build
pnpm -w lint && pnpm -w format:check
git add packages/trace-shared
git commit -m "Add byte counter, labels, and listing pages to the trace store contract"
```

---

### Task A2: Surface hosted refusals and read-override failures instead of serving another store's copy

Findings: a `forbidden`/`store_deleted` answer at target resolution became `null` storage, and `null` storage made `findNormalizedTraceFile` return any store's cached copy labeled `current`; `?storage=hosted` with no login did the same through the Desktop; a malformed config reached the UI as "not configured"; `?storage=` accepted any value; the list route collapsed denied and unavailable.

**Files:**

- Modify: `packages/progressive-review/src/trace-storage/hosted.ts` (the `catch` at the end of `resolve`, read branch)
- Modify: `packages/progressive-review/src/review-agent-traces.ts` (`reachable`, `findNormalizedTraceFile`)
- Modify: `packages/progressive-review/src/server/review-api.ts` (`traceStorageOverride`, `resolveTraceStorageFor`, `agentTraces`, `agentTraceDetail`)
- Modify: `packages/review-protocol/src/contracts.ts` (`ReviewAgentTraceListResponseSchema`)
- Modify: `packages/progressive-review/app/src/ReviewTraceView.tsx` (list state, unconfigured block)
- Modify: `packages/progressive-review/src/trace-storage/hosted.test.ts`
- Create: `packages/progressive-review/src/server/review-api-traces.test.ts`
- Regenerate: `apps/review-desktop/code-oss/src/vs/review/common/reviewProtocol.ts`

**Interfaces:**

- Produces: `HostedTraceStorage.resolve` (read) throws `TraceStorageDeniedError` for `forbidden` and `store_deleted`; `resolveTraceStorage` propagates it. List response gains `storageError?: string`. `?storage=` with an unknown value answers 400.

- [ ] **Step 1: Write the failing hosted test**

Append to `packages/progressive-review/src/trace-storage/hosted.test.ts` inside the describe block:

```ts
it("reports a refusal at target resolution instead of serving another copy", async () => {
  // A hosted copy saved earlier, under this origin and repository.
  const sessionId = "hosted-session-0008";
  const transport = createMemoryTraceStoreTransport();
  const first = HostedTraceStorage.fromParts({
    target: target(transport.storeId),
    transport,
    devHome,
  });
  seedMemoryTraceSession(transport, {
    repositoryId: REPOSITORY_ID,
    sessionId,
    traces: { "main.jsonl.gz": `${sessionRecord(sessionId, "cached")}\n` },
  });
  expect(
    await loadReviewAgentTrace({ sessionId, cwd: repoDir, storage: first }),
  ).not.toBeNull();

  // Access is revoked: findStore answers forbidden.
  writeConfig({ version: 2, "current-store": "hosted" });
  clearTraceEnvCache();
  await writeStoreAuth(
    {
      origin: ORIGIN,
      token: "t",
      login: "dev",
      savedAt: "2026-09-02T00:00:00Z",
    },
    process.env,
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        {
          error: {
            code: "forbidden",
            message: "You cannot use this repository.",
          },
        },
        { status: 403 },
      ),
    ),
  );
  await expect(
    resolveTraceStorage({ cwd: repoDir, onWarning: () => undefined }),
  ).rejects.toBeInstanceOf(TraceStorageDeniedError);
  // The saved copy is not served through a null storage either.
  await expect(
    loadReviewAgentTrace({ sessionId, cwd: repoDir }),
  ).rejects.toBeInstanceOf(TraceStorageDeniedError);
});
```

Add `import { TraceStorageDeniedError } from "./types";` to the test imports.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @dev.fast/review exec vitest run src/trace-storage/hosted.test.ts -t "refusal at target"`
Expected: FAIL: `resolveTraceStorage` resolves to `null` instead of rejecting.

- [ ] **Step 3: Throw the refusal from `HostedTraceStorage.resolve`**

In `packages/progressive-review/src/trace-storage/hosted.ts`, replace the final `catch` of the read branch of `resolve` (the block starting `} catch (error) {` after `return new HostedTraceStorage({ target, ... offline ...})`) with:

```ts
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      if (
        cause instanceof StoreApiError &&
        (cause.code === "forbidden" || cause.code === "store_deleted")
      ) {
        // The store answered and refused. Nothing saved may pass as current.
        throw new TraceStorageDeniedError(cause.message);
      }
      // A missing store is a setup problem the user can fix, so it is named.
      const message =
        cause instanceof StoreApiError && cause.code === "not_found"
          ? cause.message
          : storeReadWarning(cause);
      if (message) report(message);
      return null;
    }
```

- [ ] **Step 4: Stop `reachable` from swallowing denials, and refuse cross-store cache reads without a storage**

In `packages/progressive-review/src/review-agent-traces.ts` replace `reachable`:

```ts
/**
 * A remote lookup, or null when the store could not be reached. A refusal
 * propagates: the caller must show nothing, not "nothing here".
 */
async function reachable<T>(lookup: () => Promise<T>): Promise<T | null> {
  try {
    return await lookup();
  } catch (error) {
    if (error instanceof TraceStorageUnavailableError) return null;
    throw error;
  }
}
```

In `findNormalizedTraceFile`, the `!storage` branch stays (a machine with no store at all may read every saved copy). No change there; the fix is that a refusal now never yields `null` storage.

- [ ] **Step 5: Run the hosted test file**

Run: `pnpm --filter @dev.fast/review exec vitest run src/trace-storage/hosted.test.ts`
Expected: PASS for all tests, including the new one.

- [ ] **Step 6: Add `storageError` to the protocol and regenerate the mirror**

In `packages/review-protocol/src/contracts.ts`, in `ReviewAgentTraceListResponseSchema`'s `ok: true` object, after `sources: ...optional(),` add:

```ts
    // Why the selected store answered nothing: a refusal, a missing login
    // for a requested source, or a malformed config. Absent from older CLIs.
    storageError: requiredString.optional(),
```

Run: `pnpm --filter @dev.fast/review-protocol build && pnpm --filter @dev.fast/review-desktop protocol:sync`

- [ ] **Step 7: Write the failing API route test**

Create `packages/progressive-review/src/server/review-api-traces.test.ts`:

```ts
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearTraceEnvCache } from "../review-agent-traces";
import { createReviewDir } from "../review-home";
import { traceConfigPath } from "../trace-storage/config";
import { createReviewApi } from "./review-api";

const execFilePromise = promisify(execFile);

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFilePromise("git", ["-C", root, ...args], {
    encoding: "utf8",
  });
  return stdout.trim();
}

describe("agent trace routes", () => {
  let home: string;
  let root: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "review-api-traces-home-"));
    root = await mkdtemp(path.join(os.tmpdir(), "review-api-traces-repo-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);
    vi.stubEnv("REVIEW_TEST_TRACE_SEARCH_DIR", path.join(home, "trace-search"));
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.email", "review@example.test"]);
    await git(root, ["config", "user.name", "Review Test"]);
    await git(root, ["remote", "add", "origin", "git@github.com:acme/app.git"]);
    await writeFile(path.join(root, "README.md"), "# Review\n", "utf8");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "initial"]);
    clearTraceEnvCache();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    clearTraceEnvCache();
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });

  async function writeTraceConfig(value: object): Promise<void> {
    const filePath = traceConfigPath({ devHome: home });
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify(value), "utf8");
    clearTraceEnvCache();
  }

  async function api() {
    const commit = await git(root, ["rev-parse", "HEAD"]);
    const created = await createReviewDir({
      worktreePath: root,
      baseRef: "main",
      baseCommit: commit,
      sourceCommit: commit,
    });
    const reviewPath = path.join(created.dir, "review.mdx");
    await writeFile(reviewPath, "# Review\n", "utf8");
    return createReviewApi({
      reviewPath,
      stateReviewPath: reviewPath,
      reviewRootPath: created.dir,
      reviewDocumentsDir: created.dir,
      rootPath: root,
      toolingRoot: root,
      reviewToken: "test",
      session: {
        rootPath: root,
        baseRef: "main",
        appUrl: "http://localhost:4000",
        reviewPath,
        startedAt: 1,
        agent: { harness: "claude-code", sessionId: "author" },
      },
      agentServer: () => {
        throw new Error("no agent server in this test");
      },
      openNativeAgentTerminal: async () => undefined,
    });
  }

  it("rejects an unknown ?storage= value", async () => {
    const response = await (
      await api()
    ).app.request("/agent-traces?storage=direct");
    expect(response.status).toBe(400);
  });

  it("names a missing login when the hosted source is requested", async () => {
    await writeTraceConfig({ version: 2, "current-store": "hosted" });
    const response = await (
      await api()
    ).app.request("/agent-traces?storage=hosted");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      storage: "hosted",
      sessions: [],
      storageError: expect.stringContaining("review login"),
    });
  });

  it("names a malformed config instead of calling it unconfigured", async () => {
    await writeTraceConfig({
      version: 2,
      stores: {
        s3: {
          endpoint: "https://s3.example.invalid",
          bucket: "b",
          accessKeyId: "k",
          secretAccessKey: "s",
        },
        hosted: {},
      },
    });
    const response = await (await api()).app.request("/agent-traces");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      configured: false,
      sessions: [],
      storageError: expect.stringContaining("current-store"),
    });
  });

  it("reports a refusal on the detail route as not found with the reason", async () => {
    await writeTraceConfig({ version: 2, "current-store": "hosted" });
    const { writeStoreAuth } = await import("../store-auth");
    await writeStoreAuth(
      {
        origin: "https://app.dev.fast",
        token: "t",
        login: "dev",
        savedAt: "2026-09-02T00:00:00Z",
      },
      process.env,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: {
              code: "forbidden",
              message: "You cannot use this repository.",
            },
          },
          { status: 403 },
        ),
      ),
    );
    const response = await (
      await api()
    ).app.request("/agent-traces/hosted-session-0001");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: expect.stringContaining("cannot use this repository"),
    });
  });
});
```

If `createReviewApi` needs a `reviewToken` or `toolingRoot` of a different type, copy the exact option set from `packages/progressive-review/src/server/review-agent-flow.test.ts` lines 122-141 and keep `reviewRootPath: created.dir`.

- [ ] **Step 8: Run it to verify it fails**

Run: `pnpm --filter @dev.fast/review exec vitest run src/server/review-api-traces.test.ts`
Expected: FAIL: the unknown value answers 200, `storageError` is missing, the refusal answers 500.

- [ ] **Step 9: Implement the route changes**

In `packages/progressive-review/src/server/review-api.ts`:

Add to the imports from `../trace-storage/types`: `TraceStorageDeniedError` (a value import, alongside the type imports). Add `import { TraceConfigurationError } from "../trace-storage/config";` if not already imported.

Replace `traceStorageOverride` and `resolveTraceStorageFor` with:

```ts
type TraceStorageOverride =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "override"; storage: TraceStorageKind };

/** The `?storage=` read override; invalid names never fall back silently. */
function traceStorageOverride(
  context: Context<ReviewHonoEnv>,
): TraceStorageOverride {
  const value = new URL(context.req.url).searchParams.get("storage");
  if (value === null) return { kind: "none" };
  if (value === "s3" || value === "hosted") {
    return { kind: "override", storage: value };
  }
  return { kind: "invalid" };
}

type TraceStorageResolution =
  | { storage: TraceStorage | null | undefined; error: null }
  | { storage: null; error: string };

/**
 * The store a trace request reads from: the override when one is named,
 * otherwise the machine's selection (undefined lets shared code resolve
 * it). A refusal, a missing login for a requested source, or a malformed
 * config is returned as a message instead of thrown.
 */
async function resolveTraceStorageFor(
  context: Context<ReviewHonoEnv>,
  cwd: string,
): Promise<TraceStorageResolution> {
  const override = traceStorageOverride(context);
  const selection = selectTraceStorage();
  if (selection.error) return { storage: null, error: selection.error };
  try {
    if (override.kind !== "override") {
      const storage = await resolveTraceStorage({ cwd });
      return { storage, error: null };
    }
    const storage = await resolveTraceStorage({
      cwd,
      override: override.storage,
    });
    if (!storage && override.storage === "hosted") {
      return {
        storage: null,
        error:
          "The hosted trace store has no login on this machine. Run `review login` and open the review again.",
      };
    }
    return { storage, error: null };
  } catch (error) {
    if (
      error instanceof TraceStorageDeniedError ||
      error instanceof TraceConfigurationError
    ) {
      return { storage: null, error: error.message };
    }
    throw error;
  }
}
```

Replace the body of `agentTraces` with:

```ts
const override = traceStorageOverride(context);
if (override.kind === "invalid") {
  return reviewApiJsonResponse(400, {
    ok: false,
    error: "storage must be s3 or hosted.",
  });
}
const review = readReviewStoreRecord(reviewRootPath);
const repoRootPath = resolveReviewRepoRootFromStore(reviewRootPath, review);
const headCommit = review.sourceCommit ?? review.baseCommit;
const selection = selectTraceStorage();
const sources: TraceStorageKind[] = [];
if (selection.s3?.credentials || isS3MockMode()) {
  sources.push("s3");
}
if (selection.hosted) sources.push("hosted");
const resolved = await resolveTraceStorageFor(context, repoRootPath);
const storage =
  override.kind === "override" ? override.storage : selection.mode;
if (resolved.error !== null) {
  return reviewApiJsonResponse(200, {
    ok: true,
    configured: isTraceR2Configured(),
    storage,
    sources,
    storageError: resolved.error,
    sessions: [],
  });
}
let sessions: Awaited<ReturnType<typeof listReviewTraceSessions>>;
try {
  sessions = await listReviewTraceSessions({
    rootPath: repoRootPath,
    baseCommit: review.baseCommit,
    headCommit,
    storage: resolved.storage,
  });
} catch (error) {
  if (!(error instanceof TraceStorageDeniedError)) throw error;
  return reviewApiJsonResponse(200, {
    ok: true,
    configured: isTraceR2Configured(),
    storage,
    sources,
    storageError: error.message,
    sessions: [],
  });
}
return reviewApiJsonResponse(200, {
  ok: true,
  configured: isTraceR2Configured(),
  storage,
  sources,
  sessions,
});
```

In `agentTraceDetail`, replace the block from `const repoRootPath = ...` through `if (!loaded) {...}` with:

```ts
const override = traceStorageOverride(context);
if (override.kind === "invalid") {
  return reviewApiJsonResponse(400, {
    ok: false,
    error: "storage must be s3 or hosted.",
  });
}
const repoRootPath = resolveReviewRepoRootFromStore(reviewRootPath);
const resolved = await resolveTraceStorageFor(context, repoRootPath);
if (resolved.error !== null) {
  return reviewApiJsonResponse(404, { ok: false, error: resolved.error });
}
let loaded: Awaited<ReturnType<typeof loadReviewAgentTrace>>;
try {
  loaded = await loadReviewAgentTrace({
    sessionId,
    trace,
    cwd: repoRootPath,
    storage: resolved.storage,
  });
} catch (error) {
  if (!(error instanceof TraceStorageDeniedError)) throw error;
  return reviewApiJsonResponse(404, { ok: false, error: error.message });
}
if (!loaded) {
  return reviewApiJsonResponse(404, {
    ok: false,
    error: `Trace not found for session ${sessionId}${trace ? ` (subagent ${trace})` : ""}.`,
  });
}
```

- [ ] **Step 10: Run the route test and the hosted tests**

Run: `pnpm --filter @dev.fast/review exec vitest run src/server/review-api-traces.test.ts src/trace-storage/hosted.test.ts`
Expected: PASS.

- [ ] **Step 11: Show `storageError` in the Desktop trace view**

In `packages/progressive-review/app/src/ReviewTraceView.tsx`:

In `TraceListState`'s `loaded` branch add `storageError: string | null;`. In the fetch effect's `setList({ status: "loaded", ... })` add `storageError: result.storageError ?? null,`.

Replace the unconfigured block:

```tsx
        {list.status === "loaded" && (list.storageError || !list.configured) && (
          <div className="review-trace-unconfigured">
            <span className="review-trace-kicker">Agent trace</span>
            {list.storageError ? (
              <p>{list.storageError}</p>
            ) : (
              <>
                <p>Agent traces are not configured.</p>
                <p className="review-trace-note">
                  Open Agent Setup in Review Desktop to enable trace capture.
                </p>
              </>
            )}
          </div>
        )}
        {list.status === "loaded" &&
          list.configured &&
          !list.storageError &&
          sessions.length === 0 && (
```

Keep the source picker mounted while a refetch is in flight: change `const sourceChoices = list.status === "loaded" ? list.sources : [];` to a `useState`-backed value that only updates on a loaded list:

```tsx
const [sourceChoices, setSourceChoices] = useState<AgentTraceStorage[]>([]);
useEffect(() => {
  if (list.status === "loaded" && list.sources.length > 0) {
    setSourceChoices(list.sources);
  }
}, [list]);
```

Add a test to `packages/progressive-review/app/src/ReviewTraceView.test.tsx` after the source-control test:

```tsx
it("shows the storage error instead of the unconfigured hint", async () => {
  const requestMock = vi
    .fn<ReviewCanvasBridge["request"]>()
    .mockImplementation((url) => {
      if (url.includes("/agent-traces")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ...mockListResponse,
              configured: false,
              sessions: [],
              storageError: "Set current-store in config.json.",
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.reject(new Error(`Unexpected URL: ${url}`));
    });
  const session = testReviewSession({}, { request: requestMock });
  await act(async () => {
    root?.render(
      <ReviewSessionProvider session={session}>
        <ReviewTraceView />
      </ReviewSessionProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(container.textContent).toContain("Set current-store in config.json.");
  expect(container.textContent).not.toContain(
    "Agent traces are not configured.",
  );
});
```

Run: `pnpm --filter @dev.fast/review exec vitest run app/src/ReviewTraceView.test.tsx`
Expected: PASS.

- [ ] **Step 12: Full checks and commit**

```bash
pnpm --filter @dev.fast/review typecheck && pnpm -w lint && pnpm -w format:check
GITHUB_REPOSITORY=devdotfast/review pnpm --filter @dev.fast/review test
git add -A packages/progressive-review packages/review-protocol apps/review-desktop/code-oss/src/vs/review/common/reviewProtocol.ts
git commit -m "Report hosted refusals and read-override failures instead of serving a saved copy"
```

---

### Task A3: Make the hosted capture switch the sole authority when hosted is selected

Finding: `enabled` was `hosted || settings.enabled`, so a migrated bucket user who switched to hosted and disabled capture kept uploading.

**Files:**

- Modify: `packages/progressive-review/src/trace-machine-setup.ts` (`traceMachineStatus`, the `status` literal)
- Test: `packages/progressive-review/src/trace-machine-setup.test.ts`

- [ ] **Step 1: Write the failing test**

Append inside `describe("trace machine capture switch")`:

```ts
it("ignores a legacy capture setting once hosted is selected and switched off", async () => {
  const dir = path.join(home, ".config", "dev-trace");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "env"),
    'TRACE_R2_ENDPOINT="https://s3.example.invalid"\nTRACE_R2_BUCKET="b"\nTRACE_R2_ACCESS_KEY_ID="k"\nTRACE_R2_SECRET_ACCESS_KEY="s"\n',
  );
  writeFileSync(
    path.join(dir, "settings.json"),
    JSON.stringify({
      version: 1,
      enabled: true,
      autoActivateRepositories: true,
    }),
  );
  writeConfig(JSON.stringify({ version: 2, "current-store": "hosted" }));
  expect(await traceMachineEnabled({ homeDir: home, env })).toBe(true);
  await disableTraceMachine({ homeDir: home, env });
  expect(await traceMachineEnabled({ homeDir: home, env })).toBe(false);
  expect(await traceMachineStatus({ homeDir: home, env })).toMatchObject({
    enabled: false,
    autoActivateRepositories: false,
    storageMode: "hosted",
  });
  // The legacy file is untouched; selecting s3 again restores it.
  expect(
    JSON.parse(readFileSync(path.join(dir, "settings.json"), "utf8")).enabled,
  ).toBe(true);
});
```

Add `readFileSync` to the `node:fs` import.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @dev.fast/review exec vitest run src/trace-machine-setup.test.ts -t "ignores a legacy"`
Expected: FAIL: `enabled` is still `true` after disabling.

- [ ] **Step 3: Implement**

In `traceMachineStatus`, replace the `hosted` constant and the `status` literal:

```ts
// Capture eligibility has one owner per store. With s3 selected the
// legacy machine switch (settings file or profile capture flag) decides.
// With hosted selected only the hosted switch decides; a legacy setting
// left behind by a bucket install never re-enables hosted uploads.
const hostedSelected = selection.mode === "hosted";
const hosted = hostedSelected && hostedCaptureEnabled(selection.config.config);
const s3Enabled = !hostedSelected && settings?.enabled === true;
const status: TraceMachineStatus = {
  enabled: hosted || s3Enabled,
  configured: hostedSelected || credentials !== null,
  autoActivateRepositories:
    hosted || (s3Enabled && settings?.autoActivateRepositories === true),
  envPath,
  settingsPath,
  configPath: setup.configPath,
  storageMode: selection.mode,
  credentialsSource: setup.source,
  captureSource: source,
};
```

- [ ] **Step 4: Run the file**

Run: `pnpm --filter @dev.fast/review exec vitest run src/trace-machine-setup.test.ts src/cli-install.test.ts src/trace-hook-runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm --filter @dev.fast/review typecheck && pnpm -w lint && pnpm -w format:check
git add packages/progressive-review/src/trace-machine-setup.ts packages/progressive-review/src/trace-machine-setup.test.ts
git commit -m "Let the hosted capture switch alone decide once hosted is selected"
```

---

### Task A4: Gate the git hooks on the machine switch and detach hosted pre-push publishes

Findings: the pre-push hook ignored the capture switch, and a hosted publish ran synchronously inside `git push` with a per-object five-minute budget. S3 keeps its synchronous upload (unchanged behavior for bucket users); hosted publishes go through the same detached `trace sync --expect-storage` path the SessionEnd hook uses.

**Files:**

- Modify: `packages/progressive-review/src/trace-hook-runner.ts` (extract `spawnDetachedTraceSync`)
- Modify: `packages/progressive-review/src/trace-git-hook-runner.ts`
- Create: `packages/progressive-review/src/trace-git-hook-runner.test.ts`

**Interfaces:**

- Produces: `export function spawnDetachedTraceSync(input: { sessionId: string; cwd: string; homeDir?: string; env?: NodeJS.ProcessEnv }): void` in `trace-hook-runner.ts`.

- [ ] **Step 1: Write the failing test**

Create `packages/progressive-review/src/trace-git-hook-runner.test.ts`:

```ts
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearTraceEnvCache } from "./review-agent-traces";
import { runReviewTraceGitHook } from "./trace-git-hook-runner";
import * as hookRunner from "./trace-hook-runner";
import { traceConfigPath } from "./trace-storage/config";
import { allowTraceRepository } from "./trace-user-config";

const execFilePromise = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFilePromise("git", ["-C", cwd, ...args], {
    encoding: "utf8",
  });
  return stdout.trim();
}

describe("runReviewTraceGitHook", () => {
  let repo: string;
  let devHome: string;
  let stderrText: string;
  const stderr = new Writable({
    write(chunk, _encoding, callback) {
      stderrText += String(chunk);
      callback();
    },
  });

  beforeEach(async () => {
    repo = await mkdtemp(path.join(os.tmpdir(), "trace-git-hook-"));
    devHome = path.join(repo, ".dev");
    stderrText = "";
    vi.stubEnv("DEV_REVIEW_HOME", devHome);
    vi.stubEnv("HOME", repo);
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.name", "Test"]);
    await git(repo, ["config", "user.email", "test@example.test"]);
    await git(repo, ["remote", "add", "origin", "git@github.com:acme/app.git"]);
    await writeFile(path.join(repo, "README.md"), "# T\n");
    await git(repo, ["add", "README.md"]);
    await git(repo, [
      "commit",
      "-m",
      "initial\n\nAgent-Session: 01a015e4-0477-7055-a0fd-21a0f72a4ec9",
    ]);
    clearTraceEnvCache();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    clearTraceEnvCache();
    await rm(repo, { recursive: true, force: true });
  });

  async function selectHosted(): Promise<void> {
    const filePath = traceConfigPath({ devHome });
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify({ version: 2, "current-store": "hosted" }),
    );
    await allowTraceRepository(
      { repositoryId: 1, name: "acme/app", origin: "https://app.dev.fast" },
      devHome,
    );
    clearTraceEnvCache();
  }

  function prePush(): Promise<number> {
    const head = "HEAD";
    return git(repo, ["rev-parse", head]).then((sha) =>
      runReviewTraceGitHook({
        cwd: repo,
        hook: "pre-push",
        args: ["origin", "git@github.com:acme/app.git"],
        stdin: Readable.from([
          `refs/heads/main ${sha} refs/heads/main ${"0".repeat(40)}\n`,
        ]),
        stderr,
      }),
    );
  }

  it("does nothing while the machine switch is off", async () => {
    const spawned = vi.spyOn(hookRunner, "spawnDetachedTraceSync");
    expect(await prePush()).toBe(0);
    expect(spawned).not.toHaveBeenCalled();
    expect(stderrText).toBe("");
  });

  it("detaches the hosted publish instead of uploading inside the push", async () => {
    await selectHosted();
    const spawned = vi
      .spyOn(hookRunner, "spawnDetachedTraceSync")
      .mockImplementation(() => undefined);
    expect(await prePush()).toBe(0);
    expect(spawned).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        sessionId: "01a015e4-0477-7055-a0fd-21a0f72a4ec9",
        cwd: repo,
      }),
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @dev.fast/review exec vitest run src/trace-git-hook-runner.test.ts`
Expected: FAIL: `spawnDetachedTraceSync` does not exist; the first test may pass by accident, the second fails.

- [ ] **Step 3: Extract `spawnDetachedTraceSync`**

In `packages/progressive-review/src/trace-hook-runner.ts`, add after the imports (before `runReviewTraceHook`):

```ts
/**
 * Starts `review trace sync` detached for one session. The attempt names
 * the destination it was started for; the sync rechecks the selection and
 * consent before any transfer. A missing CLI reports asynchronously and
 * never fails the caller.
 */
export function spawnDetachedTraceSync(input: {
  sessionId: string;
  cwd: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}): void {
  try {
    const installedCommand = path.join(
      input.homeDir ?? process.env.TRACE_HOME_DIR ?? os.homedir(),
      ".local",
      "bin",
      "review",
    );
    const command =
      process.env.REVIEW_TRACE_COMMAND ??
      (existsSync(installedCommand) ? installedCommand : "review");
    const expectation = traceStorageExpectation({
      homeDir: input.homeDir,
      env: input.env,
    });
    const child = spawn(
      command,
      ["trace", "sync", input.sessionId, "--expect-storage", expectation],
      { cwd: input.cwd, detached: true, stdio: "ignore" },
    );
    child.on("error", () => {});
    child.unref();
  } catch {
    // Ignore sync spawn errors
  }
}
```

Replace the whole `if (isEnd) { try { ... } catch { ... } }` block at the end of `runReviewTraceHook` with:

```ts
// 3. On SessionEnd: detached background trace sync to the selected store
if (isEnd) {
  spawnDetachedTraceSync({
    sessionId,
    cwd: input.cwd,
    homeDir: input.homeDir,
    env: input.env,
  });
}
```

- [ ] **Step 4: Gate the git hook and branch the pre-push publish by store**

In `packages/progressive-review/src/trace-git-hook-runner.ts`:

Add imports:

```ts
import { spawnDetachedTraceSync } from "./trace-hook-runner";
import { traceMachineEnabled } from "./trace-machine-setup";
import { selectTraceStorage } from "./trace-storage/resolve";
```

In `runReviewTraceGitHook`, after `if (process.env.TRACE_DISABLE === "1") return 0;` add:

```ts
// The machine switch owns every capture path, including the git hooks.
if (!(await traceMachineEnabled())) return 0;
```

In `runPrePush`, replace the final loop:

```ts
const selection = selectTraceStorage();
for (const [sessionId, values] of sessionCommits) {
  if (selection.mode === "hosted") {
    // A hosted publish may take minutes; a push never waits for it. The
    // detached sync discovers this session's commits from the trailers.
    spawnDetachedTraceSync({ sessionId, cwd: input.cwd });
    continue;
  }
  await syncReviewTrace({ sessionId, cwd: input.cwd, commits: values }).catch(
    (cause) => warn(input.stderr, cause),
  );
}
```

Note: the test spies on `hookRunner.spawnDetachedTraceSync` through the module namespace. Because vitest ESM spies only intercept namespace access, call it as `hookRunner.spawnDetachedTraceSync(...)` via `import * as hookRunner from "./trace-hook-runner";` in `trace-git-hook-runner.ts`, and keep the direct import out. If the spy still does not intercept, change the test to set `process.env.REVIEW_TRACE_COMMAND` to a tiny script under the temp dir that appends its argv to a file, and assert on that file instead.

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @dev.fast/review exec vitest run src/trace-git-hook-runner.test.ts src/trace-hook-runner.test.ts src/trace-cli.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
pnpm --filter @dev.fast/review typecheck && pnpm -w lint && pnpm -w format:check
git add packages/progressive-review/src/trace-hook-runner.ts packages/progressive-review/src/trace-git-hook-runner.ts packages/progressive-review/src/trace-git-hook-runner.test.ts
git commit -m "Gate git hooks on the capture switch and detach hosted pre-push publishes"
```

---

### Task A5: Match consent by repository id only, and pass `homeDir` to the hook's consent read

**Files:**

- Modify: `packages/progressive-review/src/trace-repository-target.ts` (`requireTraceConsent`)
- Modify: `packages/progressive-review/src/trace-hook-runner.ts` (the `resolveAllowedTraceRepository(input.cwd, input.env)` call)
- Test: `packages/progressive-review/src/trace-storage/hosted.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `hosted.test.ts`:

```ts
it("does not let a same-name consent entry authorize another repository id", async () => {
  const sessionId = "hosted-session-0009";
  writeFileSync(
    path.join(localTraceRoot, `${sessionId}.jsonl`),
    `${sessionRecord(sessionId, "hello")}\n`,
  );
  // Consent for id 999 under the same display name as this target (321).
  await allowTraceRepository(
    { repositoryId: 999, name: "acme/app", origin: ORIGIN },
    devHome,
  );
  const transport = createMemoryTraceStoreTransport();
  const storage = HostedTraceStorage.fromParts({
    target: target(transport.storeId),
    transport,
    devHome,
  });
  await expect(
    syncReviewTrace({ sessionId, cwd: repoDir, storage }),
  ).rejects.toThrow(/not allowed/);
  expect(transport.uploads.size).toBe(0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @dev.fast/review exec vitest run src/trace-storage/hosted.test.ts -t "same-name"`
Expected: FAIL: publish proceeds (or fails on provenance instead of consent; either way the error text differs from `not allowed`). If it fails on provenance first, record provenance in the test with `recordTraceSessionProvenance` the way the first test in the file does, then rerun.

- [ ] **Step 3: Implement**

In `trace-repository-target.ts`, replace the `entry` lookup in `requireTraceConsent`:

```ts
// The id is the identity. A display name can be reused by another
// repository, so a name match never stands in for a missing id match.
const entry = config.repositories.find(
  (candidate) => candidate.repositoryId === target.repositoryId,
);
```

Remove the now-unused `findTraceRepository` import if nothing else in the file uses it.

In `trace-hook-runner.ts`, change the call to:

```ts
const entry = await resolveAllowedTraceRepository(
  input.cwd,
  input.env,
  input.homeDir,
);
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @dev.fast/review exec vitest run src/trace-storage/hosted.test.ts src/trace-hook-runner.test.ts src/trace-storage-cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm --filter @dev.fast/review typecheck && pnpm -w lint && pnpm -w format:check
git add -A packages/progressive-review/src
git commit -m "Match hosted consent by repository id only and honor homeDir in the hook"
```

---

### Task A6: Dependency placement, dead code, test isolation, mock identity

**Files:**

- Modify: `packages/progressive-review/package.json` (move `@dev.fast/trace-shared` to `devDependencies`)
- Modify: `packages/progressive-review/src/trace-storage/hosted.ts` (delete the trailing `resolveAllowedTraceRepository` and `export { DEFAULT_STORE_ORIGIN }`, and the now-unused imports `DEFAULT_STORE_ORIGIN`, `findTraceRepository`, `readTraceUserConfig`)
- Modify: `packages/progressive-review/src/trace-storage/hosted.test.ts` (import `clearTraceEnvCache` from `../review-agent-traces`)
- Modify: `packages/progressive-review/src/trace-storage/s3.ts` (`cacheIdentity` for mock mode)

- [ ] **Step 1: Move the dependency**

In `packages/progressive-review/package.json` delete the line `"@dev.fast/trace-shared": "workspace:*",` from `dependencies` and add it to `devDependencies` next to `"@dev.fast/review-protocol": "workspace:*",`. Run `pnpm install` (updates `pnpm-lock.yaml`).

Verify the bundle still inlines it: `pnpm --filter @dev.fast/review build && grep -c "TRACE_STORE_API_PREFIX\|/api/trace/v1" packages/progressive-review/dist/cli.js` must print a number greater than 0.

- [ ] **Step 2: Delete the dead code**

At the end of `hosted.ts` delete:

```ts
/** The consent entry for a checkout's repository name, or null. */
export async function resolveAllowedTraceRepository(
  name: string,
  devHome?: string,
) {
  const config = await readTraceUserConfig(devHome);
  return findTraceRepository(config, name);
}

export { DEFAULT_STORE_ORIGIN };
```

Then fix the imports: `import { readStoreAuth } from "../store-auth";` and remove `import { findTraceRepository, readTraceUserConfig } from "../trace-user-config";`. Run `pnpm --filter @dev.fast/review typecheck` to confirm nothing else referenced them.

- [ ] **Step 3: Fix the test's cache clearer**

In `hosted.test.ts` replace `import { clearTraceEnvCache } from "./s3-config";` with adding `clearTraceEnvCache` to the existing `../review-agent-traces` import list.

- [ ] **Step 4: Give each mock bucket its own cache identity**

In `s3.ts` `cacheIdentity`, replace `if (!this.config) return "s3:mock";` with:

```ts
if (!this.config) return `s3:mock:${this.mockRoot ?? ""}`;
```

Then search tests for the literal `"s3:mock"` (`grep -rn '"s3:mock"' packages/progressive-review/src`) and update any assertion to `expect.stringMatching(/^s3:mock:/)`.

- [ ] **Step 5: Run the affected tests and commit**

```bash
pnpm --filter @dev.fast/review exec vitest run src/trace-storage src/review-agent-traces.test.ts src/trace-store-transport.test.ts
pnpm --filter @dev.fast/review typecheck && pnpm -w lint && pnpm -w format:check
git add packages/progressive-review/package.json pnpm-lock.yaml packages/progressive-review/src
git commit -m "Bundle trace-shared as a dev dependency and remove dead hosted helpers"
```

---

### Task A7: Desktop capture settings describe the selected store and hide S3 fields on hosted

**Files:**

- Modify: `packages/progressive-review/app/src/trace-capture-section.tsx`
- Test: `packages/progressive-review/app/src/trace-capture-section.test.tsx`

- [ ] **Step 1: Write the failing test**

Append inside `describe("TraceCaptureSection")`:

```tsx
it("hides the bucket fields and the S3 copy on a hosted machine", async () => {
  const hostedStatus: ReviewCliInstallStatus = {
    ...traceStatus,
    trace: {
      ...traceStatus.trace,
      enabled: true,
      configured: true,
      storageMode: "hosted",
    },
  };
  const install: ReviewCanvasInstallContent = {
    status: hostedStatus,
    apply: vi.fn<ReviewCanvasInstallContent["apply"]>(),
    remove: vi.fn<ReviewCanvasInstallContent["remove"]>(),
    decline: vi.fn<ReviewCanvasInstallContent["decline"]>(),
    skip: vi.fn<ReviewCanvasInstallContent["skip"]>(),
    enablePrompts: vi.fn<ReviewCanvasInstallContent["enablePrompts"]>(),
  };
  await act(async () => root.render(<TraceCaptureSection install={install} />));
  expect(
    container.querySelector('input[aria-label="S3/R2 endpoint URL"]'),
  ).toBeNull();
  expect(container.textContent).toContain(
    "to the hosted /dev/fast trace store",
  );
  expect(container.textContent).not.toContain("your own S3/R2 bucket");
  expect(
    [...container.querySelectorAll<HTMLButtonElement>("button")].map(
      (button) => button.textContent,
    ),
  ).not.toContain("Repair");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @dev.fast/review exec vitest run app/src/trace-capture-section.test.tsx`
Expected: FAIL on the endpoint input assertion.

- [ ] **Step 3: Implement**

In `trace-capture-section.tsx`:

Add before the component:

```tsx
/** What capture records and where, for the selected store. */
function traceDestinationCopy(trace: ReviewCliInstallStatus["trace"]): string {
  if (trace.storageMode === "hosted") {
    return "Records agent sessions from allowed repositories to the hosted /dev/fast trace store so reviews can quote them. Session hooks activate each Git or Jujutsu repository when an agent session starts.";
  }
  return "Records agent sessions to your own S3/R2 bucket so reviews can quote them. Session hooks activate each Git or Jujutsu repository when an agent session starts.";
}
```

Inside the component, after `useEffect(() => setStatus(install.status), ...)` add `const hosted = status.trace.storageMode === "hosted";`.

Replace the copy span:

```tsx
<span className="review-agent-setup-cli">
  {traceDestinationCopy(status.trace)}
</span>
```

Wrap the `<div className="review-agent-setup-trace-fields">...</div>` in `{hosted ? null : ( ... )}`.

Wrap the Enable/Repair `<button ...>` in `{hosted ? null : ( ... )}`. The Disable button stays for both stores.

- [ ] **Step 4: Run the file and commit**

```bash
pnpm --filter @dev.fast/review exec vitest run app/src/trace-capture-section.test.tsx
pnpm --filter @dev.fast/review typecheck && pnpm -w lint && pnpm -w format:check
git add packages/progressive-review/app/src/trace-capture-section.tsx packages/progressive-review/app/src/trace-capture-section.test.tsx
git commit -m "Describe the hosted store in trace capture settings and hide bucket fields there"
```

---

### Task A8: Hosted client: one lookup per operation, skip unchanged uploads, follow listing pages, send branch and author

Findings: every object read re-listed the session (a GitHub call per object on the server); every push re-uploaded every byte; the listing was unpaginated; branch and author were dropped.

**Files:**

- Modify: `packages/progressive-review/src/trace-storage/hosted.ts`
- Modify: `packages/progressive-review/src/trace-store-transport.ts` (memory transport: additive commits on a repeated completion of the current upload, `branch`/`author`, paging)
- Modify: `packages/progressive-review/src/store-client.ts` (`listSessions` passes `limit`/`cursor`; `send` refuses oversized bodies)
- Test: `packages/progressive-review/src/trace-storage/hosted.test.ts`

**Interfaces:**

- Consumes: Task A1 schema fields.
- Produces: `HostedTraceStorage` memoizes `lookupSession` per instance; `publish` returns `status: "unchanged"` uploads when the published upload already holds identical objects; `sessionMeta` returns `branch`/`author` from the listing.

- [ ] **Step 1: Write the failing tests**

Append to `hosted.test.ts`:

```ts
it("lists a session once per storage instance and forgets it after a publish", async () => {
  const sessionId = "hosted-session-0010";
  const transport = createMemoryTraceStoreTransport();
  const listSessions = vi.spyOn(transport, "listSessions");
  seedMemoryTraceSession(transport, {
    repositoryId: REPOSITORY_ID,
    sessionId,
    traces: {
      "main.jsonl.gz": `${sessionRecord(sessionId, "main")}\n`,
      "subagents/agent-a1.jsonl.gz": `${sessionRecord(sessionId, "sub")}\n`,
    },
  });
  const storage = HostedTraceStorage.fromParts({
    target: target(transport.storeId),
    transport,
    devHome,
  });
  await pullReviewTraceCorpus({
    repo: { owner: "acme", repo: "app" },
    sessions: [{ id: sessionId }],
    storage,
  });
  expect(listSessions).toHaveBeenCalledTimes(1);
});

it("skips the upload when the store already holds identical objects and links new commits", async () => {
  const sessionId = "hosted-session-0011";
  writeFileSync(
    path.join(localTraceRoot, `${sessionId}.jsonl`),
    `${sessionRecord(sessionId, "same")}\n`,
  );
  await allowTraceRepository(
    { repositoryId: REPOSITORY_ID, name: "acme/app", origin: ORIGIN },
    devHome,
  );
  await recordTraceSessionProvenance(
    sessionId,
    traceCaptureIdentity(target("x".repeat(32)), true),
    devHome,
  );
  const transport = createMemoryTraceStoreTransport();
  const storage = HostedTraceStorage.fromParts({
    target: target(transport.storeId),
    transport,
    devHome,
  });
  const first = await syncReviewTrace({
    sessionId,
    cwd: repoDir,
    storage,
    commits: ["a".repeat(40)],
  });
  expect(first.uploads.map((upload) => upload.status)).toEqual(["uploaded"]);
  const putObject = vi.spyOn(transport, "putObject");
  const second = await syncReviewTrace({
    sessionId,
    cwd: repoDir,
    storage,
    commits: ["b".repeat(40)],
  });
  expect(second.uploads.map((upload) => upload.status)).toEqual(["unchanged"]);
  expect(putObject).not.toHaveBeenCalled();
  expect(second.hosted?.uploadId).toBe(first.hosted?.uploadId);
  expect(second.hosted?.commits).toEqual(["a".repeat(40), "b".repeat(40)]);
  expect(transport.uploads.size).toBe(1);
});

it("follows listing pages when a commit has many sessions", async () => {
  const transport = createMemoryTraceStoreTransport({ pageSize: 2 });
  const commit = "c".repeat(40);
  for (const index of [1, 2, 3, 4, 5]) {
    seedMemoryTraceSession(transport, {
      repositoryId: REPOSITORY_ID,
      sessionId: `hosted-session-page-${index}`,
      commits: [commit],
      traces: {
        "main.jsonl.gz": `${sessionRecord(`hosted-session-page-${index}`, "p")}\n`,
      },
    });
  }
  const storage = HostedTraceStorage.fromParts({
    target: target(transport.storeId),
    transport,
    devHome,
  });
  const found = await storage.sessionsForCommit(commit);
  expect(found?.sessions.sort()).toEqual(
    [1, 2, 3, 4, 5].map((i) => `hosted-session-page-${i}`),
  );
});

it("carries branch and author into the session metadata", async () => {
  const sessionId = "hosted-session-0012";
  writeFileSync(
    path.join(localTraceRoot, `${sessionId}.jsonl`),
    `${sessionRecord(sessionId, "labels")}\n`,
  );
  await allowTraceRepository(
    { repositoryId: REPOSITORY_ID, name: "acme/app", origin: ORIGIN },
    devHome,
  );
  await recordTraceSessionProvenance(
    sessionId,
    traceCaptureIdentity(target("x".repeat(32)), true),
    devHome,
  );
  const transport = createMemoryTraceStoreTransport();
  const storage = HostedTraceStorage.fromParts({
    target: target(transport.storeId),
    transport,
    devHome,
  });
  await syncReviewTrace({ sessionId, cwd: repoDir, storage, commits: [] });
  const meta = await HostedTraceStorage.fromParts({
    target: target(transport.storeId),
    transport,
    devHome,
  }).sessionMeta(sessionId);
  expect(meta?.branch).toBe("main");
  expect(meta?.author).toEqual(expect.any(String));
});
```

Add `pullReviewTraceCorpus` to the `../review-agent-traces` import. The provenance helper calls mirror the file's first test; copy its exact `recordTraceSessionProvenance`/`traceCaptureIdentity` usage if the signature above does not match (read `packages/progressive-review/src/trace-session-provenance.ts`). The repo in `beforeEach` has no commits; add `execFileSync("git", ["commit", "--allow-empty", "-m", "init", "--quiet"], { cwd: repoDir })` after the remote is added so `main` exists for the branch label.

Also update two existing tests so their second phase uses a fresh instance (a new command resolves a new storage; the memo lives on one instance):

- In "shows nothing when the store refuses, instead of an old copy": after swapping `transport.listSessions`, build `const revoked = HostedTraceStorage.fromParts({ target: target(transport.storeId), transport, devHome });` and pass `storage: revoked` to both calls inside the `try`.
- In "refreshes a saved copy when the content changes at the same size": after re-seeding, build a second instance the same way and pass it to the second `loadReviewAgentTrace`.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @dev.fast/review exec vitest run src/trace-storage/hosted.test.ts`
Expected: the four new tests FAIL (`pageSize` unknown option, listing called more than once, uploads repeated, branch null).

- [ ] **Step 3: Memoize lookups per instance in `hosted.ts`**

Add a field to `HostedTraceStorage`:

```ts
  /** One listing per session per instance; an instance lives one operation. */
  private readonly lookups = new Map<string, Promise<StoreSessionLookup>>();
```

Replace `lookupSession` with:

```ts
  private lookupSession(sessionId: string): Promise<StoreSessionLookup> {
    const pending = this.lookups.get(sessionId);
    if (pending) return pending;
    const lookup = this.lookupSessionLive(sessionId);
    this.lookups.set(sessionId, lookup);
    return lookup;
  }

  private async lookupSessionLive(
    sessionId: string,
  ): Promise<StoreSessionLookup> {
    if (this.offline) return { status: "unreachable", error: null };
    try {
      const response = await this.transport.listSessions(
        this.repositoryTarget.repositoryId,
        { session: sessionId },
      );
      const session = response.sessions.find(
        (candidate) => candidate.sessionId === sessionId,
      );
      return session ? { status: "found", session } : { status: "absent" };
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      this.reportFailure(cause);
      if (isStoreUnreachable(cause)) {
        return { status: "unreachable", error: cause };
      }
      if (cause instanceof StoreApiError && cause.code === "not_found") {
        return { status: "absent" };
      }
      return { status: "denied", error: cause };
    }
  }
```

- [ ] **Step 4: Skip unchanged uploads and send labels in `publish`**

In `publish`, after the manifest is built (`const manifest = compressed.map(...)`) and before `beginUpload`, insert:

```ts
const allCommits = [
  ...new Set(
    input.commits?.filter(
      (commit) => commitShaSchema.safeParse(commit).success,
    ) ?? (await commitsForTraceSession(input.cwd, input.sessionId)),
  ),
];
const commits = allCommits.slice(0, MAX_TRACE_COMMITS);
const labels = { branch: input.branch, author: input.author };

// The published upload already holds these exact bytes: link any new
// commits to it and send nothing. Completion of the current upload is
// additive for commits and returns its receipt.
this.lookups.delete(input.sessionId);
const current = await this.lookupSession(input.sessionId);
if (
  current.status === "found" &&
  sameObjects(manifest, current.session.objects)
) {
  const completed = await this.completeUploadOnce(
    input.sessionId,
    current.session.uploadId,
    commits,
    labels,
  );
  this.lookups.delete(input.sessionId);
  await clearTraceSyncFailure(input.sessionId, this.devHome).catch(
    () => undefined,
  );
  return publishResult(compressed, "unchanged", target, completed, {
    subagents: omittedSubagents,
    commits: allCommits.length - commits.length,
  });
}
```

Delete the later duplicate computation of `allCommits`/`commits`, pass `labels` to the existing `completeUploadOnce` call, add `this.lookups.delete(input.sessionId);` right after it, and replace the trailing `return { uploads: ..., hosted: ... }` with `return publishResult(compressed, "uploaded", target, completed, omitted);`.

Add these module-level helpers below `syncStoreError`:

```ts
/** Whether the manifest names exactly the stored objects, byte for byte. */
function sameObjects(
  manifest: ReadonlyArray<{ name: string; size: number; sha256: string }>,
  stored: ReadonlyArray<{ name: string; size: number; sha256: string }>,
): boolean {
  if (manifest.length !== stored.length) return false;
  return manifest.every((object) =>
    stored.some(
      (candidate) =>
        candidate.name === object.name &&
        candidate.size === object.size &&
        candidate.sha256 === object.sha256,
    ),
  );
}

function publishResult(
  compressed: ReadonlyArray<{ name: TraceObjectName; size: number }>,
  status: "uploaded" | "unchanged",
  target: TraceRepositoryTarget,
  completed: CompleteUploadResponse,
  omitted: { subagents: string[]; commits: number },
): TracePublishResult {
  return {
    uploads: compressed.map((object) => ({
      blob:
        object.name === "main.jsonl.gz"
          ? "trace.jsonl"
          : `subagents/${traceNameFromObject(object.name)}.jsonl`,
      bytes_stored: object.size,
      status,
    })),
    hosted: {
      repositoryId: target.repositoryId,
      storeId: target.storeId,
      uploadId: completed.uploadId,
      generation: completed.generation,
      complete: omitted.subagents.length === 0 && omitted.commits === 0,
      objects: completed.objects.map((object) => object.name),
      commits: completed.commits,
      omitted,
    },
  };
}
```

Import `CompleteUploadResponse` as a type from `@dev.fast/trace-shared`. Change `completeUploadOnce` to take `labels: { branch: string | null; author: string | null }` as a fourth parameter and pass `{ commits, ...labels }` as the completion body.

Update `sessionMeta` to return `branch: stored.branch ?? null` and `author: stored.author ?? null`, and fix its doc comment ("The store keeps the branch and author sent at publication.").

- [ ] **Step 5: Follow pages in `sessionsForCommit`**

Replace the body of the `try` in `sessionsForCommit`:

```ts
const sessions: string[] = [];
let cursor: string | undefined;
// A bounded walk: ten pages of the server's default size.
for (let page = 0; page < 10; page += 1) {
  const response = await this.transport.listSessions(
    this.repositoryTarget.repositoryId,
    cursor === undefined ? { commit } : { commit, cursor },
  );
  sessions.push(...response.sessions.map((session) => session.sessionId));
  if (!response.nextCursor) break;
  cursor = response.nextCursor;
}
return sessions.length > 0 ? { sessions, pr: null, branch: null } : null;
```

- [ ] **Step 6: Teach the memory transport the new semantics**

In `trace-store-transport.ts`:

- `createMemoryTraceStoreTransport(options: TraceStoreTransportOptions & { storeId?: string; pageSize?: number } = {})`; `const pageSize = options.pageSize ?? DEFAULT_TRACE_SESSIONS_PAGE;` (import the constant from `@dev.fast/trace-shared`).
- `MemoryTraceStoreSession` gains `branch: string | null; author: string | null;` and `MemoryTraceStoreUpload` gains the same two fields (default `null` at begin).
- In `completeUpload`, replace the early return for a complete upload with:

```ts
if (upload.status === "complete" && upload.generation !== null) {
  const sessionKey = memoryTraceSessionKey(repositoryId, sessionId);
  const session = sessions.get(sessionKey);
  if (session && session.currentUploadId === uploadId) {
    // Completing the current upload again links any new commits.
    const merged = [...new Set([...session.commits, ...body.commits])];
    session.commits = merged;
    upload.commits = merged;
  }
  return {
    sessionId,
    uploadId,
    generation: upload.generation,
    objects: upload.objects.map((object) => ({ ...object })),
    commits: [...upload.commits],
  };
}
```

and when the session is written on first completion set `branch: body.branch ?? null, author: body.author ?? null` on both the session and the upload.

- In `listSessions`, after filtering, sort by `sessionId`, apply `cursor` (`session.sessionId > query.cursor`), take `limit ?? pageSize` plus one, and return `nextCursor` as the last returned id when one more exists. Include `branch` and `author` in each returned session.
- `seedMemoryTraceSession` passes `branch: null, author: null` (read its body and add the fields where the session and upload objects are built).

- [ ] **Step 7: Pass paging through `StoreClient.listSessions` and bound the body**

In `store-client.ts` `listSessions`: `if (query.limit !== undefined) params.set("limit", String(query.limit)); if (query.cursor) params.set("cursor", query.cursor);`.

In `send`, after `if (!response.ok) { throw ... }` add:

```ts
const contentLength = Number(response.headers.get("content-length") ?? "0");
if (contentLength > MAX_STORE_RESPONSE_BYTES) {
  throw new StoreApiError(
    "internal",
    response.status,
    `The trace store answered ${contentLength} bytes; the client accepts at most ${MAX_STORE_RESPONSE_BYTES}.`,
  );
}
```

with `const MAX_STORE_RESPONSE_BYTES = 8 * 1024 * 1024;` near `DEFAULT_TIMEOUT_MS`.

- [ ] **Step 8: Run the hosted, transport, and CLI tests**

Run: `pnpm --filter @dev.fast/review exec vitest run src/trace-storage src/trace-store-transport.test.ts src/store-client.test.ts src/trace-cli.test.ts src/review-agent-traces.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
pnpm --filter @dev.fast/review typecheck && pnpm -w lint && pnpm -w format:check
git add -A packages/progressive-review/src
git commit -m "Look a hosted session up once per operation, skip identical uploads, page listings, and keep labels"
```

---

### Task A9: Status shows stored bytes, `deny --delete-store`, and a real PUT wire test

**Files:**

- Modify: `packages/progressive-review/src/trace-hosted-cli.ts` (`runReviewTraceDeny`, `writeHostedTraceStatus`)
- Modify: `packages/progressive-review/src/cli-runner.ts` (deny option)
- Modify: `packages/progressive-review/src/trace-cli.ts` (pass a client to status when logged in)
- Create: `packages/progressive-review/src/trace-hosted-cli.test.ts`
- Modify: `packages/progressive-review/src/trace-store-transport.test.ts`

- [ ] **Step 1: Write the failing CLI tests**

Create `packages/progressive-review/src/trace-hosted-cli.test.ts`:

```ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearTraceEnvCache } from "./review-agent-traces";
import { StoreClient } from "./store-client";
import { runReviewTraceDeny, writeHostedTraceStatus } from "./trace-hosted-cli";
import { rememberTraceRepositoryTarget } from "./trace-repository-target";
import { allowTraceRepository, readTraceUserConfig } from "./trace-user-config";

const ORIGIN = "https://app.dev.fast";
const STORE_ID = "0123456789abcdef0123456789abcdef";

function collect(): { stream: Writable; text: () => string } {
  let text = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += String(chunk);
      callback();
    },
  });
  return { stream, text: () => text };
}

describe("hosted trace commands", () => {
  let home: string;
  let repo: string;
  let devHome: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "trace-hosted-cli-"));
    repo = path.join(home, "repo");
    devHome = path.join(home, ".dev");
    env = { DEV_REVIEW_HOME: devHome };
    execFileSync("git", ["init", "--quiet", repo]);
    execFileSync(
      "git",
      ["remote", "add", "origin", "git@github.com:acme/app.git"],
      { cwd: repo },
    );
    clearTraceEnvCache();
  });

  afterEach(() => {
    clearTraceEnvCache();
    rmSync(home, { recursive: true, force: true });
  });

  function client(handler: (url: string, init?: RequestInit) => Response) {
    return new StoreClient({
      origin: ORIGIN,
      token: "token",
      fetch: vi.fn<typeof fetch>(async (input, init) =>
        handler(String(input), init),
      ),
    });
  }

  it("deletes the store on request after withdrawing consent", async () => {
    await allowTraceRepository(
      { repositoryId: 7, name: "acme/app", origin: ORIGIN },
      devHome,
    );
    await rememberTraceRepositoryTarget({
      cwd: repo,
      target: {
        origin: ORIGIN,
        repositoryId: 7,
        storeId: STORE_ID,
        name: "acme/app",
      },
      checkout: "acme/app",
      devHome,
    });
    const calls: string[] = [];
    const out = collect();
    const code = await runReviewTraceDeny({
      cwd: repo,
      env,
      homeDir: home,
      deleteStore: true,
      client: client((url, init) => {
        calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
        return Response.json({
          repositoryId: 7,
          storeId: STORE_ID,
          status: "deleting",
          deletedAt: "2026-09-09T00:00:00.000Z",
        });
      }),
      stdout: out.stream,
      stderr: out.stream,
    });
    expect(code).toBe(0);
    expect(calls).toEqual(["DELETE /api/trace/v1/stores/7"]);
    expect((await readTraceUserConfig(devHome)).repositories).toEqual([]);
    expect(out.text()).toContain("deletion requested");
  });

  it("prints the stored bytes of this repository's store", async () => {
    await allowTraceRepository(
      { repositoryId: 7, name: "acme/app", origin: ORIGIN },
      devHome,
    );
    const out = collect();
    await writeHostedTraceStatus({
      cwd: repo,
      env,
      homeDir: home,
      origin: ORIGIN,
      stdout: out.stream,
      client: client(() =>
        Response.json({
          repositoryId: 7,
          storeId: STORE_ID,
          displayName: "acme/app",
          status: "active",
          createdAt: "2026-09-01T00:00:00.000Z",
          bytesStored: 2048,
        }),
      ),
    });
    expect(out.text()).toContain("Stored bytes: 2048");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @dev.fast/review exec vitest run src/trace-hosted-cli.test.ts`
Expected: FAIL: `deleteStore`/`client` are not accepted; no "Stored bytes" line.

- [ ] **Step 3: Implement `deny --delete-store`**

In `trace-hosted-cli.ts`, change the signature and body of `runReviewTraceDeny`:

```ts
export async function runReviewTraceDeny(
  input: CliJsonOutput &
    HostedCommandScope & {
      cwd: string;
      /** Also delete the hosted store (repository admins only). */
      deleteStore?: boolean;
      client?: StoreClient;
    },
): Promise<number> {
```

After `const removed = await denyTraceRepository(...)` and before `emitJsonEvent`, add:

```ts
let deletion: Awaited<ReturnType<StoreClient["deleteStore"]>> | null = null;
if (input.deleteStore) {
  let client: StoreClient;
  try {
    client = input.client ?? (await requireStoreClient(input.env));
  } catch (error) {
    return failWithJsonError(
      input,
      "deny",
      error instanceof Error ? error.message : String(error),
    );
  }
  const repositoryId = cached?.repositoryId ?? null;
  if (repositoryId === null) {
    return failWithJsonError(
      input,
      "deny",
      `${name} has no resolved hosted store on this machine. Run \`review trace allow .\` once, then deny with --delete-store.`,
    );
  }
  try {
    deletion = await client.deleteStore(repositoryId);
  } catch (error) {
    if (error instanceof StoreApiError && error.code === "forbidden") {
      return failWithJsonError(
        input,
        "deny",
        `Deleting the store of ${name} needs admin access to the repository.`,
      );
    }
    return failWithJsonError(
      input,
      "deny",
      error instanceof Error ? error.message : String(error),
    );
  }
}
```

Change the JSON event to `{ event: "trace.deny", name, removed, storeDeleted: deletion !== null }` and append after the existing human line:

```ts
if (deletion) {
  humanStream(input).write(
    `Store deletion requested for ${name} (store ${deletion.storeId}). Uploaded objects are removed by a later operator cleanup.\n`,
  );
}
```

In `cli-runner.ts`, add `.option("--delete-store", "also delete the hosted store; needs repository admin access")` to the deny command and pass `deleteStore: options.deleteStore` (type `options: { json?: boolean; deleteStore?: boolean }`).

- [ ] **Step 4: Print stored bytes in status**

In `writeHostedTraceStatus`, add `client?: StoreClient` to the input type. After the "This repository ... is allowed to publish traces" branch (inside the `else` where `name !== null` and the entry covers the origin), add:

```ts
const client =
  input.client ??
  (auth && auth.origin === input.origin
    ? new StoreClient({ origin: auth.origin, token: auth.token })
    : null);
if (client) {
  const [owner, repo] = name.split("/");
  const store = await client
    .findStore({ owner: owner ?? "", name: repo ?? "" })
    .catch(() => null);
  if (store?.bytesStored !== undefined) {
    stream.write(`Stored bytes: ${store.bytesStored}\n`);
  }
}
```

- [ ] **Step 5: Add the PUT wire test**

In `trace-store-transport.test.ts`, add after "puts the object with the presigned headers":

```ts
it("sends a fixed content length on the wire, never chunked", async () => {
  const { createServer } = await import("node:http");
  const source = path.join(tempDir, "wire.jsonl");
  await writeFile(source, "hello wire\n", "utf8");
  const gzipped = await gzipToTemp(source);
  const seen: {
    headers: Record<string, string | string[] | undefined>;
    bytes: number;
  } = { headers: {}, bytes: 0 };
  const server = createServer((request, response) => {
    seen.headers = request.headers;
    request.on("data", (chunk: Buffer) => {
      seen.bytes += chunk.length;
    });
    request.on("end", () => {
      response.statusCode = 200;
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  try {
    await httpTransport(globalThis.fetch).putObject(
      {
        name: "main.jsonl.gz",
        url: `http://127.0.0.1:${address.port}/k`,
        headers: {
          "content-type": "application/gzip",
          "content-length": String(gzipped.size),
          "x-amz-checksum-sha256": Buffer.from(gzipped.sha256, "hex").toString(
            "base64",
          ),
          "if-none-match": "*",
        },
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
      gzipped.path,
    );
    expect(seen.headers["content-length"]).toBe(String(gzipped.size));
    expect(seen.headers["transfer-encoding"]).toBeUndefined();
    expect(seen.bytes).toBe(gzipped.size);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await gzipped.cleanup();
  }
});
```

- [ ] **Step 6: Run and commit**

```bash
pnpm --filter @dev.fast/review exec vitest run src/trace-hosted-cli.test.ts src/trace-store-transport.test.ts src/cli-runner.test.ts src/trace-cli.test.ts
pnpm --filter @dev.fast/review typecheck && pnpm -w lint && pnpm -w format:check
git add -A packages/progressive-review/src
git commit -m "Add deny --delete-store, show stored bytes in trace status, and test the PUT wire format"
```

---

### Task A10: Documentation and wording

**Files:**

- Modify: `docs/privacy.md` (Hosted trace store section)
- Modify: `docs/cli-reference.md` (deny flag, status line)
- Modify: `packages/progressive-review/src/trace-hosted-cli.ts` (the `allow` closing line)
- Modify: `packages/progressive-review/src/trace-storage/types.ts`, `packages/progressive-review/src/review-agent-traces.ts` (comments saying "Direct storage")
- Modify: `docs/superpowers/plans/2026-09-09-trace-storage-upgrade-gate.md` (replace `direct` vocabulary in prose; leave recorded command output untouched)

- [ ] **Step 1: privacy.md**

Replace the first paragraph of "## Hosted trace store" with:

```markdown
Trace capture is off by default. Hosted uploads start when this machine's
selected store is the hosted store and the repository is allowed. Selection
happens explicitly with `review trace storage use hosted`, or implicitly when
a machine that has no bucket configured allows a repository with
`review trace allow`. After that, complete agent session transcripts for the
allowed repositories are uploaded to the /dev/fast hosted store at the origin
you logged in to. One conversation can contain work from several
repositories; Review publishes a session automatically only when its captured
provenance places it in the allowed repository, and a commit trailer alone
never authorizes an upload. Transcripts can contain prompts, model output,
source code, file paths, URLs, and email addresses. Each publication also
records the checkout branch and the Git author name at that time.
```

Change `review trace deny` sentence to: "`review trace deny` stops future publication and does not erase prior uploads; `review trace deny --delete-store` additionally asks the store to delete the repository's hosted copies, which a repository admin may do." Change "Direct S3/R2 storage sends nothing to /dev/fast." to "S3/R2 bucket storage sends nothing to /dev/fast."

- [ ] **Step 2: cli-reference.md**

Change `review trace deny [path]` to `review trace deny [path] [--delete-store]` and add below the storage section a line: "`review trace status` on a hosted machine also prints `Stored bytes`, the size of every completed upload in the repository's store."

- [ ] **Step 3: `allow` message**

In `runReviewTraceAllow`, replace the closing write with:

```ts
humanStream(input).write(
  `Traces from ${store.displayName} may be published to ${storeOrigin}. A machine with no bucket configured now uses the hosted store; one with a bucket needs \`review trace storage use hosted\`.\n`,
);
```

- [ ] **Step 4: Comments and evidence doc**

`perl -pi -e 's/Direct storage/S3 storage/g; s/by direct\b/by s3/g' packages/progressive-review/src/trace-storage/types.ts packages/progressive-review/src/review-agent-traces.ts`, then read the two diffs and fix any sentence that no longer reads well. In the evidence doc replace prose uses of "direct storage" with "s3 storage" (`grep -n -i "direct" docs/superpowers/plans/2026-09-09-trace-storage-upgrade-gate.md`), leaving quoted command output as recorded.

- [ ] **Step 5: Commit**

```bash
pnpm -w format:check
git add docs packages/progressive-review/src
git commit -m "Align trace storage docs and wording with the shipped behavior"
```

---

### Task A11: Final verification, tarball for Part B, push

- [ ] **Step 1: Full checks**

```bash
pnpm --filter @dev.fast/review typecheck && pnpm -w lint && pnpm -w format:check
GITHUB_REPOSITORY=devdotfast/review pnpm --filter @dev.fast/review test
pnpm --filter @dev.fast/trace-shared test
```

Expected: every suite green (the Review suite previously reported 174 files, 1315 tests; the count grows).

- [ ] **Step 2: Rerun the real-install read check**

With Review Desktop possibly running: `DEV_FAST_REVIEW_CLI_NO_DELEGATE=1 node packages/progressive-review/dist/cli.js trace status` from a checkout that uses the user's real bucket setup (`/Users/aiansiti/workable/review`), then `... trace config migrate --dry-run`. Both must succeed and print `Storage: S3/R2 bucket`. Do not run `config migrate` without `--dry-run`.

- [ ] **Step 3: Pack the contract for Part B**

```bash
pnpm --filter @dev.fast/trace-shared build
mkdir -p /private/tmp/claude-501/-Users-aiansiti-workable-dev/d776daad-e331-4466-bdbd-7cd14b0e0361/scratchpad/pack
pnpm --filter @dev.fast/trace-shared pack --pack-destination /private/tmp/claude-501/-Users-aiansiti-workable-dev/d776daad-e331-4466-bdbd-7cd14b0e0361/scratchpad/pack
command ls -l /private/tmp/claude-501/-Users-aiansiti-workable-dev/d776daad-e331-4466-bdbd-7cd14b0e0361/scratchpad/pack
```

The tarball name must be exactly `dev.fast-trace-shared-0.2.0.tgz`, the path the Dev override already names.

- [ ] **Step 4: Push and watch CI**

```bash
git push origin feat/trace-storage-rewrite
gh pr checks 207 --watch
```

Expected: `Review Desktop` check passes. Then update the PR body's test counts (`gh pr view 207 --json body -q .body > /tmp/pr-body.md`, edit the "Review package:" line, `gh pr edit 207 --body-file /tmp/pr-body.md`).

---

# Part B: Dev (`/Users/aiansiti/workable/dev-hosted-traces`)

Start a new session in this worktree. Before Task B1: `git status` must show only `pnpm-lock.yaml` and `pnpm-workspace.yaml` modified (the local tarball override), and `git log --oneline -1` must show `d62c2f5a8` or a descendant. Confirm the tarball from Task A11 exists at the path named in `pnpm-workspace.yaml`.

### Task B1: Install the updated contract

- [ ] **Step 1: Install**

Run: `pnpm install` (the override resolves the new tarball; the lockfile integrity hash changes; do not commit the lockfile).

- [ ] **Step 2: Verify the new fields are visible**

Run: `node -e "const s=require('@dev.fast/trace-shared'); console.log(Object.keys(s.storeResponseSchema.shape))"` from `apps/review-web`. Expected: the list includes `bytesStored`. If `require` fails on ESM, run `pnpm --filter @dev-fast/review-web typecheck` after Task B4 instead; it will fail there if the tarball is stale.

---

### Task B2: Publish session metadata at completion, not at begin

Finding: `beginUpload` upserted `trace_session` (`harness`, `shipped_by_github_user_id`, `updated_at`) before any byte landed, and `listSessions` served those as the published snapshot.

**Files:**

- Modify: `apps/review-web/src/lib/trace-api/uploads.server.ts`
- Test: `apps/review-web/src/lib/trace-api/router.worker.test.ts`

- [ ] **Step 1: Write the failing test**

Add after "returns the same receipt for a repeated completion":

```ts
it("keeps the published metadata when a later begin never completes", async () => {
  await onboard();
  await publish("session-0050", [mainObject], [commit("a")]);
  const before = (await list("session=session-0050")).sessions[0]!;
  // A second attempt under another harness begins and is abandoned.
  await begin("session-0050", [mainObject], "codex");
  const after = (await list("session=session-0050")).sessions[0]!;
  expect(after.harness).toBe("claude");
  expect(after.updatedAt).toBe(before.updatedAt);
  expect(after.uploadId).toBe(before.uploadId);
  // A session with no completed upload has no row at all.
  await begin("session-0051");
  expect(
    await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM trace_session WHERE session_id = ?",
    )
      .bind("session-0051")
      .first<{ n: number }>(),
  ).toEqual({ n: 0 });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @dev-fast/review-web test:worker -- -t "keeps the published metadata"`
Expected: FAIL: `after.harness` is `codex`.

- [ ] **Step 3: Implement**

In `beginUpload`, delete the `db.insert(traceSession)...onConflictDoUpdate(...)` statement from the batch (the batch keeps the `traceUpload` insert and the object chunks). Remove `userId` from the session, keep it for `createdByGithubUserId`.

In `completeUpload`, replace the first statement of the publish batch (`db.update(traceSession)...`) with an upsert that also creates the row:

```ts
    db
      .insert(traceSession)
      .select(
        db
          .select({
            storeId: sql<string>`${store.id}`.as("store_id"),
            sessionId: sql<string>`${sessionId}`.as("session_id"),
            harness: sql<string>`${upload.harness}`.as("harness"),
            shippedByGithubUserId: sql<number>`${context.principal.github.id}`.as(
              "shipped_by_github_user_id",
            ),
            currentUploadId: sql<string>`${uploadId}`.as("current_upload_id"),
            generation: sql<number>`1`.as("generation"),
            updatedAt: sql<number>`${completedAt.getTime()}`.as("updated_at"),
          })
          .from(traceStore)
          .where(and(eq(traceStore.id, store.id), eq(traceStore.status, "active"))),
      )
      .onConflictDoUpdate({
        target: [traceSession.storeId, traceSession.sessionId],
        set: {
          harness: sql`excluded.harness`,
          shippedByGithubUserId: sql`excluded.shipped_by_github_user_id`,
          currentUploadId: sql`excluded.current_upload_id`,
          generation: sql`generation + 1`,
          updatedAt: sql`excluded.updated_at`,
        },
        setWhere: sql`trace_session.generation = ${upload.baseGeneration}`,
      }),
```

If drizzle's `insert().select()` cannot be combined with `onConflictDoUpdate` in the installed version, write the statement with `sql` directly:

```ts
    db.run(sql`
      INSERT INTO trace_session (store_id, session_id, harness, shipped_by_github_user_id, current_upload_id, generation, updated_at)
      SELECT ${store.id}, ${sessionId}, ${upload.harness}, ${context.principal.github.id}, ${uploadId}, 1, ${completedAt.getTime()}
      WHERE EXISTS (SELECT 1 FROM trace_store WHERE id = ${store.id} AND status = 'active')
      ON CONFLICT (store_id, session_id) DO UPDATE SET
        harness = excluded.harness,
        shipped_by_github_user_id = excluded.shipped_by_github_user_id,
        current_upload_id = excluded.current_upload_id,
        generation = trace_session.generation + 1,
        updated_at = excluded.updated_at
      WHERE trace_session.generation = ${upload.baseGeneration}
    `),
```

Every later statement of the batch already guards on `pointsHere`, so a conflict still writes nothing.

- [ ] **Step 4: Run the worker suite**

Run: `pnpm --filter @dev-fast/review-web test:worker`
Expected: PASS, including "rejects a stale completion without partial writes" and "publishes only upload A when B begins during A's object check".

- [ ] **Step 5: Commit**

```bash
pnpm --filter @dev-fast/review-web typecheck
git add apps/review-web/src/lib/trace-api
git commit -m "fix(review-web): publish trace session metadata at completion, not at begin"
```

---

### Task B3: Repeated completion of the current upload links new commits

**Files:**

- Modify: `apps/review-web/src/lib/trace-api/uploads.server.ts`
- Test: `apps/review-web/src/lib/trace-api/router.worker.test.ts`

- [ ] **Step 1: Write the failing test**

Add:

```ts
it("links new commits when the current upload is completed again", async () => {
  await onboard();
  const { upload } = await publish("session-0060", [mainObject], [commit("a")]);
  const again = await complete("session-0060", upload.uploadId, [commit("b")]);
  expect(again.status).toBe(200);
  expect((await again.json<CompleteUploadResponse>()).commits).toEqual([
    commit("a"),
    commit("b"),
  ]);
  expect(await linkedCommits("session-0060")).toEqual([
    commit("a"),
    commit("b"),
  ]);
  expect(await sessionRow("session-0060")).toEqual({
    current_upload_id: upload.uploadId,
    generation: 1,
  });
});
```

Also amend the existing "returns the same receipt for a repeated completion" test: the first repeated call passes `[commit("a")]` and must still equal `receipt`; the late call on upload A (no longer current) with `[commit("c")]` must still leave `linkedCommits` at `[a, b]`. That test already asserts exactly this; keep it.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @dev-fast/review-web test:worker -- -t "links new commits"`
Expected: FAIL: commits are `[a]`.

- [ ] **Step 3: Implement**

In `completeUpload`, replace `if (upload.status === "complete") { return receipt(db, upload); }` with:

```ts
if (upload.status === "complete") {
  // The current upload accepts more commits; an older one is history.
  const additions = chunkForParameters(body.commits, 1, 5).map((chunk) =>
    db
      .insert(traceCommit)
      .select(
        sql`SELECT ${store.id}, column1, ${sessionId} FROM (VALUES ${sql.join(
          chunk.map((commitSha) => sql`(${commitSha})`),
          sql`, `,
        )}) WHERE ${pointsHere}`,
      )
      .onConflictDoNothing(),
  );
  if (additions.length > 0) {
    await db.batch([additions[0]!, ...additions.slice(1)]);
  }
  return receipt(db, upload);
}
```

Move the `const pointsHere = sql\`...\`` definition above this block so both paths share it.

- [ ] **Step 4: Run and commit**

```bash
pnpm --filter @dev-fast/review-web test:worker && pnpm --filter @dev-fast/review-web typecheck
git add apps/review-web/src/lib/trace-api
git commit -m "feat(review-web): link new commits on a repeated completion of the current upload"
```

---

### Task B4: Track stored bytes per repository

**Files:**

- Modify: `apps/review-web/src/db/schema.ts` (`traceStore.bytesStored`)
- Create: `apps/review-web/drizzle/migrations/0004_trace_store_bytes.sql` (generated, then edited for the backfill)
- Modify: `apps/review-web/src/lib/trace-api/uploads.server.ts` (completion batch)
- Modify: `apps/review-web/src/lib/trace-api/stores.server.ts` (`toStoreResponse`)
- Test: `apps/review-web/src/lib/trace-api/router.worker.test.ts`

- [ ] **Step 1: Write the failing test**

Add:

```ts
it("counts the bytes of every completed upload on the store", async () => {
  await onboard();
  const bigger: Declared = {
    name: "main.jsonl.gz",
    size: 10,
    sha256: sha("b"),
  };
  await publish("session-0070", [mainObject]);
  await publish("session-0070", [bigger]);
  await publish("session-0071", [mainObject]);
  // A begun but never completed upload adds nothing.
  await begin("session-0072", [bigger]);
  const response = await call(token, "GET", "/stores?owner=acme&name=app");
  expect(await response.json()).toMatchObject({ bytesStored: 3 + 10 + 3 });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @dev-fast/review-web test:worker -- -t "counts the bytes"`
Expected: FAIL: `bytesStored` is undefined.

- [ ] **Step 3: Schema and migration**

In `schema.ts`, in `traceStore` after `keyVersion`, add:

```ts
    /** Bytes of every completed upload in this instance. Nothing is ever subtracted; deletion is operator work. */
    bytesStored: integer("bytes_stored").notNull().default(0),
```

Run `pnpm --filter @dev-fast/review-web db:generate`. It writes `drizzle/migrations/0004_<name>.sql` and updates `meta/_journal.json` and `meta/0004_snapshot.json`. Rename nothing. Open the generated SQL (it should be one `ALTER TABLE trace_store ADD bytes_stored integer DEFAULT 0 NOT NULL;`) and append the backfill:

```sql
--> statement-breakpoint
UPDATE `trace_store` SET `bytes_stored` = (
	SELECT COALESCE(SUM(o.`size`), 0)
	FROM `trace_upload` u JOIN `trace_upload_object` o ON o.`upload_id` = u.`id`
	WHERE u.`store_id` = `trace_store`.`id` AND u.`status` = 'complete'
);
```

- [ ] **Step 4: Count at completion and expose it**

In `completeUpload`, compute `const uploadBytes = declared.reduce((total, object) => total + object.size, 0);` after `declared` is read, and add to the publish batch (after the `traceUpload` update):

```ts
    db
      .update(traceStore)
      .set({ bytesStored: sql`bytes_stored + ${uploadBytes}` })
      .where(and(eq(traceStore.id, store.id), pointsHere)),
```

In `stores.server.ts` `toStoreResponse`, add `bytesStored: row.bytesStored,`.

- [ ] **Step 5: Run and commit**

```bash
pnpm --filter @dev-fast/review-web test:worker && pnpm --filter @dev-fast/review-web test && pnpm --filter @dev-fast/review-web typecheck
git add apps/review-web/src/db/schema.ts apps/review-web/drizzle/migrations apps/review-web/src/lib/trace-api
git commit -m "feat(review-web): track stored trace bytes per repository store"
```

---

### Task B5: Keep branch and author with the upload

**Files:**

- Modify: `apps/review-web/src/db/schema.ts` (`traceUpload.branch`, `traceUpload.author`)
- Create: `apps/review-web/drizzle/migrations/0005_<generated>.sql`
- Modify: `apps/review-web/src/lib/trace-api/uploads.server.ts` (completion writes them)
- Modify: `apps/review-web/src/lib/trace-api/sessions.server.ts` (listing joins the current upload)
- Test: `apps/review-web/src/lib/trace-api/router.worker.test.ts`

- [ ] **Step 1: Write the failing test**

Add:

```ts
it("returns the branch and author sent at completion", async () => {
  await onboard();
  const upload = await begin("session-0080");
  put(upload, [mainObject]);
  const response = await call(
    token,
    "POST",
    `/stores/123/sessions/session-0080/uploads/${upload.uploadId}/complete`,
    { commits: [], branch: "feature/x", author: "Dev <dev@example.test>" },
  );
  expect(response.status).toBe(200);
  const listed = (await list("session=session-0080")).sessions[0]!;
  expect(listed).toMatchObject({
    branch: "feature/x",
    author: "Dev <dev@example.test>",
  });
  const older = (await list("session=session-0001")).sessions[0];
  expect(older?.branch ?? null).toBeNull();
});
```

(The second assertion is only meaningful if an earlier test in the same file published `session-0001`; the `beforeEach` clears tables, so replace it with a second publish in this test that omits the labels and expect `branch` to be `null`.)

- [ ] **Step 2: Run to verify it fails**

Expected: FAIL: `branch` absent.

- [ ] **Step 3: Implement**

Schema, in `traceUpload` after `harness`:

```ts
    /** Labels the client sent at completion; null when it sent none. */
    branch: text("branch"),
    author: text("author"),
```

Run `pnpm --filter @dev-fast/review-web db:generate` (produces 0005 with two `ALTER TABLE trace_upload ADD ...` statements; no backfill needed).

In `completeUpload`'s `traceUpload` update `set`, add `branch: body.branch ?? null, author: body.author ?? null,`.

In `sessions.server.ts`, add a fourth parallel query selecting `{ id, branch, author }` from `traceUpload` where `inArray(traceUpload.id, <the same currentUploadId subquery used for objects>)`, then in the mapped download add:

```ts
        branch: uploadLabels.get(uploadId)?.branch ?? null,
        author: uploadLabels.get(uploadId)?.author ?? null,
```

where `uploadLabels` is `new Map(uploads.map((row) => [row.id, row]))`.

- [ ] **Step 4: Run and commit**

```bash
pnpm --filter @dev-fast/review-web test:worker && pnpm --filter @dev-fast/review-web typecheck
git add apps/review-web/src/db/schema.ts apps/review-web/drizzle/migrations apps/review-web/src/lib/trace-api
git commit -m "feat(review-web): keep the branch and author of each trace upload"
```

---

### Task B6: Page the session listing

**Files:**

- Modify: `apps/review-web/src/lib/trace-api/sessions.server.ts`
- Test: `apps/review-web/src/lib/trace-api/router.worker.test.ts`

- [ ] **Step 1: Write the failing test**

Replace the assertions in "lists 99 sessions linked to one commit" with a paged walk:

```ts
const first = await list(`commit=${shared}&limit=40`);
expect(first.sessions).toHaveLength(40);
expect(first.nextCursor).toBe(first.sessions[39]!.sessionId);
const second = await list(
  `commit=${shared}&limit=40&cursor=${first.nextCursor}`,
);
expect(second.sessions).toHaveLength(40);
const third = await list(
  `commit=${shared}&limit=40&cursor=${second.nextCursor}`,
);
expect(third.sessions).toHaveLength(19);
expect(third.nextCursor).toBeUndefined();
const all = [...first.sessions, ...second.sessions, ...third.sessions];
expect(new Set(all.map((session) => session.sessionId)).size).toBe(99);
const unpaged = await list(`commit=${shared}`);
expect(unpaged.sessions).toHaveLength(99);
expect(unpaged.nextCursor).toBeUndefined();
```

Keep the `session=session-many-7` assertion. Add a second test that publishes 101 sessions on one commit and expects the default page to hold 100 with a `nextCursor`.

- [ ] **Step 2: Run to verify it fails**

Expected: FAIL: `first.sessions` has 99 entries.

- [ ] **Step 3: Implement**

In `listSessions`:

```ts
  const limit = Math.min(query.limit ?? DEFAULT_TRACE_SESSIONS_PAGE, MAX_TRACE_SESSIONS_PAGE);
  const matches = and(
    ...existing conditions...,
    query.cursor === undefined ? undefined : gt(traceSession.sessionId, query.cursor),
  );
  const page = await db
    .select()
    .from(traceSession)
    .where(matches)
    .orderBy(asc(traceSession.sessionId))
    .limit(limit + 1);
  const sessions = page.slice(0, limit);
  const nextCursor = page.length > limit ? sessions[sessions.length - 1]?.sessionId : undefined;
```

Then run the object and commit queries with `inArray(traceUploadObject.uploadId, sessions.map((s) => s.currentUploadId ?? ""))` and `inArray(traceCommit.sessionId, sessions.map((s) => s.sessionId))` (chunk the `inArray` lists with `chunkForParameters` when a page can exceed 95 ids: use `limit` pages of at most 200, so split into chunks of 90 and concatenate results). Return `{ sessions: downloads, ...(nextCursor === undefined ? {} : { nextCursor }) }` written without a conditional spread: build `const response: ListSessionsResponse = { sessions: downloads }; if (nextCursor !== undefined) response.nextCursor = nextCursor; return response;`.

Import `asc`, `gt` from `drizzle-orm` and `DEFAULT_TRACE_SESSIONS_PAGE`, `MAX_TRACE_SESSIONS_PAGE` from `@dev.fast/trace-shared`.

- [ ] **Step 4: Run and commit**

```bash
pnpm --filter @dev-fast/review-web test:worker && pnpm --filter @dev-fast/review-web typecheck
git add apps/review-web/src/lib/trace-api
git commit -m "feat(review-web): page the trace session listing"
```

---

### Task B7: Classify GitHub secondary rate limits as rate limits

**Files:**

- Modify: `apps/review-web/src/lib/github-client.server.ts` (`toGitHubApiError`)
- Test: `apps/review-web/src/lib/github-client.server.test.ts`

- [ ] **Step 1: Write the failing test**

Extend "maps authentication and rate-limit errors":

```ts
await expect(
  new GitHubClient(
    "token",
    async () =>
      new Response(
        JSON.stringify({
          message:
            "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
        }),
        {
          status: 403,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": "60",
            "X-RateLimit-Remaining": "4999",
          },
        },
      ),
  ).listUserRepositories(),
).rejects.toMatchObject({ code: "rate_limit", status: 403 });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @dev-fast/review-web test -- src/lib/github-client.server.test.ts`
Expected: FAIL: code is `permission`.

- [ ] **Step 3: Implement**

In `toGitHubApiError`, replace the rate-limit condition:

```ts
  const headers = error.response?.headers ?? {};
  const secondaryLimit =
    error.status === 403 &&
    (headers["retry-after"] !== undefined ||
      /secondary rate limit|abuse detection/i.test(error.message));
  if (
    error.status === 429 ||
    (error.status === 403 && headers["x-ratelimit-remaining"] === "0") ||
    secondaryLimit
  ) {
```

- [ ] **Step 4: Run and commit**

```bash
pnpm --filter @dev-fast/review-web test -- src/lib/github-client.server.test.ts && pnpm --filter @dev-fast/review-web typecheck
git add apps/review-web/src/lib/github-client.server.ts apps/review-web/src/lib/github-client.server.test.ts
git commit -m "fix(review-web): treat GitHub secondary rate limits as rate limits, not denials"
```

---

### Task B8: Malformed percent-encoding answers 400, and drop the unreachable 204 branch

**Files:**

- Modify: `apps/review-web/src/lib/trace-api/router.server.ts`
- Test: `apps/review-web/src/lib/trace-api/router.worker.test.ts`

- [ ] **Step 1: Write the failing test**

Add to "rejects an unknown path and a wrong method" (or a new test):

```ts
const malformed = await call(
  token,
  "POST",
  "/stores/123/sessions/%zz/uploads",
  {
    harness: "claude",
    objects: [mainObject],
  },
);
expect(malformed.status).toBe(400);
expect(await errorCode(malformed)).toBe("invalid_request");
```

- [ ] **Step 2: Run to verify it fails**

Expected: FAIL: status 500.

- [ ] **Step 3: Implement**

```ts
function decodeSegment(value: string | undefined): string {
  try {
    return decodeURIComponent(value ?? "");
  } catch {
    throw new StoreApiError("invalid_request", 400, "The path is not valid.");
  }
}

function sessionIdOf(value: string | undefined): string {
  return sessionIdSchema.parse(decodeSegment(value));
}

function uploadIdOf(value: string | undefined): string {
  const parsed = uploadIdSchema.safeParse(decodeSegment(value));
  if (!parsed.success) {
    throw new StoreApiError("not_found", 404, "This upload does not exist.");
  }
  return parsed.data;
}
```

And `function json(status: number, body: unknown): Response { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }); }`.

- [ ] **Step 4: Run and commit**

```bash
pnpm --filter @dev-fast/review-web test:worker && pnpm --filter @dev-fast/review-web typecheck
git add apps/review-web/src/lib/trace-api/router.server.ts apps/review-web/src/lib/trace-api/router.worker.test.ts
git commit -m "fix(review-web): answer 400 for malformed trace path segments"
```

---

### Task B9: Documentation

**Files:**

- Modify: `docs/superpowers/plans/2026-09-04-hosted-trajectory-authz-testing.md` line 12
- Modify: `docs/superpowers/plans/2026-09-03-manual-e2e-testing.md` lines 131 and 198
- Modify: `docs/superpowers/specs/2026-09-02-hosted-trajectory-storage-design.md` (superseded note)

- [ ] **Step 1: Edit**

Line 12 of the authz test plan: "- Read operations require `push`. Read-only collaborators cannot discover or read traces (alpha decision, 2026-09-08)." Line 131 of the manual e2e doc: replace "A collaborator with only read access can pull;" with "A collaborator with only read access is refused with `forbidden`;". Line 198: replace the `pull`-on-a-fresh-machine sentence's permission claim the same way. In the superseded note of the design spec add one sentence: "Every store row now carries `bytes_stored`, the running total of completed uploads, so a per-repository cap can be added at begin without a schema change."

- [ ] **Step 2: Commit**

```bash
git add docs
git commit -m "docs(review-web): record push-only trace reads and the stored-bytes counter"
```

---

### Task B10: Final verification and push

- [ ] **Step 1: Full checks**

```bash
pnpm --filter @dev-fast/review-web typecheck
pnpm --filter @dev-fast/review-web test
pnpm --filter @dev-fast/review-web test:worker
git status --short
```

Expected: all green; `git status` shows only `pnpm-lock.yaml` and `pnpm-workspace.yaml` modified.

- [ ] **Step 2: Push**

```bash
git push origin fix/hosted-traces-alpha
```

Expected: the branch updates on origin. Do not open or modify PR #1052; the user decides how the alpha branch lands.

---

## Self-review notes

- Coverage: Review findings 1-11 map to A2-A9 and A10; the minor items (unknown `?storage=`, source picker, test isolation, mock identity, vocabulary) live in A2, A6, A10. Dev findings 1-6, 9, 10 (partly), 11 map to B2-B8; finding 3 (no GC/quota/limits) is deliberately reduced to the byte counter (B4) per the user's decision; finding 7 is docs (B9); finding 8 is `deny --delete-store` (A9); finding 12 is the wire test (A9).
- Type consistency: `TraceStorageDeniedError` is thrown by `HostedTraceStorage.resolve` (A2) and handled in `review-api.ts` (A2); `spawnDetachedTraceSync` is defined in A4 and used in A4 only; `sameObjects`/`publishResult` are defined and used in A8; `bytesStored` is added in A1 and read in A9/B4; `branch`/`author` are added in A1, sent in A8, stored in B5; `nextCursor`/`cursor`/`limit` are added in A1, followed in A8, served in B6.
- Not changed on purpose: `source: "r2"` in the protocol (widening it would break older Desktops against a newer CLI); `GET /stores/:id` and `key_version` stay.

## Execution notes (2026-09-10, overnight run)

Every task above was executed; both branches are pushed. Deviations and pitfalls found while executing, for anyone repeating or extending this plan:

- **Formatter.** The Review repo formats with `oxfmt`, not biome: `pnpm -w exec oxfmt --write <files>` from the repo root. Paths are relative to the root even under `pnpm -w exec`, so a relative `src/...` path from a package directory silently formats nothing.
- **Test path in A3 step 4.** The install test lives at `src/server/cli-install.test.ts`; vitest silently skips a path that does not exist, so a wrong path gives a false green.
- **A4 spy.** `vi.spyOn` on the `import * as hookRunner` namespace works under vitest 4 with `isolate: false`; the `REVIEW_TRACE_COMMAND` fallback was not needed.
- **A4 scope (found by CI, not locally).** `runReviewTraceGitHook` first called `traceMachineEnabled()` with no scope, so the gate read the real home. On a developer machine with capture enabled the hook test passed; on CI with an empty home it returned early and `prunes stale sessions before stamping a Git commit` failed. The git hook now takes optional `homeDir`/`env` like the session hook, and the hook tests pass them. Run the Review suite with `HOME=$(mktemp -d)` before pushing to catch this class of dependence.
- **A4 behavior change, intended.** Bucket users' pre-push uploads and trailer stamping now stop when the machine capture switch is off; previously only the session hook honored it. Recorded in the commit message.
- **A3 `configured`.** A hosted machine with capture switched off now reports `configured: true` (the store is configured, capture is off). The Desktop capture section reads `enabled` for the chip, so nothing visible changed, but any consumer keyed on `configured` should know.
- **A2 lookups.** `lookupReviewTraceSession` (used by `review trace lookup`) now throws `TraceStorageDeniedError` on a refusal instead of answering `has_raw_trace: false`; the CLI prints the reason. The hosted test was updated accordingly.
- **A6 bundle check.** The contract constant lands in a shared chunk (`dist/review-source-ref-*.js`), not `dist/cli.js`; check with `grep -rl "/api/trace/v1" packages/progressive-review/dist`.
- **A8 memo and tests.** Two existing hosted tests re-seeded the transport and reloaded through the same storage instance; they now build a second instance for the second phase, which models a second CLI command.
- **A9 lint.** The anti-slop rules rejected an inline object type annotation and a `typeof` narrowing in the wire test; the listener address is parsed with a zod schema instead. Rerun `typecheck` after any lint-driven edit: the first CI failure was a `"port" in address` narrowing that lint accepted and TypeScript rejected.
- **B1 tarball caching.** pnpm keys a `file:` tarball by the integrity recorded in the lockfile, so repacking to the same path leaves the old contents installed even with `--force`. The reliable path is a new file name: the local override in `pnpm-workspace.yaml` now points at `dev.fast-trace-shared-0.2.0-fixes.tgz` (uncommitted, as before).
- **B2 drizzle.** `db.insert(table).select(sql\`...\`).onConflictDoUpdate({ ..., setWhere })` works on drizzle-orm 0.45.2 against D1. Three existing worker tests asserted a session row after a failed publish; they now assert no row, which is the new semantics.
- **B4/B5 migrations.** Generated as `0004_chilly_hannibal_king.sql` (with a hand-added backfill statement) and `0005_abandoned_absorbing_man.sql` via `pnpm db:generate`, so the drizzle journal and snapshots stay consistent. Migration 0003 was left untouched.
- **Not done, by decision.** No garbage collection, quota, or rate limiting on the Dev side; only the `bytes_stored` counter. No change to the `source: "r2"` protocol enum.
