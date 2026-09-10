import { chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { REVIEW_SCHEMA_VERSION } from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it } from "vitest";

import { installReviewArtifact } from "./review-artifact-store";
import {
  DISABLED_REVIEW_SOURCE_SESSION,
  type StoredReviewRecord,
  parseStoredReviewRecord,
} from "./review-home";
import {
  type ActivationInput,
  type DocumentActivationCandidate,
  type MapActivationCandidate,
  ReviewActivationConflictError,
  type ReviewActivationHooks,
  ReviewMapPinsMismatchError,
  activateReviewPublication,
} from "./review-publication-activation";
import type { SourceContext } from "./review-publication-record";
import {
  closeAllReviewStateDatabases,
  listPublications,
  putReviewRecord,
  readLegacyArtifactImport,
  readReviewRecord,
  upsertLegacyArtifactImportInTransaction,
} from "./review-state-db";
import { cleanupTempDirs, reviewHome } from "./review-test-utils";

const REVIEW_UUID = "22222222-2222-4222-8222-222222222222";
const BASE_COMMIT = "a".repeat(40);
const HEAD_COMMIT = "b".repeat(40);
const OTHER_HEAD_COMMIT = "c".repeat(40);

const restoreModes: string[] = [];

afterEach(async () => {
  for (const dir of restoreModes.splice(0)) await chmod(dir, 0o700);
  closeAllReviewStateDatabases();
  await cleanupTempDirs();
});

interface RegisteredReview {
  home: string;
  dir: string;
  review: StoredReviewRecord;
}

async function registeredReview(): Promise<RegisteredReview> {
  const home = await reviewHome();
  const dir = path.join(home, "reviews", REVIEW_UUID);
  await mkdir(dir, { recursive: true });
  const review = parseStoredReviewRecord({
    schemaVersion: REVIEW_SCHEMA_VERSION,
    uuid: REVIEW_UUID,
    repoKey: "repo",
    worktreePath: "/source",
    baseRef: "main",
    baseCommit: BASE_COMMIT,
    sourceCommit: HEAD_COMMIT,
    sourceIdentity: null,
    title: "A review",
    sourceSession: DISABLED_REVIEW_SOURCE_SESSION,
    status: "awaiting-review",
    presentedDocumentRevision: null,
    presentedSoftwareMapRevision: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastPublishedAt: null,
  });
  putReviewRecord(dir, review, home);
  return { home, dir, review };
}

function sourceContext(sourceCommit = HEAD_COMMIT): SourceContext {
  return {
    baseRef: "main",
    baseCommit: BASE_COMMIT,
    sourceCommit,
    sourceIdentity: null,
  };
}

async function installDocument(dir: string, body: string): Promise<string> {
  const installed = await installReviewArtifact(
    dir,
    "document",
    JSON.stringify({ body }),
  );
  return installed.hash;
}

async function installMap(dir: string, body: string): Promise<string> {
  const installed = await installReviewArtifact(
    dir,
    "map",
    JSON.stringify({ map: body }),
  );
  return installed.hash;
}

function documentCandidate(
  artifactHash: string,
  context = sourceContext(),
  title = "A review",
): DocumentActivationCandidate {
  return {
    kind: "document",
    artifactHash,
    title,
    titleSource: "document",
    context,
    operation: "publish",
  };
}

function mapCandidate(
  artifactHash: string,
  headCommit = HEAD_COMMIT,
  baseCommit = BASE_COMMIT,
): MapActivationCandidate {
  return {
    kind: "map",
    artifactHash,
    headCommit,
    baseCommit,
    context: sourceContext(headCommit),
    operation: "map-publish",
  };
}

function keepRecord(latest: StoredReviewRecord): StoredReviewRecord {
  return latest;
}

