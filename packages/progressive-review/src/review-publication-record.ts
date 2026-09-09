import crypto from "node:crypto";

import {
  type JsonValue,
  type ReviewSourceIdentity,
  ReviewSourceIdentitySchema,
  parseZod,
} from "@dev.fast/review-protocol";
import { z } from "zod";

import { stableJson } from "./review-mutation-lock";

/** Bumped whenever the publication record shape changes incompatibly. */
export const PUBLICATION_RECORD_VERSION = 1;

export const hex40 = z
  .string()
  .regex(/^[0-9a-f]{40}$/, "must be 40 lowercase hex characters");
export const hex64 = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "must be 64 lowercase hex characters");

/** A publication ID: the 40-hex prefix of `publicationIdFor`'s digest. */
export const publicationIdSchema = hex40;

/** The review's pinned code binding at the moment a publication was made.
 * Mirrors the four fields of `StoredReviewRecord` with the same name so a
 * historical open can restore exactly the code context a publication saw. */
export interface SourceContext {
  baseRef: string;
  baseCommit: string;
  sourceCommit: string | null;
  sourceIdentity: ReviewSourceIdentity | null;
}

const sourceContextFields = {
  baseRef: z.string(),
  baseCommit: z.string(),
  sourceCommit: z.string().nullable(),
  sourceIdentity: ReviewSourceIdentitySchema.nullable(),
};

export const ReviewPublicationLegacyImportSchema = z.strictObject({
  commit: hex40,
  layout: z.enum([
    "document-v2-json",
    "document-v1-js",
    "document-v1-js-root",
    "map-v2-json",
    "map-v1-js",
    "map-embedded-in-document",
    "unknown",
  ]),
  message: z.string().optional(),
  importedAt: z.string(),
});
export type ReviewPublicationLegacyImport = z.infer<
  typeof ReviewPublicationLegacyImportSchema
>;

export const ReviewPublicationArtifactSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("stored"), hash: hex64 }),
  z.strictObject({
    state: z.literal("unavailable"),
    reason: z.enum(["legacy-v1-javascript", "legacy-missing"]),
  }),
]);
export type ReviewPublicationArtifact = z.infer<
  typeof ReviewPublicationArtifactSchema
>;

const sharedPublicationFields = {
  version: z.literal(PUBLICATION_RECORD_VERSION),
  reviewUuid: z.uuid(),
  createdAt: z.string(),
  nonce: z
    .string()
    .regex(/^[0-9a-f]{32}$/, "must be 32 lowercase hex characters"),
  operation: z.enum([
    "publish",
    "map-publish",
    "repair",
    "tutorial",
    "migration",
  ]),
  previousPublicationId: hex40.nullable(),
  legacy: ReviewPublicationLegacyImportSchema.optional(),
  ...sourceContextFields,
  artifact: ReviewPublicationArtifactSchema,
};

export const DocumentPublicationRecordSchema = z.strictObject({
  kind: z.literal("document"),
  ...sharedPublicationFields,
  title: z.string(),
  titleSource: z.enum(["override", "document", "stored"]),
  pairedMapPublicationId: hex40.nullable(),
});
export type DocumentPublicationRecord = z.infer<
  typeof DocumentPublicationRecordSchema
>;

/** `headCommit`/`baseCommit` are the map's own diff pins (both strict
 * 40-hex), not the review's `SourceContext` pins: `baseCommit` intentionally
 * shadows the looser shared field of the same name spread in below. */
export const MapPublicationRecordSchema = z.strictObject({
  kind: z.literal("map"),
  ...sharedPublicationFields,
  headCommit: hex40,
  baseCommit: hex40,
  validatedDocumentPublicationId: hex40.nullable(),
});
export type MapPublicationRecord = z.infer<typeof MapPublicationRecordSchema>;

export const ReviewPublicationRecordSchema = z.discriminatedUnion("kind", [
  DocumentPublicationRecordSchema,
  MapPublicationRecordSchema,
]);
export type ReviewPublicationRecord = z.infer<
  typeof ReviewPublicationRecordSchema
>;

/** Content-derived publication ID: stable under key reordering, distinct for
 * any change to the record (including its nonce). */
export function publicationIdFor(record: ReviewPublicationRecord): string {
  return crypto
    .createHash("sha256")
    .update("review-publication/v1\0")
    .update(stableJson(record))
    .digest("hex")
    .slice(0, 40);
}

export function newPublicationNonce(): string {
  return crypto.randomBytes(16).toString("hex");
}

export function parsePublicationRecord(
  value: JsonValue,
): ReviewPublicationRecord {
  return parseZod(ReviewPublicationRecordSchema, value);
}
