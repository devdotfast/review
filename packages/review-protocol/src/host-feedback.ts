import { z } from "zod";

import { HostPrincipalSchema } from "./host-api.js";
import {
  HOST_LIMITS,
  HostHashSchema,
  HostIdSchema,
  HostKeySchema,
  HostOidSchema,
  HostSourceQuoteSchema,
  HostSourceRangeSchema,
  HostSourceSpanSchema,
  HostTimeSchema,
  HostVersionSchema,
} from "./host-document.js";

// Targets describe what the reader actually saw. Repinning never overwrites them.
const feedbackObserved = { reviewVersion: HostVersionSchema };
// Portable reader selection metadata, not executable markup or source evidence.
// Keeping the quote preserves the annotation when a canvas is reopened.
const feedbackSelection = z.strictObject({
  quote: z.string().min(1).max(HOST_LIMITS.commentBytes),
  prefix: z.string().max(256).optional(),
  suffix: z.string().max(256).optional(),
});
export const HostDiagramItemSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("actor"), actorId: HostKeySchema }),
  z.strictObject({ kind: z.literal("message"), messageId: HostKeySchema }),
  z.strictObject({
    kind: z.literal("frame"),
    side: z.enum(["base", "head"]),
    frameId: HostKeySchema,
  }),
  z.strictObject({ kind: z.literal("use_case"), useCaseId: HostKeySchema }),
  z.strictObject({
    kind: z.literal("operation"),
    useCaseId: HostKeySchema,
    operationId: HostKeySchema,
  }),
  z.strictObject({ kind: z.literal("map_element"), elementId: HostKeySchema }),
  z.strictObject({
    kind: z.literal("map_relationship"),
    relationshipId: HostKeySchema,
  }),
]);
export type HostDiagramItem = z.infer<typeof HostDiagramItemSchema>;
export const HostFeedbackTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...feedbackObserved,
    kind: z.literal("document"),
    selection: feedbackSelection.optional(),
  }),
  z.strictObject({
    ...feedbackObserved,
    kind: z.literal("node"),
    nodeId: HostKeySchema,
    selection: feedbackSelection.optional(),
  }),
  z.strictObject({
    ...feedbackObserved,
    kind: z.literal("source"),
    range: HostSourceRangeSchema,
    comparisonCommit: HostOidSchema.optional(),
  }),
  z.strictObject({
    ...feedbackObserved,
    kind: z.literal("diagram"),
    nodeId: HostKeySchema,
    item: HostDiagramItemSchema,
  }),
]);
export type HostFeedbackTarget = z.infer<typeof HostFeedbackTargetSchema>;
export const HostMessageBodySchema = z
  .string()
  .min(1)
  .max(HOST_LIMITS.commentBytes)
  .refine((body) => Boolean(body.trim()), "A message must contain text.")
  .refine(
    (body) =>
      new TextEncoder().encode(body).byteLength <= HOST_LIMITS.commentBytes,
    "Messages may not exceed 32 KiB of UTF-8 text.",
  );

export const HostDraftSchema = z.strictObject({
  id: HostIdSchema,
  reviewId: HostIdSchema,
  principalId: HostIdSchema,
  draftVersion: HostVersionSchema,
  target: HostFeedbackTargetSchema,
  evidence: HostSourceQuoteSchema.nullable(),
  body: HostMessageBodySchema,
  createdAt: HostTimeSchema,
  updatedAt: HostTimeSchema,
});
export type HostDraft = z.infer<typeof HostDraftSchema>;

export const HostThreadSchema = z.strictObject({
  id: HostIdSchema,
  reviewId: HostIdSchema,
  threadVersion: HostVersionSchema,
  target: HostFeedbackTargetSchema,
  evidence: HostSourceQuoteSchema.nullable(),
  status: z.enum(["open", "resolved"]),
  createdBy: HostIdSchema,
  createdAt: HostTimeSchema,
  updatedAt: HostTimeSchema,
});
export type HostThread = z.infer<typeof HostThreadSchema>;
export const HostMessageSchema = z.strictObject({
  id: HostIdSchema,
  threadId: HostIdSchema,
  ordinal: z.number().int().positive(),
  author: HostPrincipalSchema,
  body: HostMessageBodySchema,
  replyToMessageId: HostIdSchema.nullable(),
  questionRunId: HostIdSchema.nullable(),
  createdAt: HostTimeSchema,
});
export type HostMessage = z.infer<typeof HostMessageSchema>;

