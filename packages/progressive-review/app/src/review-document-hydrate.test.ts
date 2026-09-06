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
    peek: {
      __kind: "code-peek-ref" as const,
      props: { file: "src/orders.ts", fromLine: 3, toLine: 7 },
      resolution: null,
    },
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
  it("parses data, canonicalizes anchors, and rebuilds runtime-only handles", () => {
    const document = hydrateReviewDocument(ready());
    const codePeek = document.body[0] as HydratedReviewComponentNode;
    const databaseLens = document.body[1] as HydratedReviewComponentNode;
    const anchor = document.anchors.get("create-order");
    const stores = databaseLensPropsSchema.parse({
      ...databaseLens.props,
      children: [],
    }).stores;

    expect(codePeek.props.anchor).toBe(anchor);
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
