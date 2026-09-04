import { parseJsonText } from "@dev.fast/review-protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  prepareReviewDocument,
  resolveReviewDocumentPeeks,
} from "./review-document-hydrate";
import { testReviewSession } from "./review-session-test-utils";

type ResolveCodePeekRequest =
  (typeof import("./review-definition-runtime"))["resolveCodePeekRequest"];

const { resolveCodePeekRequest } = vi.hoisted(() => ({
  resolveCodePeekRequest: vi.fn<ResolveCodePeekRequest>(),
}));

// oxlint-disable-next-line anti-slop/no-module-mocking -- This focused test verifies pre-mount resolution and cache behavior at the exported resolver seam.
vi.mock("./review-definition-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./review-definition-runtime")>()),
  resolveCodePeekRequest,
}));

const resolution = {
  snapshot: { roots: [], resolved: {} },
};

beforeEach(() => {
  resolveCodePeekRequest.mockReset();
  resolveCodePeekRequest.mockResolvedValue(resolution);
});

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
  const data: ReviewDocumentData = {
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
  return { state: "ready" as const, contentHash, data };
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
});

describe("resolveReviewDocumentPeeks", () => {
  it("resolves every unique canonical peek once before returning", async () => {
    const session = testReviewSession();
    const document = hydrateReviewDocument(ready());

    await resolveReviewDocumentPeeks(document, session);

    expect(resolveCodePeekRequest).toHaveBeenCalledTimes(1);
    expect(resolveCodePeekRequest).toHaveBeenCalledWith(
      "/",
      {
        file: "src/orders.ts",
        fromLine: 3,
        toLine: 7,
      },
      session,
    );
    expect(document.anchors.get("create-order")?.peek?.resolution).toEqual(
      resolution,
    );
  });

  it("namespaces the content-hash promise cache by ReviewSession", async () => {
    const firstSession = testReviewSession({
      sessionId: "warm-session",
      sessionUrl: "http://127.0.0.1:5570/sessions/warm-session",
      routePath: "/warm",
    });
    const visibleSession = testReviewSession({
      sessionId: "warm-session",
      sessionUrl: "http://127.0.0.1:5570/sessions/warm-session",
      routePath: "/warm",
    });
    const isolatedSession = testReviewSession({
      sessionId: "isolated-session",
      sessionUrl: "http://127.0.0.1:5571/sessions/isolated-session",
      routePath: "/warm",
    });
    const load = ready();

    const first = await prepareReviewDocument(load, firstSession);
    expect(await prepareReviewDocument(load, visibleSession)).toBe(first);
    await prepareReviewDocument(load, isolatedSession);

    expect(resolveCodePeekRequest).toHaveBeenCalledTimes(2);
    expect(resolveCodePeekRequest.mock.calls.map((call) => call[2])).toEqual([
      firstSession,
      isolatedSession,
    ]);
  });

  it("evicts a rejected promise so a later load can retry", async () => {
    const session = testReviewSession();
    const load = ready(reviewDocumentData(), "retry-hash");
    resolveCodePeekRequest.mockRejectedValueOnce(new Error("peek unavailable"));

    await expect(prepareReviewDocument(load, session)).rejects.toThrow(
      "peek unavailable",
    );
    await expect(prepareReviewDocument(load, session)).resolves.toBeDefined();
    expect(resolveCodePeekRequest).toHaveBeenCalledTimes(2);
  });
});
