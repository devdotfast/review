import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import { parseStoredReviewRecord } from "./review-home";
import {
  GUARDED_REVIEW_FIELDS,
  assertReviewUnchanged,
  reviewMutationFingerprint,
  withReviewMutationLock,
} from "./review-mutation-lock";
import { putReviewRecord } from "./review-state-db";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function guardedFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "review-guarded-fields-"));
  roots.push(root);
  const record = parseStoredReviewRecord({
    schemaVersion: 5,
    uuid: "11111111-1111-4111-8111-111111111111",
    repoKey: "repo",
    worktreePath: "/source",
    baseRef: "main",
    baseCommit: "a".repeat(40),
    sourceCommit: "b".repeat(40),
    sourceIdentity: { kind: "git-branch", name: "main" },
    title: "Guarded",
    sourceSession: "disabled:review",
    status: "draft",
    presentedDocumentRevision: "c".repeat(40),
    presentedSoftwareMapRevision: null,
    createdAt: "created",
    lastPublishedAt: "published",
  });
  await writeFile(path.join(root, "review.json"), JSON.stringify(record));
  return { root, record };
}

it("accepts an unchanged record and ignores a guarded field changed only in the review.json mirror", async () => {
  const { root, record } = await guardedFixture();
  await expect(assertReviewUnchanged(root, record)).resolves.toBeUndefined();
  for (const field of GUARDED_REVIEW_FIELDS) {
    // The guard reads the database record, not the mirror file: a
    // file-only edit must not trip it.
    await writeFile(
      path.join(root, "review.json"),
      JSON.stringify({ ...record, [field]: "changed-by-someone-else" }),
    );
    await expect(assertReviewUnchanged(root, record)).resolves.toBeUndefined();
  }
});

it("rejects a guarded field changed in the database", async () => {
  const { root, record } = await guardedFixture();
  await expect(assertReviewUnchanged(root, record)).resolves.toBeUndefined();
  for (const field of GUARDED_REVIEW_FIELDS) {
    putReviewRecord(root, { ...record, [field]: "changed-by-someone-else" });
    await expect(assertReviewUnchanged(root, record)).rejects.toThrow(
      "Review changed while preparing publication",
    );
    putReviewRecord(root, record);
  }
});

it("ignores unguarded metadata and source identity key order", async () => {
  const { root, record } = await guardedFixture();
  await writeFile(
    path.join(root, "review.json"),
    JSON.stringify({
      ...record,
      title: "Renamed",
      viewedAt: "2026-09-05T12:00:00.000Z",
      sourceIdentity: { name: "main", kind: "git-branch" },
    }),
  );
  await expect(assertReviewUnchanged(root, record)).resolves.toBeUndefined();
  expect(reviewMutationFingerprint(record)).toBe(
    reviewMutationFingerprint({
      ...record,
      title: "Renamed",
      sourceIdentity: { name: "main", kind: "git-branch" },
    }),
  );
});

it("allows nested operations in the same transaction without deadlocking", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "review-nested-lock-"));
  roots.push(root);
  expect(
    await withReviewMutationLock(root, () =>
      withReviewMutationLock(root, async () => "nested"),
    ),
  ).toBe("nested");
});

it("reports retryable contention and succeeds after the holder releases", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "review-busy-lock-"));
  roots.push(root);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const holding = withReviewMutationLock(root, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  try {
    await expect(
      withReviewMutationLock(root, async () => "overlap", { timeoutMs: 20 }),
    ).rejects.toMatchObject({
      name: "ReviewBusyError",
      code: "REVIEW_BUSY",
      retryable: true,
      reviewUuid: path.basename(root),
      message: expect.stringContaining(
        "Retry after its current operation completes",
      ),
    });
  } finally {
    release.resolve();
    await holding;
  }
  await expect(
    withReviewMutationLock(root, async () => "retried"),
  ).resolves.toBe("retried");
});

it("does not steal a healthy cross-process lock when its wait expires", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "review-busy-process-"));
  roots.push(parent);
  const root = path.join(parent, "review");
  await mkdir(root);
  const lockPath = `${root}.mutation-lock`;
  const script = path.join(parent, "holder.mjs");
  await writeFile(
    script,
    `import { mkdir, writeFile, rm } from "node:fs/promises";
const lockPath = process.argv[2];
await mkdir(lockPath);
await writeFile(lockPath + "/owner.json", JSON.stringify({ pid: process.pid }));
process.stdout.write("ready");
process.stdin.resume();
process.stdin.once("data", async () => { await rm(lockPath, { recursive: true }); process.exit(0); });
`,
  );
  const child = spawn(process.execPath, [script, lockPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  try {
    await once(child.stdout, "data");
    await expect(
      withReviewMutationLock(root, async () => "overlap", { timeoutMs: 20 }),
    ).rejects.toMatchObject({ code: "REVIEW_BUSY", retryable: true });
    expect(
      JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8")).pid,
    ).toBe(child.pid);
  } finally {
    child.stdin.end("release");
    await exited;
  }
  await expect(
    withReviewMutationLock(root, async () => "retried"),
  ).resolves.toBe("retried");
});
