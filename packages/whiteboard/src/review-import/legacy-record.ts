import {
  WHITEBOARD_SCHEMA_VERSION,
  WhiteboardAgentSessionAttributionSchema,
  WhiteboardSourceIdentitySchema,
  WhiteboardStatusSchema,
} from "@dev.fast/whiteboard-protocol";
// Storage contract read only by the legacy importer and its support tools.
import { z } from "zod";

const requiredString = z.string().min(1);

const stringAllowEmpty = z.string();

const positiveInteger = z.number().int().positive();

const absoluteUrlSchema = z.url();

export const WhiteboardRecordSchema = z.strictObject({
  schemaVersion: z.literal(WHITEBOARD_SCHEMA_VERSION),
  uuid: z.uuid({ error: "must be a UUID" }),
  /* System Whiteboards use the complete stored-Review/session pipeline without
     appearing in user-facing Review lists. Absence preserves the historical
     user-visible default. */
  visibility: z.literal("system").optional(),
  repoKey: requiredString,
  worktreePath: requiredString,
  baseRef: requiredString,
  baseCommit: requiredString,
  sourceCommit: requiredString.nullable(),
  sourceIdentity: WhiteboardSourceIdentitySchema.nullable(),
  pullRequestNumber: positiveInteger.nullable().optional(),
  pullRequestUrl: absoluteUrlSchema.nullable().optional(),
  title: stringAllowEmpty,
  sourceSession: requiredString,
  agentSessions: z
    .record(requiredString, WhiteboardAgentSessionAttributionSchema)
    .optional(),
  status: WhiteboardStatusSchema,
  presentedDocumentRevision: requiredString.nullable(),
  presentedSoftwareMapRevision: requiredString.nullable(),
  createdAt: requiredString,
  lastPublishedAt: requiredString.nullable(),
  /* The attention axis, separate from status: status tracks the agent handoff,
     these track the reader. Both stay optional so a review.json written before
     this field existed still parses and needs no migration. */
  viewedAt: requiredString.nullable().optional(),
  dismissedAt: requiredString.nullable().optional(),
});

export type WhiteboardRecord = z.infer<typeof WhiteboardRecordSchema>;
