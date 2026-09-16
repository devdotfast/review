import { parseJsonText } from "@dev.fast/review-protocol";
import { describe, expect, it } from "vitest";

import {
  collectionSchema,
  createReviewDefinitionSession,
  databaseLensPropsSchema,
  storeRefData,
} from "../../src/authoring";
import type { ReviewDocumentData } from "../../src/review-document-data";
import { reviewDocumentDataSchema } from "../../src/review-document-data";
import {
  defineSoftwareMap,
  softwareModelData,
} from "../../src/software-map-model";
import { reviewTocEntries } from "./review-document-headings";
import {
  type HydratedReviewComponentNode,
  hydrateReviewDocument,
} from "./review-document-hydrate";

function reviewDocumentData(): ReviewDocumentData {
  const definition = createReviewDefinitionSession({
    softwareMap: null,
    baseSoftwareMap: null,
  });

  const stores = definition.defineStores({
    db: {
      kind: "relational",
      label: "Orders DB",
      tables: {
        orders: {
          label: "orders",
          schema: { status: { type: "text" } },
        },
      },
    },
  });

  const anchor = {
    __kind: "db-anchor-ref" as const,
    id: "create-order",
    title: "Create order",
    peek: { side: "head", file: "src/orders.ts", fromLine: 3, toLine: 7 },
  };

  const data = {
    format: "review-document/1",
    title: "Orders",
    routePath: "/",
    sourcePath: "review.mdx",
    anchors: { "create-order": anchor },
    anchorContents: { "create-order": "createOrder()" },
    softwareModels: [
      softwareModelData(
        defineSoftwareMap({ systems: { orders: { label: "Orders" } } }),
      ),
    ],
    body: [
      {
        type: "element",
        tag: "h1",
        props: {
          "data-review-block-index": 0,
          "data-review-table": 1,
          "data-review-row": 2,
          "data-review-column": 3,
          "data-review-block-tag": "h1",
          id: "orders-heading",
        },
        children: [{ type: "text", value: "Orders" }],
      },
      {
        type: "component",
        name: "CodePeek",
        props: { anchor },
        children: [],
      },
      {
        type: "component",
        name: "DatabaseLens",
        props: {
          stores: parseJsonText(
            JSON.stringify({ db: storeRefData(stores.db) }),
          ),
        },
        children: [],
      },
    ],
  };

  return reviewDocumentDataSchema.parse(JSON.parse(JSON.stringify(data)));
}

function ready(data = reviewDocumentData(), contentHash = "document-hash") {
  return {
    state: "ready" as const,
    contentHash,
    data: parseJsonText(JSON.stringify(data)),
  };
}

describe("hydrateReviewDocument", () => {
  it("includes synthesized section headings in navigation without changing saved data", () => {
    const data = reviewDocumentData();
    data.body = [
      {
        type: "component",
        name: "ReviewSection",
        props: { title: "Data flow" },
        children: [
          {
            type: "element",
            tag: "p",
            props: {},
            children: [{ type: "text", value: "The body stays intact." }],
          },
          {
            type: "element",
            tag: "h3",
            props: {},
            children: [{ type: "text", value: "Details" }],
          },
        ],
      },
      {
        type: "component",
        name: "ReviewSection",
        props: { title: "Data flow" },
        children: [
          {
            type: "element",
            tag: "h2",
            props: {},
            children: [{ type: "text", value: "Data flow" }],
          },
        ],
      },
    ];
    const saved = JSON.stringify(data);
    const hydrated = hydrateReviewDocument(ready(data));
    expect(reviewTocEntries(hydrated.body)).toEqual([
      { id: "data-flow", text: "Data flow", level: "h2" },
      { id: "details", text: "Details", level: "h3" },
      { id: "data-flow-2", text: "Data flow", level: "h2" },
    ]);
    const section = hydrated.body[0] as HydratedReviewComponentNode;
    expect(section.props.summary).toEqual({
      diagrams: 0,
      codeRefs: 0,
      paragraphs: 1,
    });
    expect(section.children).toHaveLength(3);
    expect(JSON.stringify(data)).toBe(saved);
  });

  it("parses data, canonicalizes anchors, and rebuilds runtime-only handles", () => {
    const sealed = reviewDocumentData();
    const sealedJson = JSON.stringify(sealed);
    const document = hydrateReviewDocument(ready(sealed));
    const heading = document.body[0];
    const codePeek = document.body[1] as HydratedReviewComponentNode;
    const databaseLens = document.body[2] as HydratedReviewComponentNode;
    const anchor = document.anchors.get("create-order");

    const stores = databaseLensPropsSchema.parse({
      ...databaseLens.props,
      children: [],
    }).stores;

    if (heading.type !== "element") {
      throw new Error("Expected the first hydrated node to remain an element.");
    }

    expect(codePeek.props.anchor).toBe(anchor);
    expect(heading.props).toEqual({
      "data-review-block-tag": "h1",
      id: "orders-heading",
    });
    expect(sealed.body[0]).toMatchObject({
      props: {
        "data-review-block-index": 0,
        "data-review-table": 1,
        "data-review-row": 2,
        "data-review-column": 3,
        "data-review-block-tag": "h1",
        id: "orders-heading",
      },
    });
    expect(JSON.stringify(sealed)).toBe(sealedJson);
    expect(collectionSchema(stores.db.tables!.orders)).toEqual({
      status: { type: "text" },
    });
    expect(document.documentSoftwareModels[0]?.elementsByPath).toBeInstanceOf(
      Map,
    );
  });

  it("rejects an inline anchor that has no canonical top-level definition", () => {
    const data = reviewDocumentData();
    data.anchors = {};

    expect(() => hydrateReviewDocument(ready(data))).toThrow(
      'Review document references missing anchor "create-order".',
    );
  });

  it("rejects a DatabaseLens store that is not a store ref", () => {
    const data = {
      format: "review-document/1",
      title: "Orders",
      routePath: "/",
      sourcePath: "review.mdx",
      anchors: {},
      anchorContents: {},
      softwareModels: [],
      body: [
        {
          type: "component",
          name: "DatabaseLens",
          props: { stores: { db: { kind: "relational" } } },
          children: [],
        },
      ],
    };

    expect(() =>
      hydrateReviewDocument({
        state: "ready",
        contentHash: "invalid-stores",
        data,
      }),
    ).toThrow(/stores/);
  });
});
