import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  HOST_COMMAND_DEFINITIONS,
  HOST_QUERY_DEFINITIONS,
  HostCapabilitiesSchema,
  type HostCommand,
  HostCommandSchema,
  HostQuerySchema,
  hostCommandResponseSchema,
  hostMcpToolName,
  hostMcpTools,
  hostQueryResponseSchema,
} from "./host-commands.js";
import { HOST_LIMITS, type HostDocumentCommit } from "./host-document.js";

const id = "27768987-4d4d-4c6f-885c-4bf783f44c27";
const otherId = "8afbc67c-089e-4d84-95d1-16d5e4710484";
const address = {
  apiVersion: 1,
  hostId: id,
  workspaceId: otherId,
  clientId: id,
};
const createdAt = "2026-09-10T12:00:00Z";
const mutation: HostCommand<"document.mutate"> = {
  apiVersion: 1,
  hostId: id,
  workspaceId: otherId,
  clientId: id,
  commandId: otherId,
  type: "document.mutate",
  input: {
    reviewId: id,
    expectedDocumentVersion: 3,
    operations: [
      {
        op: "definition.put",
        id: "database",
        value: {
          kind: "anchor",
          title: "Database",
          source: {
            side: "head",
            file: "src/database.ts",
            fromLine: 1,
            toLine: 5,
          },
        },
      },
      {
        op: "node.insert",
        node: { id: "peek", type: "code_peek", anchorId: "database" },
        placement: { parentId: null, afterId: null },
      },
    ],
  },
};
const commit: HostDocumentCommit = {
  documentId: id,
  previousVersion: 3,
  version: 4,
  contentHash: "a".repeat(64),
  createdAt,
  changedNodes: {
    peek: { id: "peek", type: "code_peek", anchorId: "database" },
  },
  removedNodeIds: [],
  changedDefinitions: {
    database: {
      kind: "anchor",
      title: "Database",
      source: { side: "head", file: "src/database.ts", fromLine: 1, toLine: 5 },
    },
  },
  removedDefinitionIds: [],
  changedEvidence: {
    database: {
      span: {
        repositoryId: id,
        commit: "b".repeat(40),
        blob: "c".repeat(40),
        file: "src/database.ts",
        fromLine: 1,
        toLine: 5,
      },
      text: "source",
      sha256: "d".repeat(64),
    },
  },
  removedEvidenceIds: [],
  roots: ["peek"],
  binding: {
    id,
    repositoryId: id,
    selector: { kind: "snapshot", ref: "main" },
    baseCommit: "b".repeat(40),
    headCommit: "b".repeat(40),
    createdAt,
  },
  diagnostics: [],
};

