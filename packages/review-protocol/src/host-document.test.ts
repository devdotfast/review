import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  HostAddressSchema,
  HostCheckpointSchema,
  HostPrincipalSchema,
  HostRepositorySchema,
  HostReviewSchema,
} from "./host-api.js";
import {
  HOST_LIMITS,
  HostBindingSchema,
  type HostDefinition,
  HostDefinitionSchema,
  HostDiagnosticSchema,
  type HostDocument,
  HostDocumentManifestSchema,
  HostDocumentOperationSchema,
  HostDocumentSchema,
  HostDocumentStateSchema,
  HostKeySchema,
  HostLinkSchema,
  HostMapSchema,
  HostMapVersionSchema,
  type HostNode,
  HostNodeSchema,
  HostRelativePathSchema,
  HostSourceQuoteSchema,
  HostSourceRangeSchema,
  HostVersionSchema,
} from "./host-document.js";

const uuid = "587c44e4-72f2-4f17-9d43-c1087f905208";
const otherUuid = "2a87bc42-a557-46ad-9c63-caa16d082651";
const commit = "a".repeat(40);
const hash = "b".repeat(64);
const createdAt = "2026-09-10T12:00:00Z";
const source = {
  side: "head",
  file: "src/database.ts",
  fromLine: 10,
  toLine: 12,
} satisfies z.infer<typeof HostSourceRangeSchema>;
const span = {
  repositoryId: uuid,
  commit,
  blob: "c".repeat(40),
  file: source.file,
  fromLine: 10,
  toLine: 12,
};
const binding = {
  id: uuid,
  repositoryId: otherUuid,
  selector: { kind: "range", baseRef: "main", headRef: "feature/review" },
  baseCommit: commit,
  headCommit: "d".repeat(40),
  createdAt,
} satisfies z.infer<typeof HostBindingSchema>;

const definitions = {
  database: { kind: "anchor", title: "Database", source },
  agent: { kind: "actor", label: "Agent" },
  desktop: {
    kind: "actor",
    label: "Desktop",
    mapElement: { mapVersionId: uuid, elementId: "server" },
  },
  storage: {
    kind: "store",
    label: "Shared storage",
    storage: "relational",
    collections: {
      reviews: {
        label: "Reviews",
        fields: {
          id: {
            label: "ID",
            dataType: "uuid",
            nullable: false,
            primaryKey: true,
          },
          parentId: {
            label: "Parent",
            dataType: "uuid",
            nullable: true,
            primaryKey: false,
            references: {
              storeId: "storage",
              collectionId: "reviews",
              fieldId: "id",
            },
          },
        },
      },
    },
  },
} satisfies Record<string, HostDefinition>;

