import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { isReviewReapable, writeReviewRecord } from "../review-attention";
import { type StoredReview, createReviewDir, findReview } from "../review-home";
import { writeReviewPreferences } from "../review-preferences";
import { createGlobalReviewServer } from "./desktop-server";

const execFilePromise = promisify(execFile);
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const token = "review-reaper-test-token";
const DAY_MS = 86_400_000;

afterEach(() => vi.unstubAllEnvs());

describe("reapDismissedReviews", () => {
  it("closes an open historical (promoted: false) session before reaping its storage, leaving no zombie", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "review-reaper-home-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);
    const repo = await makeGitRepositoryWithTwoCommits();

    try {
      const stored = await createReviewDir({
        worktreePath: repo.root,
        baseRef: "main",
        baseCommit: repo.baseCommit,
        sourceCommit: repo.headCommit,
      });
      await writeReviewRecord(stored, {
        presentedDocumentRevision: repo.headCommit,
        status: "awaiting-review",
      });
      // Keep reaping off until the session is open: `null` makes the reaper
      // return immediately, so the listen-time reaper tick is a true no-op.
      await writeReviewPreferences({ dismissedRetentionDays: null });

      const server = createReaperServer(home);
      await server.listen();
      try {
        // Opening a historical revision registers a non-promoted session that
        // the old guard (activeSessionForReview with session.promoted) ignored.
        const opened = await openReview(server.url, stored.review.uuid, {
          revision: repo.baseCommit,
        });
        expect(opened.status).toBe(201);
        const sessionId = opened.body.sessionId;
        expect(opened.body.session.historicalRevision).toBe(repo.baseCommit);

        await expect(sessionsList(server.url)).resolves.toEqual([
          expect.objectContaining({ historicalRevision: repo.baseCommit }),
        ]);

        // Now make the review reapable while the historical session is open,
        // then arm the reaper. This is the trigger: a dismissed review past
        // retention with only an open historical session for its uuid.
        const longAgo = new Date(Date.now() - 40 * DAY_MS);
        const reapable = await writeReviewRecord(
          await requireReview(stored.review.uuid),
          { dismissedAt: longAgo.toISOString() },
        );
        expect(isReviewReapable(reapable.review, 1)).toBe(true);
        await setRetention(server.url, 1);

        // GET /reviews runs the reaper. The review is reaped (absent from the
        // returned list) and its storage directory is removed.
        const reviews = await listReviews(server.url);
        expect(reviews.map((review) => review.uuid)).not.toContain(
          stored.review.uuid,
        );
        expect(existsSync(stored.dir)).toBe(false);

        // The historical session was closed before the directory was removed:
        // no zombie lingers in the sessions map. Pre-fix, the reaper deleted
        // the directory out from under the live historical session and left it
        // registered, so this list still contained it.
        await expect(sessionsList(server.url)).resolves.toEqual([]);

        // A request to the closed session returns a clean "Session not found."
        // error rather than dispatching to a session whose storage has been
        // rm -rf'd (which produced ENOENT storms on the uncached disk-reading
        // routes pre-fix).
        await expect(sessionProbe(server.url, sessionId)).resolves.toEqual([
          404,
          { ok: false, error: "Session not found." },
        ]);

        await expect(findReview(stored.review.uuid)).resolves.toBeNull();
      } finally {
        await server.close();
      }
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(repo.root, { recursive: true, force: true });
    }
  });

  it("closes an open promoted session for a reapable review instead of deferring", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "review-reaper-home-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);
    const repo = await makeGitRepositoryWithTwoCommits();

    try {
      const stored = await createReviewDir({
        worktreePath: repo.root,
        baseRef: "main",
        baseCommit: repo.baseCommit,
        sourceCommit: repo.headCommit,
      });
      await writeReviewRecord(stored, {
        presentedDocumentRevision: repo.headCommit,
        status: "awaiting-review",
      });
      await writeReviewPreferences({ dismissedRetentionDays: null });

      const server = createReaperServer(home);
      await server.listen();
      try {
        // Open the current revision: a promoted session. Opening clears
        // dismissedAt, so make the review reapable afterwards while the
        // promoted session is still open.
        const opened = await openReview(server.url, stored.review.uuid, {});
        expect(opened.status).toBe(201);
        const sessionId = opened.body.sessionId;
        expect(opened.body.session.historicalRevision).toBeUndefined();
        await expect(sessionsList(server.url)).resolves.toHaveLength(1);

        const longAgo = new Date(Date.now() - 40 * DAY_MS);
        const reapable = await writeReviewRecord(
          await requireReview(stored.review.uuid),
          { dismissedAt: longAgo.toISOString() },
        );
        expect(isReviewReapable(reapable.review, 1)).toBe(true);
        await setRetention(server.url, 1);

        const reviews = await listReviews(server.url);
        expect(reviews.map((review) => review.uuid)).not.toContain(
          stored.review.uuid,
        );
        expect(existsSync(stored.dir)).toBe(false);

        // The reaper closes the open session (any session, not just promoted
        // deferral) and reaps the review, leaving no zombie. Pre-fix, a
        // promoted session made the reaper `continue`, so the dismissed review
        // would have stayed on disk with the session still open.
        await expect(sessionsList(server.url)).resolves.toEqual([]);
        await expect(sessionProbe(server.url, sessionId)).resolves.toEqual([
          404,
          { ok: false, error: "Session not found." },
        ]);
        await expect(findReview(stored.review.uuid)).resolves.toBeNull();
      } finally {
        await server.close();
      }
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(repo.root, { recursive: true, force: true });
    }
  });

  it("closes a session registered after the reaper snapshot but before its lock (no delete under reader)", async () => {
    // G13: a session registered for a review between the reaper's outer
    // selectReapableReviews snapshot and its acquisition of the review lock is
    // closed inside the lock, not deleted under. Two reapable reviews A and B:
    // A has an open historical session whose close() is slow, so the reaper
    // holds A's review lock long enough to let us register B's historical
    // session (after the snapshot, before the reaper reaches B).
    const home = await mkdtemp(path.join(tmpdir(), "review-reaper-home-"));
    vi.stubEnv("DEV_REVIEW_HOME", home);
    const repo = await makeGitRepositoryWithTwoCommits();
    const uuidA = "11111111-1111-4111-8111-111111111111";
    const uuidB = "22222222-2222-4222-8222-222222222222";

    try {
      const a = await createReviewDir({
        uuid: uuidA,
        worktreePath: repo.root,
        baseRef: "main",
        baseCommit: repo.baseCommit,
        sourceCommit: repo.headCommit,
      });
      const b = await createReviewDir({
        uuid: uuidB,
        worktreePath: repo.root,
        baseRef: "main",
        baseCommit: repo.baseCommit,
        sourceCommit: repo.headCommit,
      });
      for (const stored of [a, b]) {
        await writeReviewRecord(stored, {
          presentedDocumentRevision: repo.headCommit,
          status: "awaiting-review",
          dismissedAt: new Date(Date.now() - 40 * DAY_MS).toISOString(),
        });
      }
      await writeReviewPreferences({ dismissedRetentionDays: null });

      const server = createReaperServer(home, uuidA);
      await server.listen();
      try {
        // Open A's historical session first. Its handler.close() sleeps 200ms,
        // so the reaper will hold A's review lock for that long while closing
        // it. A stays reapable (open historical does not clear dismissedAt).
        const openedA = await openReview(server.url, uuidA, {
          revision: repo.baseCommit,
        });
        expect(openedA.status).toBe(201);
        await expect(sessionsList(server.url)).resolves.toHaveLength(1);

        // Arm the reaper, then fire GET /reviews (which runs it) without
        // awaiting. The reaper snapshots [A, B] and starts reaping A.
        await setRetention(server.url, 1);
        const reaping = listReviews(server.url);

        // While A's lock is held (slow close), open B's historical session.
        // B's session is registered AFTER the snapshot but BEFORE the reaper
        // reaches B's lock.
        const openedB = await openReview(server.url, uuidB, {
          revision: repo.baseCommit,
        });
        expect(openedB.status).toBe(201);
        const sessionIdB = openedB.body.sessionId;

        const reviews = await reaping;
        expect(reviews.map((review) => review.uuid)).not.toContain(uuidA);
        expect(reviews.map((review) => review.uuid)).not.toContain(uuidB);
        expect(existsSync(a.dir)).toBe(false);
        expect(existsSync(b.dir)).toBe(false);

        // Both sessions were closed inside their locks before rm: no zombies.
        await expect(sessionsList(server.url)).resolves.toEqual([]);
        await expect(
          sessionProbe(server.url, openedA.body.sessionId),
        ).resolves.toEqual([404, { ok: false, error: "Session not found." }]);
        await expect(sessionProbe(server.url, sessionIdB)).resolves.toEqual([
          404,
          { ok: false, error: "Session not found." },
        ]);
        await expect(findReview(uuidA)).resolves.toBeNull();
        await expect(findReview(uuidB)).resolves.toBeNull();
      } finally {
        await server.close();
      }
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(repo.root, { recursive: true, force: true });
    }
  });
});

