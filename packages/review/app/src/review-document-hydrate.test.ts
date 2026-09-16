import { parseJsonText } from "@dev.fast/review-protocol";
import { describe, expect, it } from "vitest";

import { createReviewDefinitionSession } from "../../src/authoring";
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
          id: "db:orders",
          actors: {},
          stores: {
            db: {
              label: "Orders DB",
              storage: "relational",
              collections: {
                orders: {
                  label: "orders",
                  fields: { status: { label: "status", dataType: "text" } },
                },
              },
            },
          },
          useCases: [],
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

  it("parses data and keeps component props as sealed", () => {
    const sealed = reviewDocumentData();
    const sealedJson = JSON.stringify(sealed);
    const document = hydrateReviewDocument(ready(sealed));
    const heading = document.body[0];
    const codePeek = document.body[1] as HydratedReviewComponentNode;
    const databaseLens = document.body[2] as HydratedReviewComponentNode;
    const anchor = document.anchors.get("create-order");

    if (heading.type !== "element") {
      throw new Error("Expected the first hydrated node to remain an element.");
    }

    expect(codePeek.props.anchor).toEqual(anchor);
    expect(heading.props).toEqual({ id: "orders-heading" });
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
    // Lens props are plain document data; hydration passes them through.
    const sealedLens = sealed.body[2];

    if (sealedLens?.type !== "component")
      throw new Error("Expected the sealed lens node.");
    expect(databaseLens.props).toEqual(sealedLens.props);
    expect(document.documentSoftwareModels[0]?.elementsByPath).toBeInstanceOf(
      Map,
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
