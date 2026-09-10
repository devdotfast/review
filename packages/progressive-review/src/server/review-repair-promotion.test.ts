import { execFileSync } from "node:child_process";
import { readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { REVIEW_SCHEMA_VERSION } from "@dev.fast/review-protocol";
import { afterEach, expect, it, vi } from "vitest";

import { installReviewArtifact } from "../review-artifact-store";
import { bundleReviewDocument } from "../review-bundle";
import * as reviewHome from "../review-home";
import { createReviewDir } from "../review-home";
import {
  type MapActivationCandidate,
  activateReviewPublication,
} from "../review-publication-activation";
import { reviewSourceContext } from "../review-publication-candidate";
import {
  type ReviewRepairCandidate,
  type ReviewRepairDocumentReplacement,
  prepareReviewRepair,
} from "../review-repair-preparation";
import { listPublications, readReviewRecord } from "../review-state-db";
import {
  cleanupTempDirs,
  gitRepository,
  reviewHome as reviewHomeDir,
} from "../review-test-utils";
import {
  bundleReviewSoftwareMap,
  softwareMapArtifactBytes,
} from "../software-map-bundle";
import { defineSoftwareMap } from "../software-map-model";
import { applyPreparedReviewRepair } from "./review-repair-promotion";

const scratch: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((cleanup) => cleanup()));
  await cleanupTempDirs();
});

const MODEL = defineSoftwareMap({ systems: { app: { label: "App" } } });

/**
 * A Review published entirely through publication rows whose stored document
 * bytes were then lost, so `prepareReviewRepair` yields a real replacement
 * candidate the promotion gates can be pointed at.
 */
async function fixture(options: { map?: boolean } = {}) {
  const withMap = options.map ?? true;
  await reviewHomeDir();
  const source = await realpath(await gitRepository());
  const commit = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const stored = await createReviewDir({
    worktreePath: source,
    baseRef: "main",
    baseCommit: commit,
    sourceCommit: commit,
    sourceIdentity: { kind: "git-branch", name: "main" },
  });
  await writeFile(path.join(stored.dir, "review.mdx"), "# Published\n");
  const context = reviewSourceContext(stored.review);
  const document = await installReviewArtifact(
    stored.dir,
    "document",
    bundleReviewDocument({
      format: "review-document/1",
      title: "Published",
      routePath: "/",
      sourcePath: "review.mdx",
      body: [],
      anchors: {},
      anchorContents: {},
      softwareModels: [],
    }).json,
  );
  const map = await installReviewArtifact(
    stored.dir,
    "map",
    softwareMapArtifactBytes(
      bundleReviewSoftwareMap({
        base: MODEL,
        head: MODEL,
        baseCommit: commit,
        headCommit: commit,
      }),
    ),
  );
  const activated = await activateReviewPublication({
    reviewDir: stored.dir,
    expected: { guarded: stored.review },
    candidates: [
      ...(withMap
        ? [
            {
              kind: "map" as const,
              artifactHash: map.hash,
              headCommit: commit,
              baseCommit: commit,
              context,
              operation: "map-publish" as const,
            },
          ]
        : []),
      {
        kind: "document",
        artifactHash: document.hash,
        title: "Published",
        titleSource: "document",
        context,
        operation: "publish",
      },
    ],
    updateRecord: (latest) => latest,
  });
  // Losing the stored document bytes is what a repair exists to undo; the map
  // artifact stays healthy so its publication is untouched.
  await rm(path.join(stored.dir, "artifacts", "documents"), {
    recursive: true,
    force: true,
  });
  const prepared = await prepareReviewRepair({ reviewDir: stored.dir });
  if (prepared.kind !== "prepared") throw new Error("Expected a repair");
  scratch.push(prepared.candidate.cleanup);
  return {
    dir: stored.dir,
    commit,
    review: activated.review,
    candidate: prepared.candidate,
  };
}

function replacement(
  candidate: ReviewRepairCandidate,
): ReviewRepairDocumentReplacement {
  if (candidate.document.kind !== "replace")
    throw new Error("Expected a replaced document");
  return candidate.document;
}

/** A map replacement the fixture never prepares, for the cross-pin gates. */
async function mapReplacement(
  dir: string,
  pins: { baseCommit: string; headCommit: string },
) {
  const bundle = bundleReviewSoftwareMap({
    base: MODEL,
    head: MODEL,
    ...pins,
  });
  const installed = await installReviewArtifact(
    dir,
    "map",
    softwareMapArtifactBytes(bundle),
  );
  const candidate: MapActivationCandidate = {
    kind: "map",
    artifactHash: installed.hash,
    headCommit: pins.headCommit,
    baseCommit: pins.baseCommit,
    context: {
      baseRef: "main",
      baseCommit: pins.baseCommit,
      sourceCommit: pins.headCommit,
      sourceIdentity: null,
    },
    operation: "repair",
  };
  return {
    kind: "replace" as const,
    candidate,
    bundle,
    usedEditableSources: false,
  };
}

