import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { createGitLabTextDiffPosition } from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createReviewDir, updateReviewPins } from "./review-home";
import {
  appendReviewComment,
  appendReviewCommentDraft,
  readReviewCommentDrafts,
  readReviewComments,
} from "./review-state-store";
import { closeAllReviewThreadStores } from "./review-thread-store-backend";

const execFilePromise = promisify(execFile);

const homes: string[] = [];
const roots: string[] = [];

afterEach(async () => {
  closeAllReviewThreadStores();
  vi.unstubAllEnvs();
  await Promise.all([
    ...homes
      .splice(0)
      .map((home) => rm(home, { recursive: true, force: true })),
    ...roots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  ]);
});

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFilePromise("git", ["-C", root, ...args], {
    encoding: "utf8",
  });
  return stdout.trim();
}

async function makeGitRepository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "draft-reply-src-"));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "review@example.test"]);
  await git(root, ["config", "user.name", "Draft Reply Test"]);
  await writeFile(path.join(root, "README.md"), "# Repo\n", "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial"]);
  roots.push(root);
  return root;
}

async function makeOutdatedReview(): Promise<{ reviewPath: string }> {
  const root = await makeGitRepository();
  const home = await mkdtemp(path.join(os.tmpdir(), "draft-reply-home-"));
  homes.push(home);
  vi.stubEnv("DEV_REVIEW_HOME", home);

  await writeFile(
    path.join(root, "example.ts"),
    "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n",
  );
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "add example"]);
  const originalCommit = await git(root, ["rev-parse", "HEAD"]);
  const created = await createReviewDir({
    worktreePath: root,
    baseRef: "main",
    baseCommit: originalCommit,
    sourceCommit: originalCommit,
    sourceIdentity: { kind: "git-branch", name: "main" },
  });
  const reviewPath = path.join(created.dir, "review.mdx");
  const originalPosition = createGitLabTextDiffPosition({
    base_sha: originalCommit,
    start_sha: originalCommit,
    head_sha: originalCommit,
    old_path: "example.ts",
    new_path: "example.ts",
    start: { old_line: null, new_line: 8 },
    end: { old_line: null, new_line: 9 },
  });
  appendReviewComment(reviewPath, {
    threadId: "thread-1",
    messageId: "message-1",
    target: {
      kind: "code",
      original_position: originalPosition,
      position: originalPosition,
    },
    body: "Keep this range",
    author: "Reviewer",
  });

  await git(root, ["mv", "example.ts", "renamed.ts"]);
  await writeFile(
    path.join(root, "renamed.ts"),
    "one\ninserted one\ninserted two\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n",
  );
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "insert lines"]);
  const movedCommit = await git(root, ["rev-parse", "HEAD"]);
  const movedReview = await updateReviewPins(created, {
    baseRef: "main",
    baseCommit: originalCommit,
    sourceCommit: movedCommit,
    sourceIdentity: { kind: "git-branch", name: "main" },
    sourceSession: created.review.sourceSession,
  });

  await writeFile(
    path.join(root, "renamed.ts"),
    "one\ninserted one\ninserted two\ntwo\nthree\nfour\nfive\nsix\nseven\nchanged\nnine\nten\n",
  );
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "change selected line"]);
  const changedCommit = await git(root, ["rev-parse", "HEAD"]);
  await updateReviewPins(movedReview, {
    baseRef: "main",
    baseCommit: originalCommit,
    sourceCommit: changedCommit,
    sourceIdentity: { kind: "git-branch", name: "main" },
    sourceSession: movedReview.review.sourceSession,
  });

  const outdated = readReviewComments(reviewPath)["thread-1"]!;
  if (outdated.target.kind !== "code") {
    throw new Error("Expected a code target for the outdated thread.");
  }
  expect(outdated.target.change_position).toBeTruthy();

  return { reviewPath };
}

describe("appendReviewCommentDraft outdated-thread reply", () => {
  it("accepts a reply carrying the stored outdated target like appendReviewComment does", async () => {
    const { reviewPath } = await makeOutdatedReview();
    const outdated = readReviewComments(reviewPath)["thread-1"]!;

    const replyInput = {
      threadId: "thread-1",
      messageId: "message-reply",
      target: outdated.target,
      body: "Reply to outdated thread",
      author: "Reviewer",
    };

    appendReviewComment(reviewPath, replyInput);

    const draftResult = appendReviewCommentDraft(reviewPath, replyInput);
    expect(draftResult.threadId).toBe("thread-1");
    expect(draftResult.draft.thread.threadId).toBe("thread-1");
    expect(readReviewCommentDrafts(reviewPath)["thread-1"]).toBeDefined();
  });

  it("still validates a fresh code target when creating a new draft thread", async () => {
    const { reviewPath } = await makeOutdatedReview();
    const outdated = readReviewComments(reviewPath)["thread-1"]!;

    expect(() =>
      appendReviewCommentDraft(reviewPath, {
        threadId: "thread-fresh",
        messageId: "message-fresh",
        target: outdated.target,
        body: "Should not create from an outdated target",
        author: "Reviewer",
      }),
    ).toThrow(/Code target must contain a current text diff position/);
  });

  it("still rejects a reply whose target differs from the stored thread", async () => {
    const { reviewPath } = await makeOutdatedReview();
    const outdated = readReviewComments(reviewPath)["thread-1"]!;
    if (outdated.target.kind !== "code") {
      throw new Error("Expected a code target for the outdated thread.");
    }
    const mismatchedTarget = {
      ...outdated.target,
      position: {
        ...outdated.target.position,
        new_path: "different-path.ts",
      },
    };

    expect(() =>
      appendReviewCommentDraft(reviewPath, {
        threadId: "thread-1",
        messageId: "message-mismatch",
        target: mismatchedTarget,
        body: "Reply with a different target",
        author: "Reviewer",
      }),
    ).toThrow(/already targets different content/i);
  });
});
