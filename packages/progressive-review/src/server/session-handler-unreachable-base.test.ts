import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { REVIEW_SCHEMA_VERSION } from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it } from "vitest";

import { writePrivateJsonAtomic } from "./desktop-paths";
import {
  type ReviewSessionHandlerInput,
  createReviewSessionHandler,
} from "./session-handler";

const unusedAgentServices = {
  openNativeAgentTerminal: async () => {
    throw new Error("This test does not open a native agent terminal.");
  },
} satisfies Pick<ReviewSessionHandlerInput, "openNativeAgentTerminal">;

const cleanupPaths: string[] = [];

afterEach(async () => {
  const paths = cleanupPaths.splice(0);
  for (const candidate of paths) {
    await rm(candidate, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function gitQuiet(cwd: string, args: string[]) {
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "ignore", "ignore"],
  });
}

async function createGitRepo(prefix: string): Promise<string> {
  const rawRootPath = await mkdtemp(path.join(tmpdir(), prefix));
  const rootPath = await realpath(rawRootPath);
  cleanupPaths.push(rootPath);
  gitQuiet(rootPath, ["init", "-b", "main"]);
  gitQuiet(rootPath, ["config", "user.email", "review@example.com"]);
  gitQuiet(rootPath, ["config", "user.name", "Review Test"]);
  return rootPath;
}

interface ReviewRecordFixture {
  worktreePath: string;
  baseCommit: string;
}

async function writeReviewRecord(
  reviewRootPath: string,
  fixture: ReviewRecordFixture,
): Promise<void> {
  cleanupPaths.push(reviewRootPath);
  await writePrivateJsonAtomic(path.join(reviewRootPath, "review.json"), {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    uuid: randomUUID(),
    repoKey: "test-repo",
    worktreePath: fixture.worktreePath,
    baseRef: "main",
    baseCommit: fixture.baseCommit,
    sourceCommit: null,
    sourceIdentity: null,
    title: "Test review",
    sourceSession: "test-session",
    status: "awaiting-review",
    presentedDocumentRevision: null,
    presentedSoftwareMapRevision: null,
    createdAt: new Date(0).toISOString(),
    lastPublishedAt: null,
  });
}

async function makeHandler(input: {
  gitRoot: string;
  reviewRootPath: string;
  baseCommit: string;
  headRef: string;
}) {
  await writeReviewRecord(input.reviewRootPath, {
    worktreePath: input.gitRoot,
    baseCommit: input.baseCommit,
  });
  const reviewPath = path.join(input.reviewRootPath, "review.mdx");
  const sessionUrl = "http://127.0.0.1:5570/sessions/test-session";
  const token = "session-secret";
  const handler = await createReviewSessionHandler({
    ...unusedAgentServices,
    rootPath: input.reviewRootPath,
    toolingRoot: input.reviewRootPath,
    reviewPath,
    reviewRootPath: input.reviewRootPath,
    routePath: "/",
    token,
    session: {
      rootPath: input.reviewRootPath,
      baseRef: "main",
      headRef: input.headRef,
      appUrl: sessionUrl,
      reviewPath,
      startedAt: Date.now(),
    },
  });
  const request = () =>
    handler.handle(
      new Request(new URL("/__progressive-review/session", sessionUrl), {
        headers: { "x-review-token": token },
      }),
    );
  return { handler, request };
}

describe("review session handler — unreachable pinned base commit", () => {
  it("returns 200 with resolvedBaseRef null when the pinned base commit is unreachable", async () => {
    const gitRoot = await createGitRepo("session-unreachable-base-");
    git(gitRoot, ["commit", "--allow-empty", "-q", "-m", "main"]);
    const headRef = git(gitRoot, ["rev-parse", "HEAD"]);
    git(gitRoot, ["checkout", "-q", "-b", "doomed"]);
    git(gitRoot, ["commit", "--allow-empty", "-q", "-m", "doomed base"]);
    const doomed = git(gitRoot, ["rev-parse", "HEAD"]);
    git(gitRoot, ["checkout", "-q", "main"]);
    gitQuiet(gitRoot, ["branch", "-q", "-D", "doomed"]);
    gitQuiet(gitRoot, ["reflog", "expire", "--expire=now", "--all"]);
    gitQuiet(gitRoot, ["gc", "-q", "--prune=now"]);
    const reviewRootPath = await mkdtemp(
      path.join(tmpdir(), "session-unreachable-record-"),
    );
    const { handler, request } = await makeHandler({
      gitRoot,
      reviewRootPath,
      baseCommit: doomed,
      headRef,
    });

    try {
      const response = await request();

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        ok: boolean;
        session: { resolvedBaseRef: string | null; headRef?: string };
      };
      expect(body.ok).toBe(true);
      expect(body.session.resolvedBaseRef).toBeNull();
      // Degraded mode keeps head intact (see thread-target-model.tsx seeding).
      expect(body.session.headRef).toBe(headRef);
    } finally {
      await handler.close();
    }
  });

  it("returns 200 with the resolved base SHA when the pinned base commit is reachable", async () => {
    const gitRoot = await createGitRepo("session-reachable-base-");
    git(gitRoot, ["commit", "--allow-empty", "-q", "-m", "base"]);
    const baseCommit = git(gitRoot, ["rev-parse", "HEAD"]);
    const headRef = baseCommit;
    const reviewRootPath = await mkdtemp(
      path.join(tmpdir(), "session-reachable-record-"),
    );
    const { handler, request } = await makeHandler({
      gitRoot,
      reviewRootPath,
      baseCommit,
      headRef,
    });

    try {
      const response = await request();

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        ok: boolean;
        session: { resolvedBaseRef: string | null; headRef?: string };
      };
      expect(body.ok).toBe(true);
      expect(body.session.resolvedBaseRef).toBe(baseCommit);
      expect(body.session.headRef).toBe(headRef);
    } finally {
      await handler.close();
    }
  });
});
