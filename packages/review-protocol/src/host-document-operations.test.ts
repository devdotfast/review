import { describe, expect, it } from "vitest";

import {
  HostDocumentValidationError,
  affectedHostNodeIds,
  applyHostDocumentOperations,
  canonicalHostJson,
  validateHostDocument,
} from "./host-document-operations.js";
import type {
  HostDefinition,
  HostDocument,
  HostDocumentOperation,
} from "./host-document.js";

const empty = (): HostDocument => ({
  schemaVersion: 1,
  roots: [],
  nodes: {},
  definitions: {},
});
const anchor: HostDefinition = {
  kind: "anchor",
  title: "Handler",
  source: { side: "head", file: "src/handler.ts", fromLine: 1, toLine: 3 },
};
const insert = (
  id: string,
  afterId: string | null = null,
  parentId: string | null = null,
): HostDocumentOperation => ({
  op: "node.insert",
  node: { id, type: "markdown", markdown: id },
  placement: { parentId, afterId },
});

describe("atomic JSON document edits", () => {
  it("accepts a node before its anchor in the same transaction without mutating the input", () => {
    const current = empty();
    const result = applyHostDocumentOperations(current, [
      {
        op: "node.insert",
        node: { id: "peek", type: "code_peek", anchorId: "handler" },
        placement: { parentId: null, afterId: null },
      },
      { op: "definition.put", id: "handler", value: anchor },
    ]);
    expect(result.roots).toEqual(["peek"]);
    expect(result.definitions.handler).toEqual(anchor);
    expect(current).toEqual(empty());
  });

  it("rejects an incomplete transaction without leaking earlier operations", () => {
    const current = applyHostDocumentOperations(empty(), [insert("intro")]);
    const before = canonicalHostJson(current);
    expect(() =>
      applyHostDocumentOperations(current, [
        insert("next", "intro"),
        {
          op: "node.insert",
          node: { id: "peek", type: "code_peek", anchorId: "missing" },
          placement: { parentId: null, afterId: "next" },
        },
      ]),
    ).toThrow(HostDocumentValidationError);
    expect(canonicalHostJson(current)).toBe(before);
  });

  it("moves a node between containers without changing identity or unrelated content", () => {
    const document = applyHostDocumentOperations(empty(), [
      {
        op: "node.insert",
        node: {
          id: "section",
          type: "section",
          title: "Details",
          defaultCollapsed: true,
          children: [],
        },
        placement: { parentId: null, afterId: null },
      },
      insert("first", null, "section"),
      insert("second", "first", "section"),
      insert("outside", "section"),
    ]);
    const moved = applyHostDocumentOperations(document, [
      {
        op: "node.move",
        nodeId: "first",
        placement: { parentId: null, afterId: "outside" },
      },
    ]);
    expect(moved.roots).toEqual(["section", "outside", "first"]);
    expect(moved.nodes.section).toMatchObject({ children: ["second"] });
    expect(moved.nodes.first).toEqual(document.nodes.first);
    expect(document.nodes.section).toMatchObject({
      children: ["first", "second"],
    });
  });

  it("rejects moving a parent beneath its descendant, including a later removal", () => {
    const document: HostDocument = {
      ...empty(),
      roots: ["outer"],
      nodes: {
        outer: {
          id: "outer",
          type: "section",
          title: "Outer",
          defaultCollapsed: false,
          children: ["inner"],
        },
        inner: {
          id: "inner",
          type: "section",
          title: "Inner",
          defaultCollapsed: false,
          children: [],
        },
      },
    };
    const move: HostDocumentOperation = {
      op: "node.move",
      nodeId: "outer",
      placement: { parentId: "inner", afterId: null },
    };
    expect(() => applyHostDocumentOperations(document, [move])).toThrow(
      HostDocumentValidationError,
    );
    expect(() =>
      applyHostDocumentOperations(document, [
        move,
        { op: "node.remove", nodeId: "inner", subtree: true },
      ]),
    ).toThrow(HostDocumentValidationError);
  });

  it("requires explicit subtree removal and removes all descendants together", () => {
    const document: HostDocument = {
      ...empty(),
      roots: ["group"],
      nodes: {
        group: {
          id: "group",
          type: "callout",
          tone: "info",
          children: ["text"],
        },
        text: { id: "text", type: "markdown", markdown: "hello" },
      },
    };
    expect(() =>
      applyHostDocumentOperations(document, [
        { op: "node.remove", nodeId: "group", subtree: false },
      ]),
    ).toThrow("subtree");
    expect(
      applyHostDocumentOperations(document, [
        { op: "node.remove", nodeId: "group", subtree: true },
      ]),
    ).toEqual(empty());
  });

  it("does not let replacement silently move children or turn a leaf into a container", () => {
    const document = applyHostDocumentOperations(empty(), [insert("text")]);
    expect(() =>
      applyHostDocumentOperations(document, [
        {
          op: "node.replace",
          node: {
            id: "text",
            type: "section",
            title: "New",
            defaultCollapsed: false,
            children: [],
          },
        },
      ]),
    ).toThrow("container category");
  });

  it("checks definition removal against final consumers", () => {
    const document: HostDocument = {
      ...empty(),
      roots: ["peek"],
      nodes: { peek: { id: "peek", type: "code_peek", anchorId: "handler" } },
      definitions: { handler: anchor },
    };
    expect(() =>
      applyHostDocumentOperations(document, [
        { op: "definition.remove", id: "handler" },
      ]),
    ).toThrow("anchor definition handler");
    const result = applyHostDocumentOperations(document, [
      { op: "definition.remove", id: "handler" },
      { op: "node.remove", nodeId: "peek", subtree: false },
    ]);
    expect(result).toEqual(empty());
  });

  it("rejects conflicting writes and recycling retired identities", () => {
    expect(() =>
      applyHostDocumentOperations(empty(), [
        insert("node"),
        {
          op: "node.replace",
          node: { id: "node", type: "markdown", markdown: "different" },
        },
      ]),
    ).toThrow("Conflicting operations");
    expect(() =>
      applyHostDocumentOperations(empty(), [insert("node")], {
        nodeIds: new Set(["node"]),
      }),
    ).toThrow("retired");
    expect(() =>
      applyHostDocumentOperations(
        empty(),
        [{ op: "definition.put", id: "handler", value: anchor }],
        { definitionIds: new Set(["handler"]) },
      ),
    ).toThrow("retired");
  });
});