const nodes = [
  {
    id: "prose",
    type: "markdown",
    markdown:
      "# Review\n\n- Read the code\n\n| A | B |\n|---|---|\n| one | two |",
  },
  {
    id: "paragraph",
    type: "paragraph",
    content: [
      { type: "text", text: "See ", marks: ["strong", "emphasis"] },
      { type: "anchor_link", anchorId: "database", text: "database" },
      { type: "break" },
      { type: "code", text: "openDatabase()" },
      { type: "link", href: "https://example.com/review", text: "Reference" },
    ],
  },
  {
    id: "heading",
    type: "heading",
    level: 2,
    content: [{ type: "text", text: "Storage" }],
  },
  {
    id: "code",
    type: "code",
    language: "typescript",
    text: "const id = 'review';",
    caption: "Illustration",
  },
  { id: "divider", type: "divider" },
  {
    id: "section",
    type: "section",
    title: "Details",
    defaultCollapsed: true,
    children: [],
  },
  {
    id: "callout",
    type: "callout",
    tone: "warning",
    title: "Watch writes",
    children: [],
  },
  {
    id: "peek",
    type: "code_peek",
    anchorId: "database",
    caption: "Pinned source",
  },
  {
    id: "sequence",
    type: "sequence",
    title: "Authoring",
    messages: [
      {
        id: "request",
        fromActorId: "agent",
        toActorId: "desktop",
        label: "Mutate",
        evidence: { kind: "anchor", anchorId: "database" },
        style: "call",
      },
      {
        id: "response",
        fromActorId: "desktop",
        toActorId: "agent",
        label: "Commit",
        evidence: { kind: "illustrative_code", language: "json", text: "{}" },
        style: "return",
      },
    ],
  },
  {
    id: "stack",
    type: "call_stack_diff",
    title: "Write flow",
    base: [{ id: "write", anchorId: "database" }],
    head: [
      {
        id: "write",
        anchorId: "database",
        via: { kind: "rpc", reason: "Desktop owns storage" },
      },
    ],
  },
  {
    id: "database",
    type: "database_lens",
    title: "Storage",
    storeIds: ["storage"],
    useCases: [
      {
        id: "author",
        label: "Authoring",
        operations: [
          {
            id: "read",
            kind: "read",
            store: { storeId: "storage", collectionId: "reviews" },
            actorId: "desktop",
            label: "Read",
            anchorId: "database",
          },
          {
            id: "write",
            kind: "write",
            store: {
              storeId: "storage",
              collectionId: "reviews",
              fieldId: "id",
            },
            actorId: "desktop",
            label: "Save",
            anchorId: "database",
          },
        ],
      },
    ],
  },
  {
    id: "trace",
    type: "trace_quote",
    traceId: uuid,
    eventId: otherUuid,
    text: "Preserve the original target.",
  },
  {
    id: "image",
    type: "image",
    assetId: uuid,
    alt: "Architecture diagram",
    caption: "Uploaded image",
  },
  {
    id: "map",
    type: "software_map",
    mapVersionId: uuid,
    focusElementId: "server",
  },
] satisfies HostNode[];

function document(): HostDocument {
  return {
    schemaVersion: 1,
    roots: nodes.map((node) => node.id),
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    definitions,
  };
}