describe("typed host command and query envelopes", () => {
  it("accepts an atomic definition and node insertion with version and retry identity", () => {
    const parsed = HostCommandSchema.parse(mutation);
    expect(parsed).toEqual(mutation);
    if (parsed.type !== "document.mutate")
      throw new Error("unexpected command");
    expect(parsed.input.expectedDocumentVersion).toBe(3);
  });

  it("accepts dry-run validation through the query contract without a command ID", () => {
    const query = {
      ...address,
      type: "document.validate",
      input: mutation.input,
    };
    expect(HostQuerySchema.parse(query)).toEqual(query);
    expect(HostQuerySchema.safeParse({ ...query, commandId: id }).success).toBe(
      false,
    );
    expect(
      HostCommandSchema.safeParse({ ...query, commandId: id }).success,
    ).toBe(false);
  });

  it.each(["hostId", "workspaceId", "clientId", "commandId"])(
    "requires %s on authoring requests",
    (field) => {
      const request = { ...mutation };
      Reflect.deleteProperty(request, field);
      expect(HostCommandSchema.safeParse(request).success).toBe(false);
    },
  );

  it("rejects identity impersonation fields and mismatched operation payloads", () => {
    expect(
      HostCommandSchema.safeParse({ ...mutation, authorId: otherId }).success,
    ).toBe(false);
    expect(
      HostCommandSchema.safeParse({
        ...mutation,
        input: { ...mutation.input, createdBy: otherId },
      }).success,
    ).toBe(false);
    expect(
      HostCommandSchema.safeParse({ ...mutation, type: "review.publish" })
        .success,
    ).toBe(false);
    expect(
      HostCommandSchema.safeParse({ ...mutation, apiVersion: 2 }).success,
    ).toBe(false);
  });

  it("creates reviews without trusting an author session supplied by the caller", () => {
    const request = {
      ...address,
      commandId: id,
      type: "review.create",
      input: {
        repositoryId: otherId,
        change: { kind: "range", baseRef: "main", headRef: "feature/review" },
        title: "API review",
      },
    };
    expect(HostCommandSchema.parse(request)).toEqual(request);
    expect(
      HostCommandSchema.safeParse({
        ...request,
        input: { ...request.input, authorSessionId: id },
      }).success,
    ).toBe(false);
  });

  it("requires independent review and document versions for publication", () => {
    const input = {
      reviewId: id,
      expectedDocumentVersion: 3,
      expectedReviewVersion: 1,
      mapVersions: { base: null, head: null },
    };
    expect(
      HostCommandSchema.parse({
        ...address,
        commandId: id,
        type: "review.publish",
        input,
      }).input,
    ).toEqual(input);
    expect(
      HOST_COMMAND_DEFINITIONS["review.publish"].input.safeParse({
        reviewId: id,
        expectedDocumentVersion: 3,
        mapVersions: { base: null, head: null },
      }).success,
    ).toBe(false);
  });

  it("requires an exact observed version for selected nodes and evidence", () => {
    expect(
      HostQuerySchema.safeParse({
        ...address,
        type: "document.nodes",
        input: { reviewId: id, ids: ["peek"] },
      }).success,
    ).toBe(false);
    const input = { reviewId: id, version: 3, anchorIds: ["database"] };
    expect(
      HostQuerySchema.parse({ ...address, type: "document.evidence", input })
        .input,
    ).toEqual(input);
  });

  it("bounds operations and page sizes without coercing numbers", () => {
    expect(
      HostCommandSchema.safeParse({
        ...mutation,
        input: { ...mutation.input, expectedDocumentVersion: "3" },
      }).success,
    ).toBe(false);
    expect(
      HostCommandSchema.safeParse({
        ...mutation,
        input: { ...mutation.input, operations: [] },
      }).success,
    ).toBe(false);
    expect(
      HostCommandSchema.safeParse({
        ...mutation,
        input: {
          ...mutation.input,
          operations: Array.from(
            { length: HOST_LIMITS.operations + 1 },
            () => mutation.input.operations[0],
          ),
        },
      }).success,
    ).toBe(false);
    for (const limit of [0, 201, "50"]) {
      expect(
        HostQuerySchema.safeParse({
          ...address,
          type: "reviews.list",
          input: { limit },
        }).success,
      ).toBe(false);
    }
  });

  it("does not accept deferred maps, comments, execution or file-authoring methods", () => {
    for (const type of [
      "map.create",
      "thread.reply",
      "ask.start",
      "review_write_document_file",
    ]) {
      expect(
        HostCommandSchema.safeParse({
          ...address,
          commandId: id,
          type,
          input: {},
        }).success,
      ).toBe(false);
    }
  });

  it("separates trusted registration, human lifecycle, authoring and publication permissions", () => {
    expect(HOST_COMMAND_DEFINITIONS["repository.register"].permission).toBe(
      "register_repository",
    );
    expect(HOST_COMMAND_DEFINITIONS["document.mutate"].permission).toBe(
      "author",
    );
    expect(HOST_COMMAND_DEFINITIONS["review.create"].permission).toBe("author");
    expect(HOST_COMMAND_DEFINITIONS["review.publish"].permission).toBe(
      "publish",
    );
    expect(HOST_COMMAND_DEFINITIONS["review.trash"].permission).toBe("human");
    expect(HOST_QUERY_DEFINITIONS["document.validate"].permission).toBe("read");
  });
});

