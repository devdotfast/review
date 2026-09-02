import { z } from "zod";

import type {
  BasicInfo,
  Node,
  RenderResult,
  ReviewSummary,
  Selection,
} from "./live-review-types";

const statusSchema = z.enum([
  "awaiting-agent",
  "awaiting-review",
  "accepted",
  "rejected",
]);

const bindingSchema = z.strictObject({
  kind: z.literal("current-checkout"),
  worktreePath: z.string().min(1),
  baseCommit: z.string().min(1),
  sourceCommit: z.string().min(1),
});

const basicInfoSchema: z.ZodType<BasicInfo> = z.strictObject({
  reviewId: z.string().min(1),
  title: z.string().min(1),
  status: statusSchema,
  rootNodeId: z.string().min(1),
  nodeCount: z.number().int().nonnegative(),
  binding: bindingSchema,
});

const reviewSummarySchema: z.ZodType<ReviewSummary> = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
  status: statusSchema,
  updatedAt: z.iso.datetime(),
  binding: bindingSchema,
  matchesCheckout: z.boolean(),
});

const nodeSchema: z.ZodType<Node> = z.strictObject({
  id: z.string().min(1),
  parentId: z.string().min(1).nullable(),
  title: z.string().min(1).optional(),
  source: z.string(),
  childIds: z.array(z.string().min(1)),
});

const selectionSchema: z.ZodType<Selection> = z.strictObject({
  reviewId: z.string().min(1),
  nodeIds: z.array(z.string().min(1)),
});

const renderResultSchema: z.ZodType<RenderResult> = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    reviewId: z.string().min(1),
    targetNodeId: z.string().min(1),
    nodeId: z.string().min(1),
    version: z.number().int().nonnegative(),
  }),
  z.strictObject({
    ok: z.literal(false),
    reviewId: z.string().min(1),
    targetNodeId: z.string().min(1),
    diagnostics: z.array(
      z.strictObject({
        path: z.string(),
        message: z.string().min(1),
      }),
    ),
  }),
]);

export const liveReviewListRequestSchema = z.strictObject({
  cwd: z.string().min(1),
  scope: z.enum(["current-checkout", "all"]).optional(),
});

export const liveReviewCreateRequestSchema = z.strictObject({
  requestId: z.uuid(),
  cwd: z.string().min(1),
  source: z.strictObject({ kind: z.literal("current-checkout") }),
  title: z.string().trim().min(1),
});

export const liveReviewRenderRequestSchema = z.strictObject({
  requestId: z.uuid(),
  targetNodeId: z.string().min(1),
  mode: z.enum(["append", "replace"]),
  title: z.string().optional(),
  mdx: z.string(),
});

export const liveReviewStatusRequestSchema = z.strictObject({
  status: z.literal("awaiting-review"),
});

export function parseLiveReviewListResponse(value: unknown): ReviewSummary[] {
  return z.strictObject({ reviews: z.array(reviewSummarySchema) }).parse(value)
    .reviews;
}

export function parseLiveReviewBootstrapResponse(value: unknown): BasicInfo {
  return z
    .strictObject({ info: basicInfoSchema, sessionId: z.string().min(1) })
    .passthrough()
    .parse(value).info;
}

export function parseLiveReviewBasicInfo(value: unknown): BasicInfo {
  return basicInfoSchema.parse(value);
}

export function parseLiveReviewSelection(value: unknown): Selection {
  return selectionSchema.parse(value);
}

export function parseLiveReviewNode(value: unknown): Node {
  return nodeSchema.parse(value);
}

export function parseLiveReviewChildren(value: unknown): Node[] {
  return z.strictObject({ children: z.array(nodeSchema) }).parse(value)
    .children;
}

export function parseLiveReviewRenderResult(value: unknown): RenderResult {
  return renderResultSchema.parse(value);
}