describe("activateReviewPublication", () => {
  it("commits one publication row, moves the pointer and refreshes the mirror", async () => {
    const { dir, review } = await registeredReview();
    const artifactHash = await installDocument(dir, "first");

    const result = await activateReviewPublication({
      reviewDir: dir,
      expected: { guarded: review },
      candidates: [documentCandidate(artifactHash)],
      updateRecord: (latest) => ({
        ...latest,
        lastPublishedAt: "2026-02-02T00:00:00.000Z",
      }),
    });

    expect(result.published).toHaveLength(1);
    const entry = result.published[0];
    expect(entry.seq).toBe(1);
    expect(entry.record).toMatchObject({
      kind: "document",
      version: 1,
      reviewUuid: REVIEW_UUID,
      operation: "publish",
      previousPublicationId: null,
      pairedMapPublicationId: null,
      title: "A review",
      titleSource: "document",
      artifact: { state: "stored", hash: artifactHash },
      baseRef: "main",
      baseCommit: BASE_COMMIT,
      sourceCommit: HEAD_COMMIT,
    });
    expect(entry.publicationId).toMatch(/^[0-9a-f]{40}$/);
    expect(result.review.presentedDocumentRevision).toBe(entry.publicationId);
    expect(result.review.lastPublishedAt).toBe("2026-02-02T00:00:00.000Z");
    expect(result.mirrorWarning).toBeUndefined();

    const rows = listPublications(dir, "document");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      publicationId: entry.publicationId,
      kind: "document",
      seq: 1,
      operation: "publish",
      artifactHash,
      previousPublicationId: null,
      legacyCommit: null,
    });
    expect(readReviewRecord(dir)).toEqual(result.review);
    await expect(
      readFile(path.join(dir, "review.json"), "utf8").then(
        (text) => JSON.parse(text) as StoredReviewRecord,
      ),
    ).resolves.toEqual(result.review);
  });

  it("refuses a record that is not at the current schema", async () => {
    const { dir, home, review } = await registeredReview();
    const artifactHash = await installDocument(dir, "first");
    putReviewRecord(dir, { ...review, schemaVersion: 5 }, home);

    await expect(
      activateReviewPublication({
        reviewDir: dir,
        expected: { guarded: review },
        candidates: [documentCandidate(artifactHash)],
        updateRecord: keepRecord,
      }),
    ).rejects.toThrow(/expected 6/);

    expect(listPublications(dir, "document")).toEqual([]);
    expect(readReviewRecord(dir)).toMatchObject({ schemaVersion: 5 });
  });

  it("chains the second activation onto the first", async () => {
    const { dir, review } = await registeredReview();
    const first = await activateReviewPublication({
      reviewDir: dir,
      expected: { guarded: review },
      candidates: [documentCandidate(await installDocument(dir, "first"))],
      updateRecord: keepRecord,
    });

    const second = await activateReviewPublication({
      reviewDir: dir,
      expected: { guarded: first.review },
      candidates: [documentCandidate(await installDocument(dir, "second"))],
      updateRecord: keepRecord,
    });

    expect(second.published[0].record.previousPublicationId).toBe(
      first.published[0].publicationId,
    );
    expect(second.published[0].seq).toBe(2);
    expect(second.review.presentedDocumentRevision).toBe(
      second.published[0].publicationId,
    );
    expect(listPublications(dir, "document").map((row) => row.seq)).toEqual([
      2, 1,
    ]);
  });

  it("records a second publication for the same artifact under a new context", async () => {
    const { dir, review } = await registeredReview();
    const artifactHash = await installDocument(dir, "first");
    const first = await activateReviewPublication({
      reviewDir: dir,
      expected: { guarded: review },
      candidates: [documentCandidate(artifactHash)],
      updateRecord: keepRecord,
    });

    const second = await activateReviewPublication({
      reviewDir: dir,
      expected: { guarded: first.review },
      candidates: [
        documentCandidate(artifactHash, sourceContext(OTHER_HEAD_COMMIT)),
      ],
      updateRecord: keepRecord,
    });

    const rows = listPublications(dir, "document");
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.artifactHash === artifactHash)).toBe(true);
    expect(first.published[0].publicationId).not.toBe(
      second.published[0].publicationId,
    );
    expect(second.published[0].record.sourceCommit).toBe(OTHER_HEAD_COMMIT);
  });

  it("rejects an activation whose guarded fields changed under it", async () => {
    const { dir, home, review } = await registeredReview();
    const artifactHash = await installDocument(dir, "first");
    putReviewRecord(dir, { ...review, status: "accepted" }, home);

    await expect(
      activateReviewPublication({
        reviewDir: dir,
        expected: { guarded: review },
        candidates: [documentCandidate(artifactHash)],
        updateRecord: keepRecord,
      }),
    ).rejects.toMatchObject({
      name: "ReviewActivationConflictError",
      code: "review_publication_conflict",
      statusCode: 409,
    });
    expect(listPublications(dir, "document")).toHaveLength(0);
    expect(readReviewRecord(dir)).toMatchObject({
      presentedDocumentRevision: null,
      status: "accepted",
    });
  });

  it("refuses to activate a publication whose artifact is missing", async () => {
    const { dir, review } = await registeredReview();

    await expect(
      activateReviewPublication({
        reviewDir: dir,
        expected: { guarded: review },
        candidates: [documentCandidate("0".repeat(64))],
        updateRecord: keepRecord,
      }),
    ).rejects.toMatchObject({
      name: "ReviewArtifactUnavailableError",
      code: "artifact_unavailable",
      statusCode: 422,
    });
    expect(listPublications(dir, "document")).toHaveLength(0);
    expect(readReviewRecord(dir)).toMatchObject({
      presentedDocumentRevision: null,
    });
  });

  it("runs the precheck under the lock before verifying artifacts", async () => {
    const { dir, review } = await registeredReview();
    const order: string[] = [];

    await expect(
      activateReviewPublication({
        reviewDir: dir,
        expected: { guarded: review },
        candidates: [documentCandidate(await installDocument(dir, "first"))],
        updateRecord: keepRecord,
        precheck: async () => {
          order.push("precheck");
          throw new Error("authoring changed");
        },
        hooks: { afterArtifactVerify: () => order.push("verify") },
      }),
    ).rejects.toThrow("authoring changed");
    expect(order).toEqual(["precheck"]);
    expect(listPublications(dir, "document")).toHaveLength(0);
  });

  it("runs the gates in order inside the transaction and rolls back on failure", async () => {
    const { dir, review } = await registeredReview();
    const seen: string[] = [];

    await expect(
      activateReviewPublication({
        reviewDir: dir,
        expected: { guarded: review },
        candidates: [documentCandidate(await installDocument(dir, "first"))],
        updateRecord: keepRecord,
        gates: [
          (latest) => {
            seen.push(`first:${latest.uuid}`);
          },
          () => {
            seen.push("second");
            throw new Error("threads are open");
          },
          () => {
            seen.push("third");
          },
        ],
      }),
    ).rejects.toThrow("threads are open");
    expect(seen).toEqual([`first:${REVIEW_UUID}`, "second"]);
    expect(listPublications(dir, "document")).toHaveLength(0);
    expect(readReviewRecord(dir)).toMatchObject({
      presentedDocumentRevision: null,
    });
  });

  for (const hook of [
    "afterArtifactVerify",
    "afterPublicationInsert",
    "afterPointerUpdate",
    "beforeCommit",
  ] as const) {
    it(`leaves no row or pointer behind when ${hook} throws`, async () => {
      const { dir, review } = await registeredReview();
      const hooks: ReviewActivationHooks = {};
      hooks[hook] = () => {
        throw new Error(`${hook} failed`);
      };

      await expect(
        activateReviewPublication({
          reviewDir: dir,
          expected: { guarded: review },
          candidates: [documentCandidate(await installDocument(dir, "first"))],
          updateRecord: keepRecord,
          hooks,
        }),
      ).rejects.toThrow(`${hook} failed`);
      expect(listPublications(dir, "document")).toHaveLength(0);
      expect(readReviewRecord(dir)).toMatchObject({
        presentedDocumentRevision: null,
      });
    });
  }

  it("keeps the committed row when the mirror refresh fails", async () => {
    const { dir, review } = await registeredReview();
    const artifactHash = await installDocument(dir, "first");
    const order: string[] = [];
    restoreModes.push(dir);
    await chmod(dir, 0o500);

    const result = await activateReviewPublication({
      reviewDir: dir,
      expected: { guarded: review },
      candidates: [documentCandidate(artifactHash)],
      updateRecord: keepRecord,
      hooks: {
        afterCommit: () => order.push("afterCommit"),
        beforeMirror: () => order.push("beforeMirror"),
      },
    });

    expect(order).toEqual(["afterCommit", "beforeMirror"]);
    expect(result.mirrorWarning).toMatch(/review\.json/);
    expect(listPublications(dir, "document")).toHaveLength(1);
    expect(readReviewRecord(dir)).toMatchObject({
      presentedDocumentRevision: result.published[0].publicationId,
    });
  });

  it("pairs a map and a document activated in one call", async () => {
    const { dir, review } = await registeredReview();
    const first = await activateReviewPublication({
      reviewDir: dir,
      expected: { guarded: review },
      candidates: [documentCandidate(await installDocument(dir, "first"))],
      updateRecord: keepRecord,
    });
    const documentId = first.published[0].publicationId;

    const second = await activateReviewPublication({
      reviewDir: dir,
      expected: { guarded: first.review },
      candidates: [
        documentCandidate(await installDocument(dir, "second")),
        mapCandidate(await installMap(dir, "shapes")),
      ],
      updateRecord: keepRecord,
    });

    expect(second.published.map((entry) => entry.record.kind)).toEqual([
      "map",
      "document",
    ]);
    const [map, document] = second.published;
    expect(map.record).toMatchObject({
      kind: "map",
      headCommit: HEAD_COMMIT,
      baseCommit: BASE_COMMIT,
      previousPublicationId: null,
      validatedDocumentPublicationId: null,
    });
    expect(document.record).toMatchObject({
      kind: "document",
      previousPublicationId: documentId,
      pairedMapPublicationId: map.publicationId,
    });
    expect(second.review.presentedSoftwareMapRevision).toBe(map.publicationId);
    expect(second.review.presentedDocumentRevision).toBe(
      document.publicationId,
    );
    expect([map.seq, document.seq]).toEqual([2, 3]);
  });

  it("activates a combined pair that moves the pins past the presented document", async () => {
    const { dir, review } = await registeredReview();
    const first = await activateReviewPublication({
      reviewDir: dir,
      expected: { guarded: review },
      candidates: [documentCandidate(await installDocument(dir, "first"))],
      updateRecord: keepRecord,
    });
    const documentId = first.published[0].publicationId;

    const second = await activateReviewPublication({
      reviewDir: dir,
      expected: { guarded: first.review },
      candidates: [
        documentCandidate(
          await installDocument(dir, "second"),
          sourceContext(OTHER_HEAD_COMMIT),
        ),
        mapCandidate(await installMap(dir, "shapes"), OTHER_HEAD_COMMIT),
      ],
      updateRecord: keepRecord,
    });

    const [map, document] = second.published;
    expect(map.record).toMatchObject({
      kind: "map",
      headCommit: OTHER_HEAD_COMMIT,
      validatedDocumentPublicationId: null,
    });
    expect(document.record).toMatchObject({
      kind: "document",
      sourceCommit: OTHER_HEAD_COMMIT,
      previousPublicationId: documentId,
      pairedMapPublicationId: map.publicationId,
    });
    expect(second.review.presentedDocumentRevision).toBe(
      document.publicationId,
    );
    expect(second.review.presentedSoftwareMapRevision).toBe(map.publicationId);
  });

  it("rejects a map whose pins disagree with the document beside it", async () => {
    const { dir, review } = await registeredReview();

    await expect(
      activateReviewPublication({
        reviewDir: dir,
        expected: { guarded: review },
        candidates: [
          documentCandidate(await installDocument(dir, "first")),
          mapCandidate(await installMap(dir, "shapes"), OTHER_HEAD_COMMIT),
        ],
        updateRecord: keepRecord,
      }),
    ).rejects.toMatchObject({
      name: "ReviewMapPinsMismatchError",
      code: "map_pins_mismatch",
      statusCode: 422,
      documentPublicationId: null,
    });
    expect(listPublications(dir, "map")).toHaveLength(0);
    expect(listPublications(dir, "document")).toHaveLength(0);
  });

  it("refuses to chain onto a presented document that no row answers", async () => {
    const { dir, home, review } = await registeredReview();
    const first = await activateReviewPublication({
      reviewDir: dir,
      expected: { guarded: review },
      candidates: [documentCandidate(await installDocument(dir, "first"))],
      updateRecord: keepRecord,
    });
    // A Git-era oid answers no row at all.
    const strayed: StoredReviewRecord = {
      ...first.review,
      presentedDocumentRevision: "f".repeat(40),
    };
    putReviewRecord(dir, strayed, home);

    await expect(
      activateReviewPublication({
        reviewDir: dir,
        expected: { guarded: strayed },
        candidates: [documentCandidate(await installDocument(dir, "second"))],
        updateRecord: keepRecord,
      }),
    ).rejects.toMatchObject({
      name: "ReviewPublicationMissingError",
      code: "publication_missing",
      statusCode: 422,
      kind: "document",
      publicationId: "f".repeat(40),
    });
    expect(listPublications(dir, "document")).toHaveLength(1);
    expect(readReviewRecord(dir)).toEqual(strayed);
  });

  it("refuses to chain onto a presented map that holds a document row", async () => {
    const { dir, home, review } = await registeredReview();
    const first = await activateReviewPublication({
      reviewDir: dir,
      expected: { guarded: review },
      candidates: [documentCandidate(await installDocument(dir, "first"))],
      updateRecord: keepRecord,
    });
    const documentId = first.published[0].publicationId;
    const strayed: StoredReviewRecord = {
      ...first.review,
      presentedSoftwareMapRevision: documentId,
    };
    putReviewRecord(dir, strayed, home);

    await expect(
      activateReviewPublication({
        reviewDir: dir,
        expected: { guarded: strayed },
        candidates: [documentCandidate(await installDocument(dir, "second"))],
        updateRecord: keepRecord,
      }),
    ).rejects.toMatchObject({
      name: "ReviewPublicationMissingError",
      kind: "map",
      publicationId: documentId,
    });
    expect(listPublications(dir, "document")).toHaveLength(1);
    expect(readReviewRecord(dir)).toEqual(strayed);
  });

  it("refuses a map when the Review presents no document to pin it to", async () => {
    const { dir, review } = await registeredReview();

    await expect(
      activateReviewPublication({
        reviewDir: dir,
        expected: { guarded: review },
        candidates: [mapCandidate(await installMap(dir, "shapes"))],
        updateRecord: keepRecord,
      }),
    ).rejects.toMatchObject({
      name: "ReviewMapPinsMismatchError",
      code: "map_pins_mismatch",
      statusCode: 422,
      documentPublicationId: null,
    });
    expect(listPublications(dir, "map")).toHaveLength(0);
  });

  it("pairs a document with the map already presented", async () => {
    const { dir, review } = await registeredReview();
    const first = await activateReviewPublication({
      reviewDir: dir,
      expected: { guarded: review },
      candidates: [documentCandidate(await installDocument(dir, "first"))],
      updateRecord: keepRecord,
    });
    const published = await activateReviewPublication({
      reviewDir: dir,
      expected: { guarded: first.review },
      candidates: [mapCandidate(await installMap(dir, "shapes"))],
      updateRecord: keepRecord,
    });
    expect(published.published[0].record).toMatchObject({
      kind: "map",
      validatedDocumentPublicationId: first.published[0].publicationId,
    });

    const second = await activateReviewPublication({
      reviewDir: dir,
      expected: { guarded: published.review },
      candidates: [documentCandidate(await installDocument(dir, "second"))],
      updateRecord: keepRecord,
    });

    expect(second.published[0].record).toMatchObject({
      kind: "document",
      pairedMapPublicationId: published.published[0].publicationId,
    });
  });

  it("rejects a map whose pins disagree with the validating document", async () => {
    const { dir, review } = await registeredReview();
    const first = await activateReviewPublication({
      reviewDir: dir,
      expected: { guarded: review },
      candidates: [documentCandidate(await installDocument(dir, "first"))],
      updateRecord: keepRecord,
    });

    await expect(
      activateReviewPublication({
        reviewDir: dir,
        expected: { guarded: first.review },
        candidates: [
          mapCandidate(await installMap(dir, "shapes"), OTHER_HEAD_COMMIT),
        ],
        updateRecord: keepRecord,
      }),
    ).rejects.toMatchObject({
      name: "ReviewMapPinsMismatchError",
      code: "map_pins_mismatch",
      statusCode: 422,
    });
    expect(listPublications(dir, "map")).toHaveLength(0);
    expect(readReviewRecord(dir)).toMatchObject({
      presentedSoftwareMapRevision: null,
    });
  });

  it("owns the presentation pointers even when updateRecord sets them", async () => {
    const { dir, review } = await registeredReview();

    const result = await activateReviewPublication({
      reviewDir: dir,
      expected: { guarded: review },
      candidates: [
        documentCandidate(await installDocument(dir, "first")),
        mapCandidate(await installMap(dir, "shapes")),
      ],
      updateRecord: (latest) => ({
        ...latest,
        presentedDocumentRevision: "d".repeat(40),
        presentedSoftwareMapRevision: "e".repeat(40),
      }),
    });

    const [map, document] = result.published;
    expect(result.review.presentedDocumentRevision).toBe(
      document.publicationId,
    );
    expect(result.review.presentedSoftwareMapRevision).toBe(map.publicationId);
  });

  it("accepts a record-text guard regardless of key order", async () => {
    const { dir, review } = await registeredReview();
    const reordered = JSON.stringify(
      Object.fromEntries(Object.entries(review).reverse()),
    );

    const result = await activateReviewPublication({
      reviewDir: dir,
      expected: { recordJson: reordered },
      candidates: [documentCandidate(await installDocument(dir, "first"))],
      updateRecord: keepRecord,
    });

    expect(listPublications(dir, "document")).toHaveLength(1);
    expect(result.review.presentedDocumentRevision).toBe(
      result.published[0].publicationId,
    );
  });

  it("rejects a stale record-text guard", async () => {
    const { dir, review } = await registeredReview();

    await expect(
      activateReviewPublication({
        reviewDir: dir,
        expected: { recordJson: JSON.stringify({ ...review, title: "Other" }) },
        candidates: [documentCandidate(await installDocument(dir, "first"))],
        updateRecord: keepRecord,
      }),
    ).rejects.toBeInstanceOf(ReviewActivationConflictError);
    expect(listPublications(dir, "document")).toHaveLength(0);
  });

  it("writes the caller's own rows in the same transaction", async () => {
    const { dir, review } = await registeredReview();

    const result = await activateReviewPublication({
      reviewDir: dir,
      expected: { guarded: review },
      candidates: [documentCandidate(await installDocument(dir, "first"))],
      updateRecord: keepRecord,
      inTransaction: (tx, published) => {
        upsertLegacyArtifactImportInTransaction(tx, dir, {
          importedAt: "2026-03-03T00:00:00.000Z",
          sourceHead: published[0].publicationId,
          versions: 1,
          unavailable: 0,
        });
      },
    });

    expect(readLegacyArtifactImport(dir)).toMatchObject({
      sourceHead: result.published[0].publicationId,
      versions: 1,
    });
  });

  it("rolls the whole activation back when inTransaction throws", async () => {
    const { dir, review } = await registeredReview();

    await expect(
      activateReviewPublication({
        reviewDir: dir,
        expected: { guarded: review },
        candidates: [documentCandidate(await installDocument(dir, "first"))],
        updateRecord: keepRecord,
        inTransaction: (tx) => {
          upsertLegacyArtifactImportInTransaction(tx, dir, {
            importedAt: "2026-03-03T00:00:00.000Z",
            sourceHead: null,
            versions: 1,
            unavailable: 0,
          });
          throw new Error("marker rejected");
        },
      }),
    ).rejects.toThrow("marker rejected");
    expect(listPublications(dir, "document")).toHaveLength(0);
    expect(readLegacyArtifactImport(dir)).toBeNull();
    expect(readReviewRecord(dir)).toMatchObject({
      presentedDocumentRevision: null,
    });
  });

  it("rejects candidate lists it cannot activate", async () => {
    const { dir, review } = await registeredReview();
    const artifactHash = await installDocument(dir, "first");
    const base: ActivationInput = {
      reviewDir: dir,
      expected: { guarded: review },
      candidates: [],
      updateRecord: keepRecord,
    };

    await expect(activateReviewPublication(base)).rejects.toThrow(
      /at least one candidate/,
    );
    await expect(
      activateReviewPublication({
        ...base,
        candidates: [
          documentCandidate(artifactHash),
          documentCandidate(artifactHash, sourceContext(OTHER_HEAD_COMMIT)),
        ],
      }),
    ).rejects.toThrow(/at most one document candidate/);
    expect(listPublications(dir, "document")).toHaveLength(0);
  });
});
