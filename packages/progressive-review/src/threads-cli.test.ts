import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, type Writable } from "node:stream";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { type StoredReview, createReviewDir } from "./review-home";
import { requireCompletedAgentResponsesForRepublish } from "./review-publish-thread-gate";
import { appendReviewComment } from "./review-state-store";
import {
  closeAllReviewThreadStores,
  reviewThreadDbPath,
} from "./review-thread-store-backend";
import {
  runReviewThreadsList,
  runReviewThreadsReply,
  runReviewThreadsResolve,
} from "./threads-cli";

const execFilePromise = promisify(execFile);

const cleanups: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  closeAllReviewThreadStores();
  for (const dir of cleanups.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("review threads CLI", () => {
  it("lists, replies to, and resolves comment threads", async () => {
    const { root, review, document } = await makeReview();

    appendReviewComment(document, {
      threadId: "thread-1",
      messageId: "message-1",
      target: { kind: "document" },
      body: "Please fix.",
      author: "Reviewer",
    });
    const listed = JSON.parse(
      await captureOutput((stdout) =>
        runReviewThreadsList({ cwd: root, stdout }),
      ),
    );
    expect(listed).toMatchObject({
      review: review.review.uuid,
      comments: {
        "thread-1": { status: "open", messages: [{ body: "Please fix." }] },
      },
    });

    const replied = JSON.parse(
      await captureOutput((stdout) =>
        runReviewThreadsReply({
          cwd: root,
          threadId: "thread-1",
          body: "Fixed in the latest revision.",
          stdout,
        }),
      ),
    );
    expect(replied).toMatchObject({ event: "replied", threadId: "thread-1" });

    const resolved = JSON.parse(
      await captureOutput((stdout) =>
        runReviewThreadsResolve({ cwd: root, threadId: "thread-1", stdout }),
      ),
    );
    expect(resolved).toMatchObject({
      event: "resolved",
      threadId: "thread-1",
    });

    const after = JSON.parse(
      await captureOutput((stdout) =>
        runReviewThreadsList({ cwd: root, stdout }),
      ),
    );
    expect(after.comments["thread-1"]).toMatchObject({
      status: "resolved",
      messages: [
        { body: "Please fix.", by: "Reviewer" },
        { body: "Fixed in the latest revision.", by: "Agent", role: "agent" },
      ],
    });

    // The reply counts as the completed model response the republish gate
    // requires for current-round threads.
    expect(() =>
      requireCompletedAgentResponsesForRepublish({
        ...review,
        review: {
          ...review.review,
          presentedDocumentRevision: "published-revision",
          lastPublishedAt: "2000-01-01T00:00:00.000Z",
        },
      }),
    ).not.toThrow();

    expect(existsSync(reviewThreadDbPath(document))).toBe(true);
  });

  it("rejects unknown threads and reviews", async () => {
    const { root } = await makeReview();
    await expect(
      runReviewThreadsResolve({
        cwd: root,
        threadId: "missing",
        stdout: outputStream(),
      }),
    ).rejects.toThrow("Comment thread not found: missing");
    await expect(
      runReviewThreadsList({
        cwd: root,
        reviewUuid: "22222222-2222-4222-8222-222222222222",
        stdout: outputStream(),
      }),
    ).rejects.toThrow("Review not found");
  });
});

async function makeReview(): Promise<{
  root: string;
  review: StoredReview;
  document: string;
}> {
  const root = await makeGitRepository();
  const home = await mkdtemp(path.join(os.tmpdir(), "review-threads-home-"));
  cleanups.push(root, home);
  vi.stubEnv("DEV_REVIEW_HOME", home);
  const review = await createReviewDir({
    worktreePath: root,
    baseRef: "main",
    baseCommit: await git(root, ["rev-parse", "HEAD"]),
  });
  const document = path.join(review.dir, "review.mdx");
  return { root, review, document };
}

async function makeGitRepository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "review-threads-source-"));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "review@example.test"]);
  await git(root, ["config", "user.name", "Review Test"]);
  await writeFile(path.join(root, "README.md"), "# Review\n", "utf8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial"]);
  return root;
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFilePromise("git", ["-C", root, ...args], {
    encoding: "utf8",
  });
  return stdout.trim();
}

async function captureOutput(
  run: (stdout: Writable) => Promise<number>,
): Promise<string> {
  const stream = new PassThrough();
  let output = "";
  stream.on("data", (chunk) => (output += String(chunk)));
  await expect(run(stream)).resolves.toBe(0);
  return output;
}

function outputStream(): PassThrough {
  return new PassThrough();
}