describe("host results", () => {
  it("returns a sparse commit and creation time together with its retry ID and cursor", () => {
    const response = {
      ok: true,
      data: {
        commandId: otherId,
        eventCursor: "opaque-commit-cursor",
        result: commit,
      },
    };
    expect(
      hostCommandResponseSchema("document.mutate").parse(response),
    ).toEqual(response);
    expect(
      hostCommandResponseSchema("document.mutate").safeParse({
        ...response,
        data: {
          ...response.data,
          result: { ...commit, nodes: commit.changedNodes },
        },
      }).success,
    ).toBe(false);
    const withoutTime = { ...commit };
    Reflect.deleteProperty(withoutTime, "createdAt");
    expect(
      hostCommandResponseSchema("document.mutate").safeParse({
        ...response,
        data: { ...response.data, result: withoutTime },
      }).success,
    ).toBe(false);
  });

  it("requires a snapshot cursor separately from the page's continuation cursor", () => {
    const response = {
      ok: true,
      data: {
        eventCursor: "event-watermark",
        result: { items: [], nextCursor: "page-bound-to-filters" },
      },
    };
    expect(hostQueryResponseSchema("reviews.list").parse(response)).toEqual(
      response,
    );
    expect(
      hostQueryResponseSchema("reviews.list").safeParse({
        ok: true,
        data: { result: response.data.result },
      }).success,
    ).toBe(false);
  });

  it("preserves structured conflicts and field diagnostics without accepting raw exceptions", () => {
    const response = {
      ok: false,
      error: {
        code: "VERSION_CONFLICT",
        message: "Read the current document",
        retryable: false,
        currentVersion: 4,
        diagnostics: [],
      },
    };
    expect(
      hostCommandResponseSchema("document.mutate").parse(response),
    ).toEqual(response);
    expect(
      hostCommandResponseSchema("document.mutate").safeParse({
        ...response,
        error: { ...response.error, stack: "private stack" },
      }).success,
    ).toBe(false);
  });

  it("reports unavailable source navigation and Ask explicitly", () => {
    const capabilities = {
      apiVersions: [1],
      documentSchemaVersions: [1],
      nodeTypes: ["markdown", "code_peek"],
      limits: HOST_LIMITS,
      commands: ["document.mutate"],
      queries: ["document.get"],
      rendererVersion: "json-1",
      source: { read: false, navigation: false },
      ask: {
        available: false,
        supportedHarnesses: [],
        isolation: "trusted_local",
      },
    };
    expect(HostCapabilitiesSchema.parse(capabilities)).toEqual(capabilities);
    expect(
      HostCapabilitiesSchema.safeParse({
        ...capabilities,
        nodeTypes: ["ExecutableComponent"],
      }).success,
    ).toBe(false);
  });
});

describe("MCP schema generation", () => {
  it("generates usable mutation input validation without asking agents for host/client identity", () => {
    const tool = hostMcpTools().find(
      (item) => item.operation === "document.mutate",
    );
    if (!tool) throw new Error("Mutation tool is unavailable");
    const input = { commandId: mutation.commandId, ...mutation.input };
    const schema = z.fromJSONSchema(tool.inputSchema);
    expect(schema.parse(input)).toEqual(input);
    expect(schema.safeParse({ ...input, clientId: id }).success).toBe(false);
    expect(schema.safeParse(mutation.input).success).toBe(false);
    expect(tool.annotations.readOnlyHint).toBe(false);
  });

  it("uses the same read-only validation inputs for the query tool", () => {
    const tool = hostMcpTools().find(
      (item) => item.operation === "document.validate",
    );
    if (!tool) throw new Error("Validation tool is unavailable");
    expect(z.fromJSONSchema(tool.inputSchema).parse(mutation.input)).toEqual(
      mutation.input,
    );
    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(tool.name).toBe("review_document_validate");
  });

  it("names tools unambiguously and exports result schemas for both operation families", () => {
    const tools = hostMcpTools();
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
    expect(hostMcpToolName("review.get")).toBe("review_get");
    expect(hostMcpToolName("reviews.list")).toBe("review_reviews_list");
    const tool = tools.find((item) => item.operation === "document.mutate");
    if (!tool) throw new Error("Mutation tool is unavailable");
    expect(z.fromJSONSchema(tool.outputSchema).parse(commit)).toEqual(commit);
  });
});
