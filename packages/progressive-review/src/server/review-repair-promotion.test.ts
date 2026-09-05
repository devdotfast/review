import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import {
  type ReviewRepairReadyRequest,
  fingerprintReviewRepairInputs,
} from "../review-repair-state";
import { applyPreparedReviewRepair } from "./review-repair-promotion";

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  root = await mkdtemp(path.join(tmpdir(), "repair-promotion-"));
  const dir = path.join(root, "review");
  const stagingDir = path.join(root, "stage");
  await mkdir(path.join(dir, ".git"), { recursive: true });
  await mkdir(path.join(dir, ".bundle"));
  const record = {
    schemaVersion: 4,
    uuid: "11111111-1111-4111-8111-111111111111",
    repoKey: "repo",
    worktreePath: "/source",
    baseRef: "main",
    baseCommit: "a".repeat(40),
    sourceCommit: "b".repeat(40),
    sourceIdentity: null,
    title: "Keep title",
    sourceSession: "disabled:review",
    status: "accepted",
    presentedDocumentRevision: "c".repeat(40),
    presentedSoftwareMapRevision: null,
    createdAt: "created",
    lastPublishedAt: "published",
    viewedAt: "viewed",
    dismissedAt: "dismissed",
  };
  await writeFile(path.join(dir, "review.json"), JSON.stringify(record));
  await writeFile(path.join(dir, ".git", "HEAD"), "old-ref");
  await writeFile(path.join(dir, ".bundle", "old"), "old");
  const expectedFingerprint = await fingerprintReviewRepairInputs(dir);
  await cp(dir, stagingDir, { recursive: true });
  const next = {
    ...record,
    schemaVersion: 5,
    presentedDocumentRevision: "d".repeat(40),
  };
  await writeFile(path.join(stagingDir, "review.json"), JSON.stringify(next));
  await writeFile(path.join(stagingDir, ".git", "HEAD"), "new-ref");
  const request: ReviewRepairReadyRequest = {
    reviewUuid: record.uuid,
    stagingDir,
    expectedRecord: JSON.stringify(record),
    expectedFingerprint,
    newDocumentRevision: next.presentedDocumentRevision,
    newMapRevision: null,
    sourceFallback: { document: false, map: false },
  };
  return { dir, request, record, next };
}
it("promotes only schema and artifact fields for an accepted review", async () => {
  const { dir, request, next } = await fixture();
  await applyPreparedReviewRepair(dir, request);
  expect(
    JSON.parse(await readFile(path.join(dir, "review.json"), "utf8")),
  ).toEqual(next);
  expect(await readFile(path.join(dir, ".git", "HEAD"), "utf8")).toBe(
    "new-ref",
  );
});
it("upgrades legacy metadata without moving healthy artifact pointers", async () => {
  const { dir, request, record } = await fixture();
  request.newDocumentRevision = record.presentedDocumentRevision;
  await writeFile(
    path.join(request.stagingDir, "review.json"),
    JSON.stringify({ ...record, schemaVersion: 5 }),
  );
  await applyPreparedReviewRepair(dir, request);
  expect(
    JSON.parse(await readFile(path.join(dir, "review.json"), "utf8")),
  ).toEqual({ ...record, schemaVersion: 5 });
});
it("rejects concurrent inputs and restores all transaction bytes after promotion failure", async () => {
  const { dir, request } = await fixture();
  await writeFile(path.join(dir, "review.mdx"), "concurrent edit");
  await expect(applyPreparedReviewRepair(dir, request)).rejects.toThrow(
    "changed",
  );
  await rm(path.join(dir, "review.mdx"));
  const before = await fingerprintReviewRepairInputs(dir);
  await expect(
    applyPreparedReviewRepair(dir, request, {
      writeRecord: async () => {
        throw new Error("disk full");
      },
    }),
  ).rejects.toThrow("disk full");
  expect(await fingerprintReviewRepairInputs(dir)).toBe(before);
});
