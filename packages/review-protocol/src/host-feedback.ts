import { z } from "zod";

import { HostPrincipalSchema } from "./host-api.js";
import {
  HOST_LIMITS,
  HostIdSchema,
  HostKeySchema,
  HostSourceQuoteSchema,
  HostSourceRangeSchema,
  HostTimeSchema,
  HostVersionSchema,
} from "./host-document.js";

// Targets describe what the reader actually saw. Repinning never overwrites them.
const feedbackObserved = { documentVersion: HostVersionSchema };
export const HostFeedbackTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...feedbackObserved, kind: z.literal("document") }),
  z.strictObject({
    ...feedbackObserved,
    kind: z.literal("node"),
    nodeId: HostKeySchema,
  }),
  z.strictObject({
    ...feedbackObserved,
    kind: z.literal("source"),
    range: HostSourceRangeSchema,
  }),
  z.strictObject({
    ...feedbackObserved,
    kind: z.literal("diagram"),
    nodeId: HostKeySchema,
    itemId: HostKeySchema,
  }),
  z.strictObject({
    ...feedbackObserved,
    kind: z.literal("trace"),
    nodeId: HostKeySchema,
    eventId: HostIdSchema,
  }),
]);
export type HostFeedbackTarget = z.infer<typeof HostFeedbackTargetSchema>;
export const HostMessageBodySchema = z
  .string()
  .min(1)
  .max(HOST_LIMITS.commentBytes);

export const HostDraftSchema = z.strictObject({
  id: HostIdSchema,
  reviewId: HostIdSchema,
  principalId: HostIdSchema,
  version: HostVersionSchema,
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
  version: HostVersionSchema,
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
  checkpointId: HostIdSchema,
  decision: z.enum(["comment", "request_changes", "approve"]),
  createdBy: HostIdSchema,
  createdAt: HostTimeSchema,
  messageIds: z.array(HostIdSchema).max(200),
  threadIds: z.array(HostIdSchema).max(200),
});
export type HostFeedbackSubmission = z.infer<
  typeof HostFeedbackSubmissionSchema
>;

export const HostThreadMappingSchema = z.strictObject({
  threadId: HostIdSchema,
  documentVersion: HostVersionSchema,
  status: z.enum(["exact", "relocated", "missing"]),
  target: HostFeedbackTargetSchema.nullable(),
  evidence: HostSourceQuoteSchema.nullable(),
});
export type HostThreadMapping = z.infer<typeof HostThreadMappingSchema>;

export const HostQuestionContextSchema = z.strictObject({
  id: HostIdSchema,
  reviewId: HostIdSchema,
  documentVersion: HostVersionSchema,
  question: HostMessageBodySchema,
  material: z.json(),
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
  version: HostVersionSchema,
  viewedDocumentVersion: HostVersionSchema.nullable(),
  viewedAt: HostTimeSchema.nullable(),
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
      expectedVersion: HostVersionSchema.nullable(),
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
      expectedVersion: HostVersionSchema,
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
      messageId: HostIdSchema,
      replyToMessageId: HostIdSchema.optional(),
      body: HostMessageBodySchema,
    }),
    result: HostMessageSchema,
  },
  "thread.status": {
    permission: "author" as const,
    input: z.strictObject({
      ...feedbackThread,
      expectedVersion: HostVersionSchema,
      status: HostThreadSchema.shape.status,
    }),
    result: HostThreadSchema,
  },
  "feedback.submit": {
    permission: "human" as const,
    input: z.strictObject({
      ...feedbackReview,
      checkpointId: HostIdSchema,
      decision: HostFeedbackSubmissionSchema.shape.decision,
      drafts: z
        .array(
          z.strictObject({
            draftId: HostIdSchema,
            expectedVersion: HostVersionSchema,
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
      harness: HostQuestionHarnessSchema,
    }),
    result: feedbackQuestionResult,
  },
  "question.follow_up": {
    permission: "human" as const,
    input: z.strictObject({
      ...feedbackThread,
      body: HostMessageBodySchema,
      harness: HostQuestionHarnessSchema,
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
      outputId: HostIdSchema,
      body: HostMessageBodySchema,
    }),
    result: z.strictObject({
      run: HostQuestionRunSchema,
      message: HostMessageSchema,
    }),
  },
  "review.attention": {
    permission: "human" as const,
    input: z.strictObject({
      ...feedbackReview,
      expectedVersion: HostVersionSchema,
      viewedDocumentVersion: HostVersionSchema.nullable().optional(),
      pinned: z.boolean().optional(),
    }),
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
      documentVersion: HostVersionSchema,
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