export const HostFeedbackSubmissionSchema = z.strictObject({
  id: HostIdSchema,
  reviewId: HostIdSchema,
  reviewVersion: HostVersionSchema,
  decision: z.enum(["comment", "request_changes", "approve"]),
  createdBy: HostIdSchema,
  createdAt: HostTimeSchema,
  messageIds: z.array(HostIdSchema).max(201),
  threadIds: z.array(HostIdSchema).max(201),
});
export type HostFeedbackSubmission = z.infer<
  typeof HostFeedbackSubmissionSchema
>;

const feedbackMappingIdentity = {
  threadId: HostIdSchema,
  reviewVersion: HostVersionSchema,
};
export const HostThreadMappingSchema = z.discriminatedUnion("status", [
  z.strictObject({
    ...feedbackMappingIdentity,
    status: z.enum(["exact", "relocated"]),
    target: HostFeedbackTargetSchema,
    evidence: HostSourceQuoteSchema.nullable(),
  }),
  z.strictObject({
    ...feedbackMappingIdentity,
    status: z.literal("missing"),
    target: z.null(),
    evidence: z.null(),
    reason: z.enum([
      "target_removed",
      "selection_ambiguous",
      "selection_changed",
      "identity_mismatch",
      "source_unavailable",
      "comparison_not_available",
    ]),
  }),
]);
export type HostThreadMapping = z.infer<typeof HostThreadMappingSchema>;

// Saved Ask context retains source text only in its bounded sourceEvidence.
export const HostQuestionTargetMappingSchema = z.discriminatedUnion("status", [
  HostThreadMappingSchema.options[0].omit({ evidence: true }),
  HostThreadMappingSchema.options[1].omit({ evidence: true }),
]);

export const HostQuestionExcerptSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.enum(["complete", "truncated"]),
    text: z.string().max(8_000),
  }),
  z.strictObject({
    state: z.literal("omitted"),
    reason: z.literal("context_limit"),
  }),
]);
export type HostQuestionExcerpt = z.infer<typeof HostQuestionExcerptSchema>;
export const HostQuestionContextSchema = z.strictObject({
  id: HostIdSchema,
  reviewId: HostIdSchema,
  reviewVersion: HostVersionSchema,
  question: HostMessageBodySchema,
  material: z.strictObject({
    schemaVersion: z.literal(1),
    review: z.strictObject({ title: HostQuestionExcerptSchema }),
    binding: z.strictObject({
      repositoryId: HostIdSchema,
      baseCommit: HostOidSchema,
      headCommit: HostOidSchema,
    }),
    mapVersions: z.strictObject({
      base: HostIdSchema.nullable(),
      head: HostIdSchema.nullable(),
    }),
    originalTarget: HostFeedbackTargetSchema,
    viewedTarget: HostQuestionTargetMappingSchema,
    sourceEvidence: z
      .strictObject({
        span: HostSourceSpanSchema,
        sha256: HostHashSchema,
        text: HostQuestionExcerptSchema,
      })
      .nullable(),
    documentJson: HostQuestionExcerptSchema,
    priorMessages: z
      .array(
        z.strictObject({
          id: HostIdSchema,
          author: HostPrincipalSchema,
          body: HostQuestionExcerptSchema,
        }),
      )
      .max(8),
    priorMessagesOmitted: z.number().int().nonnegative(),
  }),
});
export type HostQuestionContext = z.infer<typeof HostQuestionContextSchema>;
export const HostQuestionHarnessSchema = z.enum(["codex", "claude-code", "pi"]);
export const HostQuestionRunSchema = z.strictObject({
  id: HostIdSchema,
  reviewId: HostIdSchema,
  threadId: HostIdSchema,
  questionId: HostIdSchema,
  contextId: HostIdSchema,
  requestedBy: HostIdSchema,
  assistant: HostPrincipalSchema,
  harness: HostQuestionHarnessSchema,
  state: z.enum(["pending", "running", "completed", "failed", "interrupted"]),
  sessionId: z.string().min(1).max(512).nullable(),
  answerMessageId: HostIdSchema.nullable(),
  error: z.string().max(4096).nullable(),
  createdAt: HostTimeSchema,
  updatedAt: HostTimeSchema,
});
export type HostQuestionRun = z.infer<typeof HostQuestionRunSchema>;

