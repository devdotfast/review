import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough, type Writable } from "node:stream";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { type StoredReview, createReviewDir } from "./review-home";
import { requireCompletedAgentResponsesForRepublish } from "./review-publish-thread-gate";
import { appendReviewComment } from "./review-state-store";
import { cleanupTempDirs, gitRepository } from "./review-test-utils";
import {
  closeAllReviewThreadStores,
  reviewThreadDbPath,
} from "./review-thread-store-backend";
import {
  runReviewThreadsGet,
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
  await cleanupTempDirs();
});

describe("review threads CLI", () => {
  it("reads the attached thread through the sandbox proxy", async () => {
    const payload = {
      review: "review-proxy",
      state: "draft",
      comment: {
        threadId: "thread-proxy",
        target: { kind: "document" },
        status: "open",
        messages: [],
      },
    };
    let destination: string | undefined;
    let request = "";
    const proxy = createServer();
    proxy.on("connect", (incoming, socket) => {
      destination = incoming.url;
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.on("data", (chunk) => {
        request += chunk.toString();
        if (!request.includes("\r\n\r\n")) return;
        const body = JSON.stringify(payload);
        socket.end(
          `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
        );
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    try {
      // listen above binds a TCP port and has completed successfully.
      const address = proxy.address() as AddressInfo;
      const output = await captureOutput((stdout) =>
        runReviewThreadsGet({
          cwd: process.cwd(),
          threadId: "thread-proxy",
          stdout,
          env: {
            DEV_FAST_REVIEW_AGENT_THREAD_URL:
              "http://review.invalid:12345/agent-threads",
            DEV_FAST_REVIEW_AGENT_THREAD_TOKEN: "proxy-test-token",
            HTTP_PROXY: `http://127.0.0.1:${address.port}`,
            NO_PROXY: "",
          },
        }),
      );
      expect(JSON.parse(output)).toEqual(payload);
      expect(destination).toBe("review.invalid:12345");
      expect(request).toContain("GET /agent-threads/thread-proxy HTTP/1.1");
      expect(request).toContain("x-review-token: proxy-test-token");
    } finally {
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

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
  const root = await gitRepository();
  const home = await mkdtemp(path.join(os.tmpdir(), "review-threads-home-"));
  cleanups.push(home);
  vi.stubEnv("DEV_REVIEW_HOME", home);
  const review = await createReviewDir({
    worktreePath: root,
    baseRef: "main",
    baseCommit: await git(root, ["rev-parse", "HEAD"]),
  });
  const document = path.join(review.dir, "review.mdx");
  return { root, review, document };
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
