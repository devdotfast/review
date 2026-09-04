import { Script, createContext } from "node:vm";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { createReviewApi } from "./live-review-api";
import type { ReviewAPI } from "./live-review-types";

const REVIEW_CODE_MODE_DESCRIPTION = `Run JavaScript with the Review API injected as the global \`review\` binding.
Top-level await is supported; finish with \`return value\` to return a result. Each call has fresh
JavaScript globals, while \`review\` retains the currently opened Review across calls.

Available API:
declare const review: {
  listReviews(input?: { scope?: "current-checkout" | "all" }): Promise<ReviewSummary[]>;
  createReview(input: { source: { kind: "current-checkout" }; title: string }): Promise<BasicInfo>;
  openReview(input: { reviewId: string }): Promise<BasicInfo>;
  getBasicInfo(input?: { reviewId?: string }): Promise<BasicInfo>;
  getSelection(input?: { reviewId?: string }): Promise<{ reviewId: string; nodeIds: string[] }>;
  getNodeInfo(input: { reviewId?: string; nodeId: string }): Promise<Node>;
  getChildren(input: { reviewId?: string; nodeId: string }): Promise<Node[]>;
  renderMdx(input: { reviewId?: string; targetNodeId: string; mode: "append" | "replace"; title?: string; mdx: string }): Promise<RenderResult>;
  setReviewStatus(input: { reviewId?: string; status: "awaiting-review" }): Promise<BasicInfo>;
};

BasicInfo includes reviewId, title, status, rootNodeId, nodeCount, and binding.
Node includes id, parentId, optional title, complete authored source, and childIds.
Successful renderMdx returns the affected nodeId and new version; validation failures return diagnostics.`;

export function createLiveReviewMcpServer(input: {
  review: ReviewAPI;
}): McpServer {
  const server = new McpServer({ name: "review", version: "0.0.1" });

  server.registerTool(
    "execute",
    {
      description: REVIEW_CODE_MODE_DESCRIPTION,
      inputSchema: {
        code: z.string().min(1).describe("JavaScript program to evaluate"),
      },
    },
    async ({ code }) => {
      const value = await evaluateReviewCode(code, input.review);
      return {
        content: [{ type: "text", text: serializeEvaluationResult(value) }],
      };
    },
  );

  return server;
}

export async function evaluateReviewCode(
  code: string,
  review: ReviewAPI,
): Promise<unknown> {
  const context = createContext({ review: reviewBinding(review) });
  const script = new Script(`(async () => {\n${code}\n})()`, {
    filename: "review-mcp-input.js",
  });
  return script.runInContext(context);
}

export async function runLiveReviewMcpServer(
  input: { cwd?: string } = {},
): Promise<void> {
  const cwd =
    process.env.DEV_FAST_REVIEW_CWD?.trim() || input.cwd || process.cwd();
  const server = createLiveReviewMcpServer({
    review: createReviewApi({ cwd }),
  });
  await server.connect(new StdioServerTransport());
}

function reviewBinding(review: ReviewAPI): Readonly<ReviewAPI> {
  return Object.freeze({
    listReviews: review.listReviews.bind(review),
    createReview: review.createReview.bind(review),
    openReview: review.openReview.bind(review),
    getBasicInfo: review.getBasicInfo.bind(review),
    getSelection: review.getSelection.bind(review),
    getNodeInfo: review.getNodeInfo.bind(review),
    getChildren: review.getChildren.bind(review),
    renderMdx: review.renderMdx.bind(review),
    setReviewStatus: review.setReviewStatus.bind(review),
  });
}

function serializeEvaluationResult(value: unknown): string {
  if (value === undefined) return "undefined";
  return JSON.stringify(
    value,
    (_key, nested) =>
      typeof nested === "bigint" ? `${nested.toString()}n` : nested,
    2,
  );
}