export const HostAttentionSchema = z.strictObject({
  reviewId: HostIdSchema,
  principalId: HostIdSchema,
  attentionVersion: HostVersionSchema,
  lastViewedReviewVersion: HostVersionSchema.nullable(),
  lastViewedAt: HostTimeSchema.nullable(),
  pinned: z.boolean(),
});
export type HostAttention = z.infer<typeof HostAttentionSchema>;

const feedbackReview = { reviewId: HostIdSchema };
const feedbackThread = { ...feedbackReview, threadId: HostIdSchema };
const feedbackPage = {
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.number().int().min(1).max(200).optional(),
};
function hostFeedbackPage<T extends z.ZodType>(item: T) {
  return z.strictObject({
    items: z.array(item).max(200),
    nextCursor: z.string().min(1).max(2048).nullable(),
  });
}
const feedbackCreatedThread = z.strictObject({
  thread: HostThreadSchema,
  message: HostMessageSchema,
});
const feedbackQuestionResult = feedbackCreatedThread.extend({
  run: HostQuestionRunSchema,
});

export const HOST_FEEDBACK_COMMANDS = {
  "draft.save": {
    permission: "human" as const,
    input: z.strictObject({
      ...feedbackReview,
      draftId: HostIdSchema,
      expectedDraftVersion: HostVersionSchema.nullable(),
      target: HostFeedbackTargetSchema,
      body: HostMessageBodySchema,
    }),
    result: HostDraftSchema,
  },
  "draft.delete": {
    permission: "human" as const,
    input: z.strictObject({
      ...feedbackReview,
      draftId: HostIdSchema,
      expectedDraftVersion: HostVersionSchema,
    }),
    result: z.strictObject({ deleted: z.literal(true) }),
  },
  "thread.create": {
    permission: "human" as const,
    input: z.strictObject({
      ...feedbackReview,
      target: HostFeedbackTargetSchema,
      body: HostMessageBodySchema,
    }),
    result: feedbackCreatedThread,
  },
  "thread.reply": {
    permission: "author" as const,
    input: z.strictObject({
      ...feedbackThread,
      replyToMessageId: HostIdSchema.optional(),
      body: HostMessageBodySchema,
    }),
    result: HostMessageSchema,
  },
  "thread.set_status": {
    permission: "author" as const,
    input: z.strictObject({
      ...feedbackThread,
      expectedThreadVersion: HostVersionSchema,
      status: HostThreadSchema.shape.status,
    }),
    result: HostThreadSchema,
  },
  "feedback.submit": {
    permission: "human" as const,
    input: z.strictObject({
      ...feedbackReview,
      reviewVersion: HostVersionSchema,
      decision: HostFeedbackSubmissionSchema.shape.decision,
      drafts: z
        .array(
          z.strictObject({
            draftId: HostIdSchema,
            expectedDraftVersion: HostVersionSchema,
          }),
        )
        .max(200),
      body: HostMessageBodySchema.optional(),
    }),
    result: HostFeedbackSubmissionSchema,
  },
  "question.start": {
    permission: "human" as const,
    input: z.strictObject({
      ...feedbackReview,
      target: HostFeedbackTargetSchema,
      body: HostMessageBodySchema,
      harness: HostQuestionHarnessSchema.optional(),
    }),
    result: feedbackQuestionResult,
  },
  "question.follow_up": {
    permission: "human" as const,
    input: z.strictObject({
      ...feedbackThread,
      reviewVersion: HostVersionSchema,
      body: HostMessageBodySchema,
      harness: HostQuestionHarnessSchema.optional(),
    }),
    result: feedbackQuestionResult,
  },
  "question.retry": {
    permission: "human" as const,
    input: z.strictObject({ ...feedbackReview, runId: HostIdSchema }),
    result: HostQuestionRunSchema,
  },
  "question.complete": {
    permission: "answer" as const,
    input: z.strictObject({
      ...feedbackReview,
      runId: HostIdSchema,
      body: HostMessageBodySchema,
    }),
    result: z.strictObject({
      run: HostQuestionRunSchema,
      message: HostMessageSchema,
    }),
  },
  "attention.update": {
    permission: "human" as const,
    input: z
      .strictObject({
        ...feedbackReview,
        expectedAttentionVersion: HostVersionSchema,
        lastViewedReviewVersion: HostVersionSchema.optional(),
        pinned: z.boolean().optional(),
      })
      .refine(
        (input) =>
          input.lastViewedReviewVersion !== undefined ||
          input.pinned !== undefined,
        "An attention update must include a viewed version or pin preference.",
      ),
    result: HostAttentionSchema,
  },
};
export type HostFeedbackCommand = {
  [K in keyof typeof HOST_FEEDBACK_COMMANDS]: {
    type: K;
    input: z.infer<(typeof HOST_FEEDBACK_COMMANDS)[K]["input"]>;
  };
}[keyof typeof HOST_FEEDBACK_COMMANDS];