it("commits a repair row and leaves every other record field alone", async () => {
  const { dir, candidate, review } = await fixture();
  const before = listPublications(dir, "document");
  const next = await applyPreparedReviewRepair(dir, candidate);
  const after = listPublications(dir, "document");
  expect(after).toHaveLength(2);
  expect(after[1]).toEqual(before[0]);
  expect(after[0]?.operation).toBe("repair");
  expect(next).toEqual({
    ...review,
    schemaVersion: REVIEW_SCHEMA_VERSION,
    presentedDocumentRevision: after[0]?.publicationId,
  });
  expect(readReviewRecord(dir)).toEqual(next);
});

it("surfaces a mirror-refresh failure as a warning but still commits the row", async () => {
  const { dir, candidate } = await fixture();
  const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
  const mirror = vi
    .spyOn(reviewHome, "refreshReviewMirror")
    .mockResolvedValue("mirror refresh failed: disk full");
  try {
    const next = await applyPreparedReviewRepair(dir, candidate);
    expect(warned).toHaveBeenCalledWith("mirror refresh failed: disk full");
    expect(readReviewRecord(dir)).toEqual(next);
    expect(listPublications(dir, "document")).toHaveLength(2);
  } finally {
    mirror.mockRestore();
    warned.mockRestore();
  }
});

it("rejects concurrent authoring edits without inserting a row", async () => {
  const { dir, candidate } = await fixture();
  await writeFile(path.join(dir, "review.mdx"), "# Concurrent edit\n");
  await expect(applyPreparedReviewRepair(dir, candidate)).rejects.toThrow(
    "changed",
  );
  expect(listPublications(dir, "document")).toHaveLength(1);
});

it("refuses a record that changes anything but its pointers and schema", async () => {
  const { dir, candidate } = await fixture();
  await expect(
    applyPreparedReviewRepair(dir, {
      ...candidate,
      next: { ...candidate.next, status: "accepted" },
    }),
  ).rejects.toThrow(/preserve review status/);
  expect(listPublications(dir, "document")).toHaveLength(1);
});

it("refuses replacement bytes the artifact store does not hold", async () => {
  const { dir, candidate } = await fixture();
  const document = replacement(candidate);
  await expect(
    applyPreparedReviewRepair(dir, {
      ...candidate,
      document: {
        ...document,
        bundle: { ...document.bundle, json: '{"format":"tampered"}' },
      },
    }),
  ).rejects.toMatchObject({ code: "repair_document_invalid", statusCode: 422 });
  expect(listPublications(dir, "document")).toHaveLength(1);
});

it("refuses a replacement that repins its predecessor's code context", async () => {
  const { dir, candidate } = await fixture();
  const document = replacement(candidate);
  await expect(
    applyPreparedReviewRepair(dir, {
      ...candidate,
      document: {
        ...document,
        candidate: {
          ...document.candidate,
          context: {
            ...document.candidate.context,
            baseCommit: "f".repeat(40),
          },
        },
      },
    }),
  ).rejects.toMatchObject({ code: "repair_document_pins", statusCode: 422 });
  expect(listPublications(dir, "document")).toHaveLength(1);
});

it("refuses a software map whose pins disagree with the repaired document", async () => {
  const { dir, candidate, commit } = await fixture();
  const map = await mapReplacement(dir, {
    baseCommit: commit,
    headCommit: "a".repeat(40),
  });
  await expect(
    applyPreparedReviewRepair(dir, { ...candidate, map }),
  ).rejects.toMatchObject({ code: "repair_map_pins", statusCode: 422 });
  expect(listPublications(dir, "map")).toHaveLength(1);
});

it("refuses to invent a software map the Review never presented", async () => {
  const { dir, candidate, commit } = await fixture({ map: false });
  expect(candidate.map).toEqual({ kind: "unchanged", publicationId: null });
  const map = await mapReplacement(dir, {
    baseCommit: commit,
    headCommit: commit,
  });
  await expect(
    applyPreparedReviewRepair(dir, { ...candidate, map }),
  ).rejects.toThrow(/invent an absent software map/);
  expect(listPublications(dir, "map")).toEqual([]);
});

it("refuses to discard a software map the current schema requires", async () => {
  const { dir, candidate } = await fixture();
  await expect(
    applyPreparedReviewRepair(dir, {
      ...candidate,
      map: { kind: "drop-absent" },
      next: { ...candidate.next, presentedSoftwareMapRevision: null },
    }),
  ).rejects.toThrow(/discard a presented software map/);
  expect(readReviewRecord(dir)).toMatchObject({
    presentedSoftwareMapRevision: expect.any(String),
  });
});

it("reports the record the repair was prepared against", async () => {
  const { dir, candidate } = await fixture();
  expect(JSON.parse(candidate.expectedRecordJson)).toEqual(
    readReviewRecord(dir),
  );
  expect(
    await readFile(path.join(dir, "review.json"), "utf8").then(JSON.parse),
  ).toEqual(readReviewRecord(dir));
});
