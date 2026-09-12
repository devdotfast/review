import { z } from "zod";

import {
  HostIdSchema,
  HostLabelSchema,
  HostTextSchema,
  HostTimeSchema,
  HostVersionSchema,
} from "./host-document.js";

export const HostAddressSchema = z.strictObject({
  hostId: HostIdSchema,
  workspaceId: HostIdSchema,
  reviewId: HostIdSchema,
});
export type HostAddress = z.infer<typeof HostAddressSchema>;

export const HostRepositorySchema = z.strictObject({
  id: HostIdSchema,
  vcs: z.enum(["git", "jj"]),
  displayName: HostLabelSchema,
});
export type HostRepository = z.infer<typeof HostRepositorySchema>;

export const HostPrincipalSchema = z.strictObject({
  id: HostIdSchema,
  kind: z.enum(["human", "agent", "system"]),
  displayName: HostLabelSchema,
});
export type HostPrincipal = z.infer<typeof HostPrincipalSchema>;

export const HostReviewSchema = z.strictObject({
  id: HostIdSchema,
  repositoryId: HostIdSchema,
  version: HostVersionSchema,
  title: HostLabelSchema,
  description: HostTextSchema,
  labels: z.array(HostLabelSchema).max(100),
  workflow: z.enum(["draft", "in_review", "changes_requested", "closed"]),
  documentId: HostIdSchema,
  documentVersion: HostVersionSchema,
  publishedCheckpointId: HostIdSchema.nullable(),
  authorSessionId: HostIdSchema.nullable(),
  createdBy: HostIdSchema,
  createdAt: HostTimeSchema,
  updatedAt: HostTimeSchema,
  deletedAt: HostTimeSchema.nullable(),
});
export type HostReview = z.infer<typeof HostReviewSchema>;

export const HostCheckpointSchema = z.strictObject({
  id: HostIdSchema,
  reviewId: HostIdSchema,
  ordinal: z.number().int().positive(),
  documentVersion: HostVersionSchema,
  bindingId: HostIdSchema,
  title: HostLabelSchema,
  description: HostTextSchema,
  mapVersions: z.strictObject({
    base: HostIdSchema.nullable(),
    head: HostIdSchema.nullable(),
  }),
  authorSessionId: HostIdSchema.nullable(),
  createdBy: HostIdSchema,
  createdAt: HostTimeSchema,
});
export type HostCheckpoint = z.infer<typeof HostCheckpointSchema>;