function createReaperServer(
  home: string,
  slowCloseUuid?: string,
  slowCloseMs = 200,
) {
  return createGlobalReviewServer({
    appPid: process.pid,
    packageRoot,
    toolingRoot: packageRoot,
    port: 0,
    token,
    discoveryPath: path.join(home, "desktop.json"),
    publishRuntime: {
      materializePublishRevision: async ({ review, revision }) =>
        materializeBuildRevision(review, revision),
    },
    sessionHandlerFactory: async (input) => ({
      token,
      handle: async () => new Response("not found", { status: 404 }),
      close: async () => {
        if (input.reviewUuid === slowCloseUuid) {
          await new Promise((resolve) => setTimeout(resolve, slowCloseMs));
        }
      },
    }),
  });
}

async function materializeBuildRevision(
  review: StoredReview,
  revision: string,
): Promise<string> {
  const buildDir = path.join(review.dir, ".build", revision);
  await mkdir(buildDir, { recursive: true });
  const record = JSON.parse(
    await readFile(path.join(review.dir, "review.json"), "utf8"),
  );
  record.presentedDocumentRevision = revision;
  record.sourceCommit = revision;
  await writeFile(
    path.join(buildDir, "review.json"),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(buildDir, "review.mdx"),
    `# ${record.title ?? "Review"}\n`,
    "utf8",
  );
  return buildDir;
}