describe("JSON document authoring contracts", () => {
  it.each(nodes)(
    "accepts a structured $type node without authored code execution",
    (node) => {
      expect(HostNodeSchema.parse(node)).toEqual(node);
    },
  );

  it("accepts shared definitions and a complete immutable document state", () => {
    for (const definition of Object.values(definitions)) {
      expect(HostDefinitionSchema.parse(definition)).toEqual(definition);
    }
    const state = {
      ...document(),
      documentId: uuid,
      reviewId: otherUuid,
      version: 5,
      binding,
      contentHash: hash,
      createdAt,
      evidence: {
        database: {
          span,
          text: "line one\nline two\nline three",
          sha256: hash,
        },
      },
    };
    expect(HostDocumentStateSchema.parse(state)).toEqual(state);
  });

  it.each([
    {
      op: "node.insert",
      node: { id: "new", type: "divider" },
      placement: { parentId: null, afterId: null },
    },
    {
      op: "node.replace",
      node: { id: "prose", type: "markdown", markdown: "Updated" },
    },
    {
      op: "node.move",
      nodeId: "prose",
      placement: { parentId: "section", afterId: null },
    },
    { op: "node.remove", nodeId: "section", subtree: true },
    { op: "definition.put", id: "database", value: definitions.database },
    { op: "definition.remove", id: "database" },
  ])("parses $op without accepting extra transport fields", (operation) => {
    expect(HostDocumentOperationSchema.parse(operation)).toEqual(operation);
    expect(
      HostDocumentOperationSchema.safeParse({
        ...operation,
        execute: "process.exit()",
      }).success,
    ).toBe(false);
  });

  it.each([
    { id: "unknown", type: "CustomComponent", source: "<script />" },
    { id: "old", type: "markdown", markdown: "Text", source: "<CodePeek />" },
    {
      id: "image",
      type: "image",
      assetId: uuid,
      alt: "Image",
      url: "file:///etc/passwd",
    },
    { id: "heading", type: "heading", level: 7, content: [] },
    { id: "peek", type: "code_peek", anchorId: "database", caption: null },
    {
      id: "unsafe",
      type: "paragraph",
      content: [{ type: "text", text: "Hello", onClick: "run()" }],
    },
    {
      id: "database",
      type: "database_lens",
      title: "Store",
      storeIds: [],
      useCases: [
        {
          id: "case",
          label: "Read",
          operations: [{ id: "read", kind: "delete" }],
        },
      ],
    },
  ])("rejects unsupported or open-ended node payloads: %#", (node) => {
    expect(HostNodeSchema.safeParse(node).success).toBe(false);
  });

  it("rejects fields at the document, definition and source-evidence boundaries", () => {
    expect(
      HostDocumentSchema.safeParse({ ...document(), path: "/tmp/review.mdx" })
        .success,
    ).toBe(false);
    expect(
      HostDefinitionSchema.safeParse({
        ...definitions.agent,
        session: "private-session",
      }).success,
    ).toBe(false);
    expect(
      HostSourceQuoteSchema.safeParse({
        span: { ...span, absolutePath: "/private/src.ts" },
        text: "code",
        sha256: hash,
      }).success,
    ).toBe(false);
    expect(
      HostDocumentSchema.safeParse({ ...document(), schemaVersion: 2 }).success,
    ).toBe(false);
  });

  it.each(["constructor", "prototype", "__proto__"])(
    "rejects hostile key %s before a record can discard it",
    (key) => {
      expect(HostKeySchema.safeParse(key).success).toBe(false);
      expect(
        HostDocumentSchema.safeParse({
          ...document(),
          nodes: { [key]: { id: key, type: "divider" } },
        }).success,
      ).toBe(false);
      expect(
        HostDocumentSchema.safeParse({
          ...document(),
          definitions: { [key]: definitions.agent },
        }).success,
      ).toBe(false);
      expect(
        HostDefinitionSchema.safeParse({
          ...definitions.storage,
          collections: { [key]: definitions.storage.collections.reviews },
        }).success,
      ).toBe(false);
      expect(
        HostDefinitionSchema.safeParse({
          ...definitions.storage,
          collections: {
            reviews: {
              label: "Reviews",
              fields: {
                [key]: definitions.storage.collections.reviews.fields.id,
              },
            },
          },
        }).success,
      ).toBe(false);
    },
  );

  it("rejects __proto__ in a parsed JSON payload instead of silently stripping it", () => {
    const payload = JSON.parse(
      '{"schemaVersion":1,"roots":[],"nodes":{"__proto__":{"type":"divider","id":"sneaky"}},"definitions":{}}',
    );
    expect(HostDocumentSchema.safeParse(payload).success).toBe(false);
  });

  it("rejects node counts and field lengths above advertised limits", () => {
    const oversized = Object.fromEntries(
      Array.from({ length: HOST_LIMITS.nodes + 1 }, (_, index) => [
        `n${index}`,
        { id: `n${index}`, type: "divider" },
      ]),
    );
    expect(
      HostDocumentSchema.safeParse({ ...document(), nodes: oversized }).success,
    ).toBe(false);
    expect(
      HostNodeSchema.safeParse({
        id: "large",
        type: "markdown",
        markdown: "x".repeat(HOST_LIMITS.nodeBytes + 1),
      }).success,
    ).toBe(false);
    expect(
      HostDocumentSchema.safeParse({
        ...document(),
        roots: Array.from({ length: HOST_LIMITS.nodes + 1 }, () => "prose"),
      }).success,
    ).toBe(false);
  });

  it.each([
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    "1",
  ])("rejects invalid revision %s without coercion", (version) => {
    expect(HostVersionSchema.safeParse(version).success).toBe(false);
  });
});

