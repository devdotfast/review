import { describe, expect, it } from "vitest";

import {
  PROSE_TAGS,
  REVIEW_DOCUMENT_FORMAT,
  reviewDocumentDataSchema,
  stripPeekResolutions,
  walkReviewNodes,
} from "./review-document-data";

const anchor = {
  __kind: "db-anchor-ref",
  id: "a",
  title: "A",
  peek: {
    __kind: "code-peek-ref",
    props: { file: "x.ts", fromLine: 1, toLine: 2 },
    resolution: null,
  },
};
const base = {
  format: REVIEW_DOCUMENT_FORMAT,
  title: "T",
  routePath: "/",
  sourcePath: "review.mdx",
  anchors: { a: anchor },
  anchorContents: {},
  softwareModels: [],
};

describe("review document data", () => {
  it("round-trips a document through JSON and the schema", () => {
    const document = {
      ...base,
      body: [
        {
          type: "element",
          tag: "h1",
          props: {
            "data-review-block-index": 0,
            "data-review-block-tag": "h1",
          },
          children: [{ type: "text", value: "T" }],
        },
        {
          type: "component",
          name: "CodePeek",
          props: { anchor },
          children: [],
        },
      ],
    };

    expect(
      reviewDocumentDataSchema.parse(JSON.parse(JSON.stringify(document))),
    ).toEqual(document);
  });

  it("accepts exactly the prose tag allowlist", () => {
    for (const tag of PROSE_TAGS) {
      expect(
        reviewDocumentDataSchema.safeParse({
          ...base,
          body: [{ type: "element", tag, props: {}, children: [] }],
        }).success,
      ).toBe(true);
    }
  });

  it("rejects an unknown component, a non-prose tag, a stray prop, and unsafe URLs", () => {
    for (const body of [
      [{ type: "component", name: "Nope", props: {}, children: [] }],
      [{ type: "element", tag: "script", props: {}, children: [] }],
      [{ type: "element", tag: "p", props: { onClick: "x" }, children: [] }],
      [
        {
          type: "element",
          tag: "a",
          props: { href: "javascript:alert(1)" },
          children: [],
        },
      ],
      [
        {
          type: "element",
          tag: "img",
          props: { src: "data:text/html,unsafe" },
          children: [],
        },
      ],
    ]) {
      expect(
        reviewDocumentDataSchema.safeParse({ ...base, body }).success,
      ).toBe(false);
    }
  });

  it("rejects DatabaseLens stores that lost their collection schema or target", () => {
    for (const collection of [
      {},
      {
        target: {
          __kind: "db-target-ref",
          storeId: "db",
          storeKind: "relational",
          storeLabel: "DB",
          collectionKind: "tables",
          collectionId: "orders",
          collectionLabel: "orders",
          path: [],
        },
      },
      { schema: { id: { type: "text" } } },
    ]) {
      const body = [
        {
          type: "component",
          name: "DatabaseLens",
          props: {
            stores: {
              db: {
                __kind: "db-store-ref",
                id: "db",
                kind: "relational",
                label: "DB",
                tables: { orders: collection },
              },
            },
          },
          children: [],
        },
      ];

      expect(
        reviewDocumentDataSchema.safeParse({ ...base, body }).success,
      ).toBe(false);
    }
  });

  it("rejects anchors whose peek resolution was not stripped", () => {
    const resolvedAnchor = {
      ...anchor,
      peek: { ...anchor.peek, resolution: { snapshot: {} } },
    };

    expect(
      reviewDocumentDataSchema.safeParse({
        ...base,
        body: [],
        anchors: { a: resolvedAnchor },
      }).success,
    ).toBe(false);
  });

  it("strips peek resolutions deeply without mutating the input", () => {
    const peek = Object.freeze({
      __kind: "code-peek-ref",
      props: { file: "x.ts", fromLine: 1, toLine: 1 },
      resolution: { snapshot: {} },
    });
    const input = { list: [{ anchor: { peek } }] };
    const stripped = stripPeekResolutions(input);

    expect(stripped.list[0]?.anchor.peek.resolution).toBeNull();
    expect(input.list[0]?.anchor.peek.resolution).not.toBeNull();
  });

  it("walks components with their parent", () => {
    const seen: string[] = [];
    walkReviewNodes(
      [
        {
          type: "component",
          name: "DatabaseLens",
          props: {},
          children: [
            {
              type: "component",
              name: "DbUseCase",
              props: {},
              children: [],
            },
          ],
        },
      ],
      (node, parent) => {
        if (node.type === "component") {
          seen.push(`${parent?.name ?? "root"}>${node.name}`);
        }
      },
    );

    expect(seen).toEqual(["root>DatabaseLens", "DatabaseLens>DbUseCase"]);
  });
});
