import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";

import {
  createLiveReviewMcpServer,
  evaluateReviewCode,
} from "./live-review-mcp";
import type { BasicInfo, ReviewAPI } from "./live-review-types";

describe("live Review MCP adapter", () => {
  it("exposes one code-mode tool with the Review client at the root", async () => {
    const review = reviewApiFixture();
    const server = createLiveReviewMcpServer({ review });
    const client = new Client({ name: "test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      const tools = await client.listTools();
      expect(tools.tools.map(({ name }) => name)).toEqual(["execute"]);
      expect(tools.tools[0]?.description).toContain(
        "getBasicInfo(input?: { reviewId?: string }): Promise<BasicInfo>",
      );

      const result = await client.callTool({
        name: "execute",
        arguments: {
          code: `
const info = await review.createReview({
  source: { kind: "current-checkout" },
  title: "MCP tracer",
});
const rendered = await review.renderMdx({
  targetNodeId: info.rootNodeId,
  mode: "append",
  title: "Evidence",
  mdx: "Body",
});
return { info, rendered };`,
        },
      });

      expect(result.content).toEqual([
        {
          type: "text",
          text: expect.stringContaining('"reviewId": "review-1"'),
        },
      ]);
      expect(review.createReview).toHaveBeenCalledWith({
        source: { kind: "current-checkout" },
        title: "MCP tracer",
      });
      expect(review.renderMdx).toHaveBeenCalledWith({
        targetNodeId: "root",
        mode: "append",
        title: "Evidence",
        mdx: "Body",
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("uses fresh JavaScript globals for every execution", async () => {
    const review = reviewApiFixture();

    await evaluateReviewCode("globalThis.transient = 42;", review);

    await expect(
      evaluateReviewCode("return typeof transient;", review),
    ).resolves.toBe("undefined");
  });
});

function reviewApiFixture(): ReviewAPI {
  const info: BasicInfo = {
    reviewId: "review-1",
    title: "MCP tracer",
    status: "awaiting-agent",
    rootNodeId: "root",
    nodeCount: 1,
    binding: {
      kind: "current-checkout",
      worktreePath: "/repo",
      baseCommit: "a".repeat(40),
      sourceCommit: "a".repeat(40),
    },
  };
  return {
    listReviews: vi.fn<ReviewAPI["listReviews"]>(async () => []),
    createReview: vi.fn<ReviewAPI["createReview"]>(async () => info),
    openReview: vi.fn<ReviewAPI["openReview"]>(async () => info),
    getBasicInfo: vi.fn<ReviewAPI["getBasicInfo"]>(async () => info),
    getSelection: vi.fn<ReviewAPI["getSelection"]>(async () => ({
      reviewId: "review-1",
      nodeIds: [],
    })),
    getNodeInfo: vi.fn<ReviewAPI["getNodeInfo"]>(),
    getChildren: vi.fn<ReviewAPI["getChildren"]>(async () => []),
    renderMdx: vi.fn<ReviewAPI["renderMdx"]>(async () => ({
      ok: true as const,
      reviewId: "review-1",
      targetNodeId: "root",
      nodeId: "child-1",
      version: 1,
    })),
    setReviewStatus: vi.fn<ReviewAPI["setReviewStatus"]>(async () => ({
      ...info,
      status: "awaiting-review" as const,
    })),
  };
}
