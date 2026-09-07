import {
  ReviewRecordSchema,
  ReviewStatusSchema,
  reviewViewSchema,
} from "@dev.fast/review-protocol";
import { z } from "zod";

import { ReviewInfoEventSchema } from "./review-info";
export const ReviewRepairReadyResponseSchema = z.strictObject({
  ok: z.literal(true),
  status: ReviewStatusSchema,
  oldDocumentRevision: z.string().min(1).nullable(),
  oldMapRevision: z.string().min(1).nullable(),
  newDocumentRevision: z.string().regex(/^[0-9a-f]{40}$/),
  newMapRevision: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .nullable(),
  sessionId: z.string().min(1),
  url: z.string().min(1),
});

export const ReviewRepairResultSchema = ReviewRepairReadyResponseSchema.extend({
  reviewUuid: z.uuid(),
  noop: z.boolean(),
  warnings: z.array(z.string()),
  sessionId: z.string().optional(),
  url: z.string().optional(),
  sourceFallback: z
    .strictObject({ document: z.boolean(), map: z.boolean() })
    .optional(),
});

const agent = z.strictObject({
  harness: z.enum(["codex", "claude-code", "opencode", "pi"]),
  sessionId: z.string().trim().min(1),
});

export const ReviewLifecycleTargetSchema = z.strictObject({
  cwd: z.string().min(1),
  reviewUuid: z.uuid().optional(),
});

export const ReviewResolveRequestSchema = ReviewLifecycleTargetSchema.extend({
  includeTerminal: z.boolean().optional(),
});
export const ReviewListRequestSchema = z.strictObject({
  worktreePath: z.string().optional(),
  repoKey: z.string().optional(),
  status: ReviewRecordSchema.shape.status.optional(),
  includeSystem: z.boolean().optional(),
});

export const ReviewScaffoldRequestSchema = ReviewLifecycleTargetSchema.extend({
  baseRef: z.string().optional(),
  headRef: z.string().optional(),
  pullRequest: z.string().optional(),
  update: z.boolean().optional(),
  newReview: z.boolean().optional(),
  background: z.boolean().optional(),
  agent: agent.optional(),
})
  .refine((request) => !(request.headRef && request.pullRequest), {
    message: "Choose headRef or pullRequest, not both.",
  })
  .refine(
    (request) =>
      !request.update ||
      !(request.newReview || request.headRef || request.pullRequest),
    {
      message:
        "Repinning cannot also create a new Review or choose a different source; use rebind.",
    },
  )
  .refine((request) => !request.reviewUuid || request.update === true, {
    message: "reviewUuid requires update=true when scaffolding.",
  });

export const ReviewPublishRequestSchema = ReviewLifecycleTargetSchema.extend({
  view: reviewViewSchema.optional(),
  agent: agent.optional(),
});

export const ReviewRebindRequestSchema = ReviewLifecycleTargetSchema.extend({
  change: z.string().trim().min(1),
  agent: agent.optional(),
});

export const ReviewPublicationEventSchema = z.discriminatedUnion("event", [
  z.strictObject({ event: z.literal("review-bound"), reviewUuid: z.uuid() }),
  z.strictObject({
    event: z.literal("stage"),
    name: z.enum(["validate", "revision", "mount", "load"]),
    status: z.enum(["running", "complete"]),
    revision: z.string().optional(),
    sessionId: z.string().optional(),
    skipped: z.boolean().optional(),
  }),
  z.strictObject({
    event: z.enum(["warning", "error"]),
    stage: z.string(),
    diagnostics: z.array(z.string()),
  }),
  z.strictObject({
    event: z.literal("diagnostics"),
    diagnostics: z.array(
      z.object({
        source: z.enum(["mdx", "typescript", "review", "evidence"]),
        severity: z.enum(["error", "warning"]),
        code: z.string(),
        message: z.string(),
        filePath: z.string(),
        line: z.number().optional(),
        column: z.number().optional(),
      }),
    ),
  }),
  z.strictObject({
    event: z.literal("document-published"),
    revision: z.string(),
    sessionId: z.string(),
    softwareMapRevision: z.string().nullable(),
  }),
  z.strictObject({
    event: z.literal("map-published"),
    revision: z.string(),
    documentRevision: z.string(),
    unchanged: z.boolean(),
  }),
]);
export type ReviewPublicationEvent = z.infer<
  typeof ReviewPublicationEventSchema
>;
export const ReviewPublicationResultSchema = z.strictObject({
  ok: z.boolean(),
  events: z.array(ReviewPublicationEventSchema),
});

export const ReviewRebindResultSchema = z.strictObject({
  event: z.literal("rebound"),
  uuid: z.uuid(),
  change: z.string(),
  warnings: z.array(z.string()).optional(),
});

export const ReviewStoredResponseSchema = z.strictObject({
  dir: z.string(),
  review: ReviewRecordSchema,
});
export const ReviewListResponseSchema = z.strictObject({
  reviews: z.array(ReviewStoredResponseSchema),
  errors: z.array(
    z.object({
      reviewDir: z.string(),
      reviewUuid: z.string().nullable(),
      title: z.string(),
      worktreePath: z.string(),
      lastPublishedAt: z.string().nullable(),
      message: z.string(),
      code: z.string().optional(),
    }),
  ),
});

export const ReviewMetadataUpdateSchema = z.strictObject({
  title: z.string().trim().min(1),
  expectedTitle: z.string(),
});

export const ReviewDocumentFileNameSchema = z.enum(["review.mdx", "data.ts"]);
export type ReviewDocumentFileName = z.infer<
  typeof ReviewDocumentFileNameSchema
>;
export const ReviewDocumentFileResponseSchema = z.strictObject({
  name: ReviewDocumentFileNameSchema,
  source: z.string().nullable(),
  sourceHash: z.string().nullable(),
});
export const ReviewDocumentFileWriteSchema = z.strictObject({
  name: ReviewDocumentFileNameSchema,
  source: z.string(),
  expectedSourceHash: z.string().nullable(),
});

export const ReviewScaffoldResponseSchema = ReviewInfoEventSchema.extend({
  pins: z
    .object({ baseCommit: z.string(), sourceCommit: z.string() })
    .optional(),
  checkouts: z
    .object({ head: z.string().nullable(), base: z.string().nullable() })
    .optional(),
  traces: z.object({
    sessions: z.array(
      z.object({
        id: z.string(),
        harness: z.enum(["codex", "claude-code", "opencode", "pi", "unknown"]),
        available: z.boolean(),
        traces: z.array(z.string()),
        commits: z.array(z.object({ sha: z.string(), subject: z.string() })),
      }),
    ),
    corpusRoot: z.string().nullable(),
    repository: z.string().nullable(),
    materializedSessions: z.array(
      z.object({
        session: z.string(),
        traces: z.number(),
        events: z.number(),
        files: z.number(),
      }),
    ),
    unavailableSessions: z.array(z.string()),
    events: z.number(),
    files: z.number(),
    paths: z.array(z.string()),
  }),
});
