import { PassThrough } from "node:stream";

import {
  type JsonObject,
  isJsonObject,
  parseJsonText,
} from "@dev.fast/review-protocol";
import { describe, expect, it, vi } from "vitest";

import type { ReviewCanvasApi } from "./review-canvas-api-client";
import { runReviewMcp } from "./review-mcp";

describe("Review MCP server", () => {
  it("routes rich MDX input reads and writes through the API", async () => {
    const api = fakeApi();
    const reviewId = "11111111-1111-4111-8111-111111111111";
    const source = "export const title = 'From MCP';";
    const output = await exchange(api, [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "review_get_document_file",
          arguments: { reviewId, name: "data.ts" },
        },
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "review_write_document_file",
          arguments: {
            reviewId,
            name: "data.ts",
            source,
            expectedSourceHash: null,
          },
        },
      },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "review_write_document_file",
          arguments: { reviewId, name: "data.ts", source },
        },
      },
    ]);
    expect(api.getDocumentFile).toHaveBeenCalledWith(reviewId, "data.ts");
    expect(api.writeDocumentFile).toHaveBeenCalledExactlyOnceWith(
      reviewId,
      "data.ts",
      { source, expectedSourceHash: null },
    );
    expect(output[1]).toMatchObject({
      result: { structuredContent: { ok: true, file: { source } } },
    });
    expect(output[2]).toMatchObject({ result: { isError: true } });
  });
  it("negotiates and exposes explicit Review canvas tools", async () => {
    const output = await exchange(fakeApi(), [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ]);

    expect(output[0]).toMatchObject({
      id: 1,
      result: { serverInfo: { name: "review-canvas" } },
    });
    expect(output[1]).toMatchObject({
      id: 2,
      result: {
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "review_get_document" }),
          expect.objectContaining({ name: "review_insert_node" }),
          expect.objectContaining({ name: "review_reply_comment" }),
        ]),
      },
    });
  });

  it("routes a node mutation through the Review API", async () => {
    const api = fakeApi();
    const mutate = vi.mocked(api.mutateDocument);
    const output = await exchange(api, [
      {
        jsonrpc: "2.0",
        id: "call-1",
        method: "tools/call",
        params: {
          name: "review_insert_node",
          arguments: {
            reviewId: "11111111-1111-4111-8111-111111111111",
            mutationId: "mutation-1",
            expectedRevision: 4,
            index: 1,
            node: { id: "next", kind: "markdown", content: "Next" },
          },
        },
      },
    ]);

    expect(mutate).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      expect.objectContaining({
        mutationId: "mutation-1",
        expectedRevision: 4,
        operation: {
          type: "insert",
          index: 1,
          node: { id: "next", kind: "markdown", content: "Next" },
        },
      }),
    );
    expect(output[0]).toMatchObject({
      id: "call-1",
      result: {
        structuredContent: {
          ok: true,
          mutationId: "mutation-1",
        },
      },
    });
  });
});

async function exchange(
  api: ReviewCanvasApi,
  requests: JsonObject[],
): Promise<JsonObject[]> {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  let output = "";
  stdout.on("data", (chunk) => (output += String(chunk)));
  stdin.end(
    `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
  );
  await runReviewMcp({ api, stdin, stdout });
  return output
    .trim()
    .split("\n")
    .map((line) => {
      const value = parseJsonText(line);
      if (!isJsonObject(value))
        throw new Error("MCP response is not an object.");
      return value;
    });
}

function fakeApi(): ReviewCanvasApi {
  const snapshot = {
    reviewId: "11111111-1111-4111-8111-111111111111",
    routePath: "/",
    mode: "incremental" as const,
    revision: 5,
    sourceHash: "hash",
    source: "source",
    nodes: [{ id: "next", kind: "markdown" as const, content: "Next" }],
  };
  const getDocument = vi.fn<ReviewCanvasApi["getDocument"]>(async () => ({
    ok: true,
    snapshot,
  }));
  const mutateDocument = vi.fn<ReviewCanvasApi["mutateDocument"]>(
    async (_reviewId, request) => ({
      ok: true,
      mutationId: request.mutationId,
      snapshot,
    }),
  );
  const getComments = vi.fn<ReviewCanvasApi["getComments"]>(async () => ({
    ok: true,
    snapshot: { revision: 0, comments: {}, drafts: {} },
  }));
  const command = vi.fn<ReviewCanvasApi["command"]>(
    async (_reviewId, command) => ({
      ok: true,
      commit: {
        mutationId: command.mutationId,
        revision: 1,
        upsertedThreads: [],
        deletedThreadIds: [],
        upsertedDrafts: [],
        deletedDraftThreadIds: [],
      },
    }),
  );
  const reply = vi.fn<ReviewCanvasApi["reply"]>(async (input) => ({
    ok: true,
    commit: {
      mutationId: input.mutationId,
      revision: 1,
      upsertedThreads: [],
      deletedThreadIds: [],
      upsertedDrafts: [],
      deletedDraftThreadIds: [],
    },
  }));
  return {
    getDocumentFile: vi.fn<ReviewCanvasApi["getDocumentFile"]>(
      async (_reviewId, name) => ({
        ok: true as const,
        file: { name, source: null, sourceHash: null },
      }),
    ),
    writeDocumentFile: vi.fn<ReviewCanvasApi["writeDocumentFile"]>(
      async (_reviewId, name, request) => ({
        ok: true as const,
        file: { name, source: request.source, sourceHash: "new-hash" },
      }),
    ),
    getDocument,
    mutateDocument,
    getComments,
    command,
    reply,
  };
}