describe("document structure and reference integrity", () => {
  it("rejects duplicate placement, unreachable nodes and mismatched record keys", () => {
    const document: HostDocument = {
      ...empty(),
      roots: ["first", "first"],
      nodes: {
        first: { id: "first", type: "divider" },
        second: { id: "wrong", type: "divider" },
      },
    };
    const messages = validateHostDocument(document).map(
      (issue) => issue.message,
    );
    expect(messages.some((message) => message.includes("already placed"))).toBe(
      true,
    );
    expect(messages.some((message) => message.includes("record key"))).toBe(
      true,
    );
    expect(messages.some((message) => message.includes("not reachable"))).toBe(
      true,
    );
  });

  it("allows repeated diagram titles, actor labels and evidence anchors but not message IDs", () => {
    const message = (id: string) => ({
      id,
      fromActorId: "client",
      toActorId: "server",
      label: "Request",
      style: "call" as const,
      evidence: { kind: "anchor" as const, anchorId: "handler" },
    });
    const document: HostDocument = {
      ...empty(),
      roots: ["one", "two"],
      definitions: {
        handler: anchor,
        client: { kind: "actor", label: "Service" },
        server: { kind: "actor", label: "Service" },
      },
      nodes: {
        one: {
          id: "one",
          type: "sequence",
          title: "Flow",
          messages: [message("a"), message("b")],
        },
        two: {
          id: "two",
          type: "sequence",
          title: "Flow",
          messages: [message("a")],
        },
      },
    };
    expect(validateHostDocument(document)).toEqual([]);
    document.nodes.one = {
      id: "one",
      type: "sequence",
      title: "Flow",
      messages: [message("a"), message("a")],
    };
    expect(validateHostDocument(document)).toContainEqual(
      expect.objectContaining({
        path: "/nodes/one/messages/1/id",
        message: "Duplicate item ID a.",
      }),
    );
  });

  it("checks field references and includes transitive store consumers in invalidation", () => {
    const field = {
      label: "ID",
      dataType: "uuid",
      nullable: false,
      primaryKey: true,
    };
    const store: HostDefinition = {
      kind: "store",
      label: "DB",
      storage: "relational",
      collections: { users: { label: "Users", fields: { id: field } } },
    };
    const before: HostDocument = {
      ...empty(),
      roots: ["lens", "prose"],
      definitions: {
        db: store,
        actor: { kind: "actor", label: "API" },
        handler: anchor,
        reporting: {
          kind: "store",
          label: "Reporting",
          storage: "relational",
          collections: {
            copies: {
              label: "Copies",
              fields: {
                user: {
                  ...field,
                  references: {
                    storeId: "db",
                    collectionId: "users",
                    fieldId: "id",
                  },
                },
              },
            },
          },
        },
      },
      nodes: {
        lens: {
          id: "lens",
          type: "database_lens",
          title: "Reads",
          storeIds: ["reporting"],
          useCases: [
            {
              id: "read",
              label: "Read",
              operations: [
                {
                  id: "readUser",
                  kind: "read",
                  store: { storeId: "reporting", collectionId: "copies" },
                  actorId: "actor",
                  label: "Read",
                  anchorId: "handler",
                },
              ],
            },
          ],
        },
        prose: { id: "prose", type: "markdown", markdown: "Unrelated" },
      },
    };
    expect(validateHostDocument(before)).toEqual([]);
    const after = applyHostDocumentOperations(before, [
      {
        op: "definition.put",
        id: "db",
        value: { ...store, label: "Renamed DB" },
      },
    ]);
    expect(affectedHostNodeIds(before, after)).toEqual(["lens"]);
    const broken = {
      ...before,
      definitions: { ...before.definitions, db: { ...store, collections: {} } },
    };
    expect(
      validateHostDocument(broken).some((issue) =>
        issue.message.includes("Collection users"),
      ),
    ).toBe(true);
  });

  it("enforces the bound code side for stack frames", () => {
    const document: HostDocument = {
      ...empty(),
      roots: ["stack"],
      definitions: { handler: anchor },
      nodes: {
        stack: {
          id: "stack",
          type: "call_stack_diff",
          title: "Stack",
          base: [{ id: "frame", anchorId: "handler" }],
          head: [],
        },
      },
    };
    expect(validateHostDocument(document)).toContainEqual(
      expect.objectContaining({ path: "/nodes/stack/base/0/anchorId" }),
    );
  });
});

describe("canonical content encoding", () => {
  it("ignores object insertion order but preserves text and ordered children", () => {
    expect(canonicalHostJson({ b: ["first", "second"], a: "  exact\n" })).toBe(
      canonicalHostJson({ a: "  exact\n", b: ["first", "second"] }),
    );
    expect(canonicalHostJson(["a", "b"])).not.toBe(
      canonicalHostJson(["b", "a"]),
    );
    expect(canonicalHostJson(" exact ")).not.toBe(canonicalHostJson("exact"));
  });
  it("rejects non-finite numbers and sparse arrays", () => {
    for (const value of [NaN, Infinity, Array<string>(1)]) {
      expect(() => canonicalHostJson(value)).toThrow(TypeError);
    }
  });
});
