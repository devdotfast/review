import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";

import { afterEach, expect, it } from "vitest";

import { runProgressiveReviewCli } from "./cli-runner";
import { createReviewDir, findReview } from "./review-home";
import {
  commandThreadsClient,
  readThreadsClient,
  requestReviewLifecycle,
} from "./review-lifecycle-client";
import { ReviewDocumentFileResponseSchema } from "./review-lifecycle-contracts";
import { startLifecycleTestServer } from "./review-lifecycle-test-utils";
import { runReviewMcp } from "./review-mcp";
import {
  cleanupTempDirs,
  gitRepository,
  reviewHome,
} from "./review-test-utils";
import { closeAllReviewThreadStores } from "./review-thread-store-backend";

let server: Awaited<ReturnType<typeof startLifecycleTestServer>> | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  closeAllReviewThreadStores();
  await cleanupTempDirs();
});

async function fixture() {
  await reviewHome();
  const worktreePath = await gitRepository();
  const commit = execFileSync(
    "git",
    ["-C", worktreePath, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  ).trim();
  const review = await createReviewDir({
    worktreePath,
    baseRef: "main",
    baseCommit: commit,
    sourceCommit: commit,
  });
  server = await startLifecycleTestServer();
  return review;
}

it("authors rich live nodes through the desktop API and rejects competing edits", async () => {
  const review = await fixture();
  const reviewUuid = review.review.uuid;
  const initial = ReviewDocumentFileResponseSchema.parse(
    await requestReviewLifecycle("/lifecycle/document/read", {
      reviewUuid,
      name: "review.mdx",
    }),
  );
  const request = {
    reviewUuid,
    mutationId: randomUUID(),
    expectedSourceHash: initial.sourceHash,
    operation: {
      type: "replace",
      nodes: [{ id: "title", source: "# API authored" }],
    },
  };
  const accepted = await requestReviewLifecycle(
    "/lifecycle/document/mutate",
    request,
  );
  expect(accepted).toMatchObject({ revision: 1, mode: "incremental" });
  expect(
    await requestReviewLifecycle("/lifecycle/document/mutate", request),
  ).toEqual(accepted);
  await expect(
    requestReviewLifecycle("/lifecycle/document/mutate", {
      ...request,
      mutationId: randomUUID(),
    }),
  ).rejects.toThrow("source changed");
  expect(
    await requestReviewLifecycle("/lifecycle/document/live", { reviewUuid }),
  ).toEqual(accepted);
  await server!.close();
  server = await startLifecycleTestServer();
  expect(
    await requestReviewLifecycle("/lifecycle/document/live", { reviewUuid }),
  ).toEqual(accepted);
});

it("serializes source edits, rejects stale writes and symlinks, and preserves accepted content", async () => {
  const review = await fixture();
  const target = { reviewUuid: review.review.uuid, name: "review.mdx" };
  const initial = ReviewDocumentFileResponseSchema.parse(
    await requestReviewLifecycle("/lifecycle/document/read", target),
  );
  const writes = await Promise.allSettled(
    ["# One\n", "# Two\n"].map((source) =>
      requestReviewLifecycle("/lifecycle/document/write", {
        ...target,
        source,
        expectedSourceHash: initial.sourceHash,
      }),
    ),
  );
  expect(writes.filter((result) => result.status === "fulfilled")).toHaveLength(
    1,
  );
  expect(writes.filter((result) => result.status === "rejected")).toHaveLength(
    1,
  );
  const current = ReviewDocumentFileResponseSchema.parse(
    await requestReviewLifecycle("/lifecycle/document/read", target),
  );
  expect(await readFile(path.join(review.dir, "review.mdx"), "utf8")).toBe(
    current.source,
  );
  // A lost-response retry is successful even with the old precondition.
  expect(
    await requestReviewLifecycle("/lifecycle/document/write", {
      ...target,
      source: current.source,
      expectedSourceHash: initial.sourceHash,
    }),
  ).toEqual(current);
  await rm(path.join(review.dir, "data.ts"));
  await symlink(
    path.join(review.dir, "review.mdx"),
    path.join(review.dir, "data.ts"),
  );
  await expect(
    requestReviewLifecycle("/lifecycle/document/write", {
      ...target,
      name: "data.ts",
      source: "bad",
      expectedSourceHash: null,
    }),
  ).rejects.toThrow("regular file");
  expect(await readFile(path.join(review.dir, "review.mdx"), "utf8")).toBe(
    current.source,
  );
});

it("persists metadata with a title precondition and isolates each Review's comments", async () => {
  const review = await fixture();
  const other = await createReviewDir({
    worktreePath: review.review.worktreePath,
    baseRef: "main",
    baseCommit: "b".repeat(40),
  });
  await requestReviewLifecycle("/lifecycle/metadata", {
    reviewUuid: review.review.uuid,
    expectedTitle: review.review.title,
    title: "API title",
  });
  await expect(
    requestReviewLifecycle("/lifecycle/metadata", {
      reviewUuid: review.review.uuid,
      expectedTitle: review.review.title,
      title: "Lost update",
    }),
  ).rejects.toThrow("title changed");
  expect((await findReview(review.review.uuid))?.review).toMatchObject({
    title: "API title",
    titleOverride: "API title",
  });
  const created = await commandThreadsClient(review.review.uuid, {
    command: "comment.create",
    mutationId: randomUUID(),
    input: {
      threadId: "question",
      messageId: "message",
      body: "Why?",
      target: { kind: "document" },
    },
  });
  const resolved = await commandThreadsClient(review.review.uuid, {
    command: "comment.update",
    mutationId: randomUUID(),
    threadId: "question",
    update: { status: "resolved" },
  });
  expect(resolved.revision).toBe(created.revision + 1);
  expect((await readThreadsClient(other.review.uuid)).comments).toEqual({});
  await server!.close();
  server = await startLifecycleTestServer();
  expect(
    (await readThreadsClient(review.review.uuid)).comments.question?.status,
  ).toBe("resolved");
});

it("MCP reads and writes source through the desktop and reports conflicts as tool errors", async () => {
  const review = await fixture();
  const stdout = new PassThrough();
  let output = "";
  stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "review_get_document_file",
        arguments: { reviewUuid: review.review.uuid, name: "review.mdx" },
      },
    },
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "review_write_document_file",
        arguments: {
          reviewUuid: review.review.uuid,
          name: "review.mdx",
          expectedSourceHash: "stale",
          source: "# Stale\n",
        },
      },
    },
  ];
  await runReviewMcp({
    stdin: Readable.from(messages.map((value) => `${JSON.stringify(value)}\n`)),
    stdout,
  });
  const responses = output
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(responses.map((response) => response.id)).toEqual([1, 2, 3, 4]);
  expect(responses[1].result.tools).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: "review_publish",
        inputSchema: expect.objectContaining({ type: "object" }),
      }),
    ]),
  );
  expect(responses[2].result.structuredContent.source).toContain("#");
  expect(responses[3].result.isError).toBe(true);
  expect(responses[3].result.content[0].text).toContain("source changed");
});

it("the document CLI accepts stdin and returns the API's updated source hash", async () => {
  const review = await fixture();
  const target = { reviewUuid: review.review.uuid, name: "review.mdx" };
  const initial = ReviewDocumentFileResponseSchema.parse(
    await requestReviewLifecycle("/lifecycle/document/read", target),
  );
  const stdout = new PassThrough();
  let output = "";
  stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  expect(
    await runProgressiveReviewCli({
      argv: [
        "document",
        "write",
        "review.mdx",
        "--review",
        target.reviewUuid,
        "--expected-hash",
        initial.sourceHash!,
      ],
      stdin: Readable.from(["# Authored via stdin\n"]),
      stdout,
      stderr: new PassThrough(),
    }),
  ).toBe(0);
  const written = ReviewDocumentFileResponseSchema.parse(JSON.parse(output));
  expect(written.source).toBe("# Authored via stdin\n");
  expect(written.sourceHash).not.toBe(initial.sourceHash);
  expect(
    await requestReviewLifecycle("/lifecycle/document/read", target),
  ).toEqual(written);
});