export const HOST_FEEDBACK_QUERIES = {
  "drafts.list": {
    permission: "human" as const,
    input: z.strictObject({ ...feedbackReview, ...feedbackPage }),
    result: hostFeedbackPage(HostDraftSchema),
  },
  "threads.list": {
    permission: "read" as const,
    input: z.strictObject({
      ...feedbackReview,
      ...feedbackPage,
      status: HostThreadSchema.shape.status.optional(),
    }),
    result: hostFeedbackPage(HostThreadSchema),
  },
  "thread.get": {
    permission: "read" as const,
    input: z.strictObject({ ...feedbackThread, ...feedbackPage }),
    result: z.strictObject({
      thread: HostThreadSchema,
      messages: hostFeedbackPage(HostMessageSchema),
    }),
  },
  "thread.mapping": {
    permission: "read" as const,
    input: z.strictObject({
      ...feedbackThread,
      reviewVersion: HostVersionSchema,
    }),
    result: HostThreadMappingSchema,
  },
  "feedback.list": {
    permission: "read" as const,
    input: z.strictObject({ ...feedbackReview, ...feedbackPage }),
    result: hostFeedbackPage(HostFeedbackSubmissionSchema),
  },
  "feedback.get": {
    permission: "read" as const,
    input: z.strictObject({ ...feedbackReview, submissionId: HostIdSchema }),
    result: HostFeedbackSubmissionSchema,
  },
  "question.get": {
    permission: "read" as const,
    input: z.strictObject({ ...feedbackReview, runId: HostIdSchema }),
    result: HostQuestionRunSchema,
  },
  "question.context": {
    permission: "read" as const,
    input: z.strictObject({ ...feedbackReview, runId: HostIdSchema }),
    result: HostQuestionContextSchema,
  },
  "questions.list": {
    permission: "read" as const,
    input: z.strictObject({
      ...feedbackReview,
      threadId: HostIdSchema.optional(),
      ...feedbackPage,
    }),
    result: hostFeedbackPage(HostQuestionRunSchema),
  },
  "attention.get": {
    permission: "human" as const,
    input: z.strictObject(feedbackReview),
    result: HostAttentionSchema,
  },
};
export type HostFeedbackQuery = {
  [K in keyof typeof HOST_FEEDBACK_QUERIES]: {
    type: K;
    input: z.infer<(typeof HOST_FEEDBACK_QUERIES)[K]["input"]>;
  };
}[keyof typeof HOST_FEEDBACK_QUERIES];
