import { z } from "zod";

import {
  HostBindingSchema,
  HostDiagnosticSchema,
  HostDocumentCommitSchema,
  HostIdSchema,
  HostLabelSchema,
  HostTextSchema,
  HostTimeSchema,
  HostVersionSchema,
} from "./host-document.js";

export const HOST_SUPPORT_LIMITS = {
  requestBytes: 6 * 1024 * 1024,
  descriptionBytes: 64 * 1024,
  screenshotBytes: 3 * 1024 * 1024,
} as const;

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

export const HostReviewStateSchema = z.strictObject({
  id: HostIdSchema,
  repositoryId: HostIdSchema,
  latestReviewVersion: HostVersionSchema,
  stateVersion: HostVersionSchema,
  state: z.enum(["open", "closed"]),
  deletedAt: HostTimeSchema.nullable(),
  createdBy: HostIdSchema,
  createdAt: HostTimeSchema,
});
export type HostReviewState = z.infer<typeof HostReviewStateSchema>;
export const HostReviewVersionHeaderSchema = z.strictObject({
  reviewId: HostIdSchema,
  reviewVersion: HostVersionSchema,
  title: HostLabelSchema,
  description: HostTextSchema,
  labels: z.array(HostLabelSchema).max(100),
  binding: HostBindingSchema,
  mapVersions: z.strictObject({
    base: HostIdSchema.nullable(),
    head: HostIdSchema.nullable(),
  }),
  createdBy: HostIdSchema,
  createdAt: HostTimeSchema,
  restoredFromReviewVersion: HostVersionSchema.nullable(),
});
export type HostReviewVersionHeader = z.infer<
  typeof HostReviewVersionHeaderSchema
>;
export const HostReviewWithSnapshotSchema = z.strictObject({
  review: HostReviewStateSchema,
  snapshot: HostReviewVersionHeaderSchema,
});
export type HostReviewWithSnapshot = z.infer<
  typeof HostReviewWithSnapshotSchema
>;
export const HostReviewVersionSummarySchema =
  HostReviewVersionHeaderSchema.extend({
    reason: z.enum(["create", "metadata", "document", "source", "restore"]),
  });
export type HostReviewVersionSummary = z.infer<
  typeof HostReviewVersionSummarySchema
>;
export const HostReviewCommitSchema = z.strictObject({
  reviewId: HostIdSchema,
  previousReviewVersion: HostVersionSchema,
  reviewVersion: HostVersionSchema,
  snapshot: HostReviewVersionHeaderSchema,
  documentDelta: HostDocumentCommitSchema.nullable(),
  diagnostics: z.array(HostDiagnosticSchema),
});
export type HostReviewCommit = z.infer<typeof HostReviewCommitSchema>;