describe("portable source references", () => {
  it.each(["src/index.ts", "packages/review/my file.ts", "src/évidence.ts"])(
    "accepts normalized relative path %s",
    (file) => {
      expect(HostRelativePathSchema.parse(file)).toBe(file);
    },
  );

  it.each([
    "",
    ".",
    "..",
    "../secret",
    "src/../secret",
    "src/./file",
    "src//file",
    "src/",
    "/etc/passwd",
    "C:/secret",
    "src\\file.ts",
    "file:///secret",
    "src/\u0000file",
    "src/\nfile",
  ])("rejects unsafe or non-normalized path %j", (file) => {
    expect(HostRelativePathSchema.safeParse(file).success).toBe(false);
  });

  it.each([
    { fromLine: 0, toLine: 1 },
    { fromLine: 10, toLine: 9 },
    { fromLine: 1.5, toLine: 2 },
    { fromLine: 1, toLine: HOST_LIMITS.codeLines + 1 },
    { fromLine: "1", toLine: 2 },
  ])("rejects invalid inclusive line range %#", (range) => {
    expect(
      HostSourceRangeSchema.safeParse({ ...source, ...range }).success,
    ).toBe(false);
    expect(
      HostSourceQuoteSchema.safeParse({
        span: { ...span, ...range },
        text: "code",
        sha256: hash,
      }).success,
    ).toBe(false);
  });

  it("accepts a one-line range and the exact maximum span", () => {
    expect(
      HostSourceRangeSchema.parse({ ...source, fromLine: 10, toLine: 10 })
        .toLine,
    ).toBe(10);
    expect(
      HostSourceRangeSchema.parse({
        ...source,
        fromLine: 10,
        toLine: 10 + HOST_LIMITS.codeLines - 1,
      }).fromLine,
    ).toBe(10);
  });

  it.each([
    "https://example.com/a",
    "http://localhost:1234/path",
    "mailto:review@example.com",
  ])("allows explicit link protocol %s", (href) => {
    expect(HostLinkSchema.parse(href)).toBe(href);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,hi",
    "file:///tmp/review",
    "vscode://file/tmp/review",
    "//example.com/a",
    "https:example.com",
    "https://example.com/\nsecret",
  ])("rejects unsafe link %j", (href) => {
    expect(HostLinkSchema.safeParse(href).success).toBe(false);
  });

  it("requires immutable object IDs and UTC timestamps in bindings", () => {
    expect(HostBindingSchema.parse(binding)).toEqual(binding);
    expect(
      HostBindingSchema.safeParse({ ...binding, headCommit: "main" }).success,
    ).toBe(false);
    expect(
      HostBindingSchema.safeParse({ ...binding, headCommit: "a".repeat(41) })
        .success,
    ).toBe(false);
    expect(
      HostBindingSchema.safeParse({
        ...binding,
        createdAt: "2026-09-10T12:00:00-04:00",
      }).success,
    ).toBe(false);
  });
});

describe("versioned map contracts", () => {
  const map = {
    schemaVersion: 1,
    elements: {
      agent: {
        id: "agent",
        parentId: null,
        label: "Agent",
        description: "Authors reviews",
        kind: "person",
        source: [],
      },
      server: {
        id: "server",
        parentId: null,
        label: "Desktop",
        description: "Owns review state",
        kind: "container",
        source: [span],
      },
    },
    relationships: {
      call: {
        id: "call",
        fromId: "agent",
        toId: "server",
        kind: "call",
        label: "Mutate",
        evidence: span,
      },
      semantic: {
        id: "semantic",
        fromId: "agent",
        toId: "server",
        kind: "semantic",
        label: "Authoring",
        explanation: "Host executes commands",
      },
    },
  } satisfies z.infer<typeof HostMapSchema>;

  it("accepts a map with explicit item identities and retained commit binding", () => {
    const version = {
      ...map,
      id: uuid,
      mapId: otherUuid,
      repositoryId: uuid,
      commit,
      revision: 1,
      contentHash: hash,
      createdAt,
    };
    expect(HostMapVersionSchema.parse(version)).toEqual(version);
  });

  it("rejects unknown map fields and unverified call relationships", () => {
    expect(
      HostMapSchema.safeParse({ ...map, executable: "data.ts" }).success,
    ).toBe(false);
    expect(
      HostMapSchema.safeParse({
        ...map,
        relationships: {
          call: {
            id: "call",
            fromId: "agent",
            toId: "server",
            kind: "call",
            label: "Mutate",
          },
        },
      }).success,
    ).toBe(false);
    expect(
      HostMapSchema.safeParse({
        ...map,
        elements: { constructor: map.elements.server },
      }).success,
    ).toBe(false);
  });
});

