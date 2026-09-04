import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ReviewRecordSchema } from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ReviewDocumentApiError,
  mutateReviewDocument,
  parseIncrementalReviewDocument,
  readReviewDocumentSnapshot,
  serializeIncrementalReviewDocument,
} from "./incremental-review-document";
import type { StoredReview } from "./review-home";
import { closeAllReviewStateDatabases } from "./review-state-db";

const roots: string[] = [];

afterEach(async () => {
  closeAllReviewStateDatabases();
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("incremental Review documents", () => {
  it("round-trips the restricted stable-node MDX format", () => {
    const source = serializeIncrementalReviewDocument(7, [
      { id: "intro", kind: "markdown", content: "# Hello\n\nWorld" },
      {
        id: "warning",
        kind: "callout",
        tone: "warning",
        title: "Careful",
        content: "Mind the edge.",
      },
    ]);

    expect(parseIncrementalReviewDocument(source)).toEqual({
      revision: 7,
      nodes: [
        { id: "intro", kind: "markdown", content: "# Hello\n\nWorld" },
        {
          id: "warning",
          kind: "callout",
          tone: "warning",
          title: "Careful",
          content: "Mind the edge.",
        },
      ],
    });
  });

  it("converts a compiled document only with source-hash concurrency", async () => {
    const review = await makeReview("# Existing rich MDX\n");
    const compiled = await readReviewDocumentSnapshot(review);
    expect(compiled).toMatchObject({ mode: "compiled", revision: 0 });

    await expect(
      mutateReviewDocument(review, {
        mutationId: "replace-without-hash",
        expectedRevision: 0,
        operation: { type: "replace", nodes: [] },
      }),
    ).rejects.toMatchObject({
      code: "source_hash_required",
      statusCode: 409,
    });

    const replaced = await mutateReviewDocument(review, {
      mutationId: "replace-1",
      expectedRevision: 0,
      expectedSourceHash: compiled.sourceHash,
      operation: {
        type: "replace",
        nodes: [{ id: "intro", kind: "markdown", content: "# New" }],
      },
    });
    expect(replaced.snapshot).toMatchObject({
      mode: "incremental",
      revision: 1,
      nodes: [{ id: "intro", content: "# New" }],
    });

    const retried = await mutateReviewDocument(review, {
      mutationId: "replace-1",
      expectedRevision: 0,
      expectedSourceHash: compiled.sourceHash,
      operation: { type: "replace", nodes: [] },
    });
    expect(retried).toEqual(replaced);
  });

  it("applies insert, update, move, and delete by stable node ID", async () => {
    const review = await makeReview(
      serializeIncrementalReviewDocument(2, [
        { id: "a", kind: "markdown", content: "A" },
        { id: "b", kind: "markdown", content: "B" },
      ]),
    );
    await mutateReviewDocument(review, {
      mutationId: "insert-c",
      expectedRevision: 2,
      operation: {
        type: "insert",
        index: 1,
        node: { id: "c", kind: "callout", content: "C" },
      },
    });
    await mutateReviewDocument(review, {
      mutationId: "update-c",
      expectedRevision: 3,
      operation: {
        type: "update",
        nodeId: "c",
        patch: { title: "Changed", tone: "success" },
      },
    });
    await mutateReviewDocument(review, {
      mutationId: "move-b",
      expectedRevision: 4,
      operation: { type: "move", nodeId: "b", index: 0 },
    });
    const deleted = await mutateReviewDocument(review, {
      mutationId: "delete-a",
      expectedRevision: 5,
      operation: { type: "delete", nodeId: "a" },
    });

    expect(deleted.snapshot.nodes).toEqual([
      { id: "b", kind: "markdown", content: "B" },
      {
        id: "c",
        kind: "callout",
        content: "C",
        title: "Changed",
        tone: "success",
      },
    ]);
  });

  it("rejects stale mutations without changing the MDX file", async () => {
    const source = serializeIncrementalReviewDocument(3, [
      { id: "a", kind: "markdown", content: "A" },
    ]);
    const review = await makeReview(source);

    await expect(
      mutateReviewDocument(review, {
        mutationId: "stale",
        expectedRevision: 2,
        operation: { type: "delete", nodeId: "a" },
      }),
    ).rejects.toBeInstanceOf(ReviewDocumentApiError);
    await expect(
      readFile(path.join(review.dir, "review.mdx"), "utf8"),
    ).resolves.toBe(source);
  });

  it("recovers an idempotent receipt after the MDX write wins a crash", async () => {
    const source = serializeIncrementalReviewDocument(
      1,
      [{ id: "a", kind: "markdown", content: "A" }],
      "crash-window-mutation",
    );
    const review = await makeReview(source);

    const recovered = await mutateReviewDocument(review, {
      mutationId: "crash-window-mutation",
      expectedRevision: 0,
      operation: { type: "replace", nodes: [] },
    });

    expect(recovered.snapshot).toMatchObject({
      revision: 1,
      nodes: [{ id: "a" }],
    });
    await expect(
      readFile(path.join(review.dir, "review.mdx"), "utf8"),
    ).resolves.toBe(source);
  });
});

async function makeReview(source: string): Promise<StoredReview> {
  const home = await mkdtemp(path.join(os.tmpdir(), "incremental-review-"));
  roots.push(home);
  vi.stubEnv("DEV_REVIEW_HOME", home);
  const uuid = "11111111-1111-4111-8111-111111111111";
  const dir = path.join(home, "reviews", uuid);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "review.mdx"), source, "utf8");
  return {
    dir,
    review: ReviewRecordSchema.parse({
      schemaVersion: 4,
      uuid,
      repoKey: "repo",
      worktreePath: home,
      baseRef: "main",
      baseCommit: "a".repeat(40),
      sourceCommit: "b".repeat(40),
      sourceIdentity: { kind: "git-branch", name: "main" },
      pullRequestNumber: null,
      pullRequestUrl: null,
      title: "Incremental Review",
      sourceSession: "disabled:review",
      status: "draft",
      presentedDocumentRevision: null,
      presentedSoftwareMapRevision: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastPublishedAt: null,
    }),
  };
}
