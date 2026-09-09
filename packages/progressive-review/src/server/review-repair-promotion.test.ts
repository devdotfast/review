import { cp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import * as reviewHome from "../review-home";
import {
  type ReviewRepairReadyRequest,
  fingerprintReviewRepairInputs,
} from "../review-repair-state";
import { readReviewRecord } from "../review-state-db";
import { cleanupTempDirs, storedReviewFixture } from "../review-test-utils";
import { applyPreparedReviewRepair } from "./review-repair-promotion";

afterEach(cleanupTempDirs);

async function fixture() {
  const { reviewDir: dir, record } = await storedReviewFixture({
    schemaVersion: 4,
  });
  const stagingDir = path.join(path.dirname(dir), "stage");
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
    reviewUuid: String(record.uuid),
    stagingDir,
    expectedRecord: JSON.stringify(record),
    expectedFingerprint,
    newDocumentRevision: String(next.presentedDocumentRevision),
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
  request.newDocumentRevision = String(record.presentedDocumentRevision);
  await writeFile(
    path.join(request.stagingDir, "review.json"),
    JSON.stringify({ ...record, schemaVersion: 5 }),
  );
  await applyPreparedReviewRepair(dir, request);
  expect(
    JSON.parse(await readFile(path.join(dir, "review.json"), "utf8")),
  ).toEqual({ ...record, schemaVersion: 5 });
});
it("surfaces a mirror-refresh failure as a warning but still commits the database row", async () => {
  const { dir, request, next } = await fixture();
  const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
  const mirror = vi
    .spyOn(reviewHome, "refreshReviewMirror")
    .mockResolvedValue("mirror refresh failed: disk full");
  try {
    const result = await applyPreparedReviewRepair(dir, request);
    expect(result).toEqual(next);
    expect(mirror).toHaveBeenCalledWith(dir, next);
    expect(warned).toHaveBeenCalledWith("mirror refresh failed: disk full");
    expect(readReviewRecord(dir)).toEqual(next);
  } finally {
    mirror.mockRestore();
    warned.mockRestore();
  }
});
it("rejects concurrent inputs and restores all transaction bytes after promotion failure", async () => {
  const { dir, request } = await fixture();
  await writeFile(path.join(dir, "review.mdx"), "concurrent edit");
  await expect(applyPreparedReviewRepair(dir, request)).rejects.toThrow(
    "changed",
  );
  await rm(path.join(dir, "review.mdx"));
  const before = await fingerprintReviewRepairInputs(dir);
  await rm(path.join(request.stagingDir, ".git"), { recursive: true });
  await expect(applyPreparedReviewRepair(dir, request)).rejects.toMatchObject({
    code: "ENOENT",
    syscall: "lstat",
    path: path.join(request.stagingDir, ".git"),
  });
  expect(await fingerprintReviewRepairInputs(dir)).toBe(before);
});
