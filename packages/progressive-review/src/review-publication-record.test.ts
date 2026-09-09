import { describe, expect, it } from "vitest";

import {
  type DocumentPublicationRecord,
  type MapPublicationRecord,
  ReviewPublicationRecordSchema,
  newPublicationNonce,
  parsePublicationRecord,
  publicationIdFor,
} from "./review-publication-record";

const reviewUuid = "11111111-1111-4111-8111-111111111111";

const documentRecord: DocumentPublicationRecord = {
  kind: "document",
  version: 1,
  reviewUuid,
  createdAt: "2026-09-09T00:00:00.000Z",
  nonce: newPublicationNonce(),
  operation: "publish",
  previousPublicationId: null,
  baseRef: "main",
  baseCommit: "a".repeat(40),
  sourceCommit: "b".repeat(40),
  sourceIdentity: { kind: "git-branch", name: "main" },
  artifact: { state: "stored", hash: "c".repeat(64) },
  title: "A review",
  titleSource: "document",
  pairedMapPublicationId: null,
};

describe("ReviewPublicationRecordSchema", () => {
  it("accepts a well-formed document record", () => {
    expect(parsePublicationRecord(documentRecord)).toEqual(documentRecord);
  });

  it("accepts a well-formed map record", () => {
    const record: MapPublicationRecord = {
      kind: "map",
      version: 1,
      reviewUuid,
      createdAt: "2026-09-09T00:00:00.000Z",
      nonce: newPublicationNonce(),
      operation: "map-publish",
      previousPublicationId: null,
      baseRef: "main",
      baseCommit: "a".repeat(40),
      sourceCommit: "b".repeat(40),
      sourceIdentity: { kind: "git-branch", name: "main" },
      artifact: { state: "stored", hash: "c".repeat(64) },
      headCommit: "d".repeat(40),
      validatedDocumentPublicationId: null,
    } satisfies MapPublicationRecord;
    expect(parsePublicationRecord(record)).toEqual(record);
  });

  it("rejects a document record carrying a map-only field", () => {
    expect(() =>
      parsePublicationRecord({ ...documentRecord, headCommit: "d".repeat(40) }),
    ).toThrow("Unrecognized key");
  });

  it("rejects a map record carrying a document-only field", () => {
    const record = {
      kind: "map",
      version: 1,
      reviewUuid,
      createdAt: "2026-09-09T00:00:00.000Z",
      nonce: newPublicationNonce(),
      operation: "map-publish",
      previousPublicationId: null,
      baseRef: "main",
      baseCommit: "a".repeat(40),
      sourceCommit: "b".repeat(40),
      sourceIdentity: null,
      artifact: { state: "stored", hash: "c".repeat(64) },
      headCommit: "d".repeat(40),
      validatedDocumentPublicationId: null,
      title: "Should not be here",
    };
    expect(() => parsePublicationRecord(record)).toThrow("Unrecognized key");
  });

  it("accepts an unavailable legacy artifact and legacy import metadata", () => {
    const record = {
      ...documentRecord,
      artifact: { state: "unavailable", reason: "legacy-v1-javascript" },
      legacy: {
        commit: "e".repeat(40),
        layout: "document-v1-js",
        importedAt: "2026-09-01T00:00:00.000Z",
      },
    } satisfies DocumentPublicationRecord;
    expect(ReviewPublicationRecordSchema.parse(record)).toEqual(record);
  });
});

describe("publicationIdFor", () => {
  it("is 40 lowercase hex characters", () => {
    expect(publicationIdFor(documentRecord)).toMatch(/^[0-9a-f]{40}$/);
  });

  it("changes when the nonce changes, holding everything else fixed", () => {
    const other: DocumentPublicationRecord = {
      ...documentRecord,
      nonce: newPublicationNonce(),
    };
    expect(publicationIdFor(other)).not.toBe(publicationIdFor(documentRecord));
  });

  it("is independent of property insertion order", () => {
    const reordered: DocumentPublicationRecord = {
      pairedMapPublicationId: documentRecord.pairedMapPublicationId,
      titleSource: documentRecord.titleSource,
      title: documentRecord.title,
      artifact: documentRecord.artifact,
      sourceIdentity: documentRecord.sourceIdentity,
      sourceCommit: documentRecord.sourceCommit,
      baseCommit: documentRecord.baseCommit,
      baseRef: documentRecord.baseRef,
      previousPublicationId: documentRecord.previousPublicationId,
      operation: documentRecord.operation,
      nonce: documentRecord.nonce,
      createdAt: documentRecord.createdAt,
      reviewUuid: documentRecord.reviewUuid,
      version: documentRecord.version,
      kind: documentRecord.kind,
    };
    expect(publicationIdFor(reordered)).toBe(publicationIdFor(documentRecord));
  });
});

describe("newPublicationNonce", () => {
  it("returns 32 distinct hex characters", () => {
    const nonce = newPublicationNonce();
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(newPublicationNonce()).not.toBe(nonce);
  });
});