describe("machine-readable schema export", () => {
  it("exports bounded dictionaries and restrictive keys for input and output contracts", () => {
    for (const io of ["input", "output"] satisfies ("input" | "output")[]) {
      const exported = z.toJSONSchema(HostDocumentSchema, { io });
      const dictionary = z
        .object({
          maxProperties: z.number(),
          propertyNames: z.object({ pattern: z.string() }),
          additionalProperties: z
            .object({ oneOf: z.array(z.unknown()) })
            .or(z.object({ anyOf: z.array(z.unknown()) })),
        })
        .parse(exported.properties?.nodes);
      expect(dictionary.maxProperties).toBe(HOST_LIMITS.nodes);
      const allowedKey = new RegExp(dictionary.propertyNames.pattern);
      expect(allowedKey.test("newNode")).toBe(true);
      expect(allowedKey.test("constructor")).toBe(false);
      expect(allowedKey.test("prototype")).toBe(false);
      expect(allowedKey.test("__proto__")).toBe(false);
    }
  });

  it("exports all document/map/state shapes without unrepresentable authored functions", () => {
    expect(() =>
      z.toJSONSchema(HostDocumentStateSchema, { io: "input" }),
    ).not.toThrow();
    expect(() =>
      z.toJSONSchema(HostDocumentOperationSchema, { io: "input" }),
    ).not.toThrow();
    expect(() =>
      z.toJSONSchema(HostMapVersionSchema, { io: "input" }),
    ).not.toThrow();
  });

  it("accepts properly escaped JSON pointers in diagnostics", () => {
    expect(
      HostDiagnosticSchema.parse({
        severity: "error",
        code: "MISSING_REFERENCE",
        message: "Missing anchor",
        path: "/definitions/a~1b~0c",
      }).path,
    ).toBe("/definitions/a~1b~0c");
    expect(
      HostDiagnosticSchema.safeParse({
        severity: "error",
        code: "BAD",
        message: "Bad pointer",
        path: "/nodes/a~2b",
      }).success,
    ).toBe(false);
  });
});

describe("host metadata contracts", () => {
  it("keeps repository locations and remotes outside the public identity", () => {
    const repository = { id: uuid, vcs: "git", displayName: "Review" };
    expect(HostRepositorySchema.parse(repository)).toEqual(repository);
    expect(
      HostRepositorySchema.safeParse({
        ...repository,
        locations: [{ displayPath: "/private/repo" }],
      }).success,
    ).toBe(false);
    expect(
      HostRepositorySchema.safeParse({
        ...repository,
        remotes: [{ url: "https://secret@example.com/repo" }],
      }).success,
    ).toBe(false);
  });

  it("addresses reviews through registered host/workspace identities, not arbitrary URLs", () => {
    const address = { hostId: uuid, workspaceId: otherUuid, reviewId: uuid };
    expect(HostAddressSchema.parse(address)).toEqual(address);
    expect(
      HostAddressSchema.safeParse({
        ...address,
        hostId: "https://untrusted.example",
      }).success,
    ).toBe(false);
    expect(
      HostPrincipalSchema.parse({
        id: uuid,
        kind: "agent",
        displayName: "Review assistant",
      }).kind,
    ).toBe("agent");
  });

  it("represents reviews and immutable checkpoints without an author session", () => {
    const review = {
      id: uuid,
      repositoryId: otherUuid,
      version: 1,
      title: "Review",
      description: "Local review",
      labels: [],
      workflow: "draft",
      documentId: otherUuid,
      documentVersion: 0,
      publishedCheckpointId: null,
      authorSessionId: null,
      createdBy: uuid,
      createdAt,
      updatedAt: createdAt,
      deletedAt: null,
    };
    expect(HostReviewSchema.parse(review)).toEqual(review);
    const checkpoint = {
      id: uuid,
      reviewId: uuid,
      ordinal: 1,
      documentVersion: 1,
      bindingId: otherUuid,
      title: "Published review",
      description: "Frozen metadata",
      mapVersions: { base: null, head: null },
      authorSessionId: null,
      createdBy: uuid,
      createdAt,
    };
    expect(HostCheckpointSchema.parse(checkpoint)).toEqual(checkpoint);
  });

  it("stores manifest hashes without treating embedded mutable node values as references", () => {
    const manifest = {
      schemaVersion: 1,
      roots: ["peek"],
      nodes: { peek: hash },
      definitions: { database: hash },
      evidence: { database: hash },
    };
    expect(HostDocumentManifestSchema.parse(manifest)).toEqual(manifest);
    expect(
      HostDocumentManifestSchema.safeParse({
        ...manifest,
        nodes: {
          peek: { id: "peek", type: "code_peek", anchorId: "database" },
        },
      }).success,
    ).toBe(false);
  });
});