async function makeGitRepositoryWithTwoCommits(): Promise<{
  root: string;
  baseCommit: string;
  headCommit: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "review-reaper-git-"));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "review@example.test"]);
  await git(root, ["config", "user.name", "Review Test"]);
  await writeFile(path.join(root, "README.md"), "base\n", "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "base"]);
  const baseCommit = await git(root, ["rev-parse", "HEAD"]);
  await writeFile(path.join(root, "README.md"), "head\n", "utf8");
  await git(root, ["commit", "-am", "head"]);
  const headCommit = await git(root, ["rev-parse", "HEAD"]);
  return { root, baseCommit, headCommit };
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFilePromise("git", ["-C", root, ...args], {
    encoding: "utf8",
  });
  return stdout.trim();
}

function jsonHeaders() {
  return { "x-review-token": token, "content-type": "application/json" };
}

async function requireReview(uuid: string): Promise<StoredReview> {
  const found = await findReview(uuid);
  if (!found) throw new Error(`Review ${uuid} not found on disk.`);
  return found;
}

async function setRetention(url: string, days: number): Promise<void> {
  const response = await fetch(`${url}/preferences`, {
    method: "PUT",
    headers: jsonHeaders(),
    body: JSON.stringify({ dismissedRetentionDays: days }),
  });
  expect(response.status).toBe(200);
}

type OpenResponseBody = {
  sessionId: string;
  session: { historicalRevision?: string };
};

async function openReview(
  url: string,
  uuid: string,
  body: { revision?: string },
): Promise<{ status: number; body: OpenResponseBody }> {
  const response = await fetch(`${url}/reviews/${uuid}/open`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as never };
}

async function listReviews(url: string): Promise<{ uuid: string }[]> {
  const response = await fetch(`${url}/reviews`, { headers: jsonHeaders() });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { reviews: { uuid: string }[] };
  return body.reviews;
}

type SessionDescriptor = { historicalRevision?: string };

async function sessionsList(url: string): Promise<SessionDescriptor[]> {
  const response = await fetch(`${url}/sessions`, { headers: jsonHeaders() });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { items: SessionDescriptor[] };
  return body.items;
}

async function sessionProbe(
  url: string,
  sessionId: string,
): Promise<[number, { ok: boolean; error: string }]> {
  const response = await fetch(`${url}/sessions/${sessionId}`, {
    headers: jsonHeaders(),
  });
  return [response.status, (await response.json()) as never];
}
