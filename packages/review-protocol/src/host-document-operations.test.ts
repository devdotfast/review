import { describe, expect, it } from "vitest";

import {
  HostDocumentValidationError,
  affectedHostNodeIds,
  applyHostDocumentOperations,
  assertHostDocument,
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
  placement: {
    parentId,
    position:
      afterId === null ? { kind: "start" } : { kind: "after", nodeId: afterId },
  },
});

describe("atomic JSON document edits", () => {
  it("identifies the offending placement without changing the saved document", () => {
    const current = empty();
    expect(() =>
      applyHostDocumentOperations(current, [
        insert("first"),
        insert("second", null, "missing"),
      ]),
    ).toThrow(
      expect.objectContaining({
        diagnostics: [
          expect.objectContaining({
            path: "/input/operations/1/placement/parentId",
          }),
        ],
      }),
    );
    expect(current).toEqual(empty());
  });

  it("accepts a node before its anchor in the same transaction without mutating the input", () => {
    const current = empty();
    const result = applyHostDocumentOperations(current, [
      {
        op: "node.insert",
        node: { id: "peek", type: "code_peek", anchorId: "handler" },
        placement: { parentId: null, position: { kind: "start" } },
      },
      { op: "definition.put", id: "handler", value: anchor },
    ]);
    expect(result.roots).toEqual(["peek"]);
    expect(result.definitions.handler).toEqual(anchor);
    expect(current).toEqual(empty());
  });

  it("keeps an invalid candidate isolated from the original document", () => {
    const current = applyHostDocumentOperations(empty(), [insert("intro")]);
    const before = canonicalHostJson(current);
    expect(() =>
      assertHostDocument(
        applyHostDocumentOperations(current, [
          insert("next", "intro"),
          {
            op: "node.insert",
            node: { id: "peek", type: "code_peek", anchorId: "missing" },
            placement: {
              parentId: null,
              position: { kind: "after", nodeId: "next" },
            },
          },
        ]),
      ),
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
        placement: { parentId: null, position: { kind: "start" } },
      },
      insert("first", null, "section"),
      insert("second", "first", "section"),
      insert("outside", "section"),
    ]);
    const moved = applyHostDocumentOperations(document, [
      {
        op: "node.move",
        nodeId: "first",
        placement: {
          parentId: null,
          position: { kind: "after", nodeId: "outside" },
        },
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
      placement: { parentId: "inner", position: { kind: "start" } },
    };
    expect(() => applyHostDocumentOperations(document, [move])).toThrow(
      HostDocumentValidationError,
    );
    expect(() =>
      applyHostDocumentOperations(document, [
        move,
        { op: "node.remove", nodeId: "inner", recursive: true },
      ]),
    ).toThrow(HostDocumentValidationError);
  });

  it("requires explicit recursive removal and removes all descendants together", () => {
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
        { op: "node.remove", nodeId: "group", recursive: false },
      ]),
    ).toThrow("recursive");
    expect(
      applyHostDocumentOperations(document, [
        { op: "node.remove", nodeId: "group", recursive: true },
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
      assertHostDocument(
        applyHostDocumentOperations(document, [
          { op: "definition.remove", id: "handler" },
        ]),
      ),
    ).toThrow("anchor definition handler");
    const result = applyHostDocumentOperations(document, [
      { op: "definition.remove", id: "handler" },
      { op: "node.remove", nodeId: "peek", recursive: false },
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

  it("renames a section and moves it to the end atomically, retaining its children", () => {
    const original: HostDocument = {
      ...empty(),
      roots: ["group", "tail"],
      nodes: {
        group: {
          id: "group",
          type: "section",
          title: "Old",
          defaultCollapsed: true,
          children: ["child"],
        },
        child: { id: "child", type: "markdown", markdown: "Retained" },
        tail: { id: "tail", type: "divider" },
      },
    };
    const result = applyHostDocumentOperations(original, [
      { op: "node.update", nodeId: "group", changes: { title: "New" } },
      {
        op: "node.move",
        nodeId: "group",
        placement: { parentId: null, position: { kind: "end" } },
      },
    ]);
    assertHostDocument(result);
    expect(result.roots).toEqual(["tail", "group"]);
    expect(result.nodes.group).toEqual({
      ...original.nodes.group,
      title: "New",
    });
    expect(result.nodes.child).toEqual(original.nodes.child);
    expect(original.nodes.group).toMatchObject({ title: "Old" });
  });

  it("can replace a container's presentation without resending its children", () => {
    const original: HostDocument = {
      ...empty(),
      roots: ["group"],
      nodes: {
        group: {
          id: "group",
          type: "section",
          title: "Old",
          defaultCollapsed: true,
          children: ["child"],
        },
        child: { id: "child", type: "markdown", markdown: "Keep" },
      },
    };
    const result = applyHostDocumentOperations(original, [
      {
        op: "node.replace",
        node: {
          id: "group",
          type: "callout",
          title: "Warning",
          tone: "warning",
        },
      },
    ]);
    assertHostDocument(result);
    expect(result.nodes.group).toEqual({
      id: "group",
      type: "callout",
      title: "Warning",
      tone: "warning",
      children: ["child"],
    });
  });

  it("keeps omitted defaults unchanged during updates and clears optional fields", () => {
    const original: HostDocument = {
      ...empty(),
      roots: ["code"],
      nodes: {
        code: {
          id: "code",
          type: "code",
          language: "typescript",
          text: "old",
          caption: "Caption",
        },
      },
    };
    const result = applyHostDocumentOperations(original, [
      {
        op: "node.update",
        nodeId: "code",
        changes: { text: "new", caption: null },
      },
    ]);
    expect(result.nodes.code).toEqual({
      id: "code",
      type: "code",
      language: "typescript",
      text: "new",
    });
    expect(() =>
      applyHostDocumentOperations(original, [
        {
          op: "node.update",
          nodeId: "code",
          changes: { title: "Wrong node kind" },
        },
      ]),
    ).toThrow(HostDocumentValidationError);
  });

  it("rejects recursive deletion overlapping a descendant edit in either order", () => {
    const original: HostDocument = {
      ...empty(),
      roots: ["group"],
      nodes: {
        group: {
          id: "group",
          type: "section",
          title: "Group",
          defaultCollapsed: false,
          children: ["child"],
        },
        child: { id: "child", type: "markdown", markdown: "Keep" },
      },
    };
    const edit: HostDocumentOperation = {
      op: "node.update",
      nodeId: "child",
      changes: { markdown: "Changed" },
    };
    const remove: HostDocumentOperation = {
      op: "node.remove",
      nodeId: "group",
      recursive: true,
    };
    for (const operations of [
      [edit, remove],
      [remove, edit],
    ]) {
      expect(() => applyHostDocumentOperations(original, operations)).toThrow(
        HostDocumentValidationError,
      );
      expect(original.nodes.child).toMatchObject({ markdown: "Keep" });
    }
  });

  it("normalizes authoring defaults and accepts explanatory sequence steps", () => {
    const result = applyHostDocumentOperations(empty(), [
      {
        op: "definition.put",
        id: "client",
        value: { kind: "actor", label: "Client" },
      },
      {
        op: "definition.put",
        id: "server",
        value: { kind: "actor", label: "Server" },
      },
      {
        op: "node.insert",
        node: {
          id: "sequence",
          type: "sequence",
          title: "Flow",
          messages: [
            {
              id: "request",
              fromActorId: "client",
              toActorId: "server",
              label: "Request",
              evidence: { kind: "explanation" },
            },
          ],
        },
        placement: { parentId: null, position: { kind: "end" } },
      },
      {
        op: "node.insert",
        node: { id: "code", type: "code", text: "Example" },
        placement: { parentId: null, position: { kind: "end" } },
      },
    ]);
    assertHostDocument(result);
    expect(result.nodes.sequence).toMatchObject({
      messages: [{ style: "call", evidence: { kind: "explanation" } }],
    });
    expect(result.nodes.code).toMatchObject({ language: "text" });
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
