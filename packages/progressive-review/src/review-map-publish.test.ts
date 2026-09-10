import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";

import { afterEach, expect, it, vi } from "vitest";

import { createReviewDir } from "./review-home";
import { withReviewMutationLock } from "./review-mutation-lock";
import { prepareReviewSoftwareMapCandidate } from "./review-publication-candidate";
import { parsePublicationRecord } from "./review-publication-record";
import { listPublications, putReviewRecord } from "./review-state-db";
import { cleanupTempDirs } from "./review-test-utils";
import { closeAllReviewThreadStores } from "./review-thread-store-backend";
import {
  publicationHarness,
  softwareMapNote,
} from "./server/publication-test-utils";
import { bundleReviewSoftwareMap } from "./software-map-bundle";
import { defineSoftwareMap } from "./software-map-model";

const roots: string[] = [];
afterEach(async () => {
  closeAllReviewThreadStores();
  await cleanupTempDirs();
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it("takes the mutation lock around the software-map candidate install", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "review-map-publish-"));
  roots.push(home);
  vi.stubEnv("DEV_REVIEW_HOME", home);
  const source = path.join(home, "source");
  await mkdir(source);
  const git = (args: string[]) =>
    execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "review@example.test"]);
  git(["config", "user.name", "Review Test"]);
  await writeFile(path.join(source, "README.md"), "# Source\n");
  git(["add", "."]);
  git(["commit", "-qm", "source"]);
  const commit = git(["rev-parse", "HEAD"]);
  const review = await createReviewDir({
    worktreePath: source,
    baseRef: "main",
    baseCommit: commit,
    sourceCommit: commit,
    sourceIdentity: { kind: "git-branch", name: "main" },
  });
  const model = defineSoftwareMap({ systems: { app: { label: "App" } } });
  const bundle = bundleReviewSoftwareMap({
    head: model,
    base: model,
    headCommit: commit,
    baseCommit: commit,
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const holding = withReviewMutationLock(review.dir, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  let finished = false;
  const preparing = prepareReviewSoftwareMapCandidate({ review, bundle }).then(
    (candidate) => {
      finished = true;
      return candidate.artifactHash;
    },
  );
  for (let attempt = 0; attempt < 30; attempt++) await setImmediate();
  const bypassed = finished;
  release.resolve();
  await holding;
  await expect(preparing).resolves.toMatch(/^[a-f0-9]{64}$/);
  expect(bypassed).toBe(false);
  // A candidate is bytes only: no row references it yet.
  expect(listPublications(review.dir, "map")).toEqual([]);
});

it("pairs a published map with the presented document and republishes nothing when its bytes are unchanged", async () => {
  const harness = await publicationHarness({
    softwareMap: softwareMapNote("App"),
  });
  try {
    const published = await harness.publishDocument();
    expect(published).toMatchObject({ ok: true });
    const documentPublicationId = documentRevisionOf(published);

    const map = await harness.publishMap();
    expect(map.ok).toBe(true);
    expect(map.events).toContainEqual({
      event: "map-published",
      revision: expect.any(String),
      documentRevision: documentPublicationId,
      unchanged: false,
    });
    const rows = listPublications(harness.review.dir, "map");
    expect(rows).toHaveLength(1);
    const record = parsePublicationRecord(rows[0]!.record);
    if (record.kind !== "map") throw new Error("Expected a map publication");
    expect(record).toMatchObject({
      validatedDocumentPublicationId: documentPublicationId,
      headCommit: harness.sourceCommit,
      baseCommit: harness.sourceCommit,
      operation: "map-publish",
    });
    expect(record.artifact).toEqual({
      state: "stored",
      hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const stored = await (
      await harness.request(`/lifecycle/resolve`, {
        cwd: harness.source,
        reviewUuid: harness.review.review.uuid,
      })
    ).json();
    expect(stored.review.presentedSoftwareMapRevision).toBe(
      rows[0]!.publicationId,
    );

    const again = await harness.publishMap();
    expect(again.ok).toBe(true);
    expect(again.events).toContainEqual({
      event: "map-published",
      revision: rows[0]!.publicationId,
      documentRevision: documentPublicationId,
      unchanged: true,
    });
    expect(listPublications(harness.review.dir, "map")).toHaveLength(1);
  } finally {
    await harness.close();
  }
}, 60_000);

it("refuses a map publish while the presented document is a Git-era revision", async () => {
  const harness = await publicationHarness({
    softwareMap: softwareMapNote("App"),
  });
  try {
    putReviewRecord(harness.review.dir, {
      ...harness.review.review,
      presentedDocumentRevision: "a".repeat(40),
    });
    const map = await harness.publishMap();
    expect(map.ok).toBe(false);
    expect(map.events).toContainEqual({
      event: "error",
      stage: "publish",
      diagnostics: [expect.stringContaining("Republish the Review document")],
    });
    expect(listPublications(harness.review.dir, "map")).toEqual([]);
  } finally {
    await harness.close();
  }
}, 60_000);

function documentRevisionOf(result: {
  events: { event: string; revision?: string }[];
}): string {
  const published = result.events.find(
    (event) => event.event === "document-published",
  );
  if (!published?.revision)
    throw new Error("No document publication in the result events.");
  return published.revision;
}
