import { describe, expect, it } from "vitest";

import {
  createReviewDefinitionSession,
  reviewAuthoringPropsSchemas,
} from "./authoring";
import {
  type ReviewDocumentModuleExports,
  collectReviewAnchors,
  materializeReviewDocument,
} from "./review-document-materialize";
import {
  type AuthoringComponentName,
  FRAGMENT,
  type PublishAuditComponent,
  type PublishAuditElementType,
  createPublishValidationReact,
} from "./review-publish-element-audit";

const react = createPublishValidationReact();
const componentNames = new Map<
  PublishAuditElementType,
  AuthoringComponentName
>();
const stubs = {} as Record<AuthoringComponentName, PublishAuditComponent>;
for (const name of Object.keys(
  reviewAuthoringPropsSchemas,
) as AuthoringComponentName[]) {
  const stub = () => null;
  stubs[name] = stub;
  componentNames.set(stub, name);
}

const anchor = {
  __kind: "db-anchor-ref",
  id: "a",
  title: "A",
  peek: {
    __kind: "code-peek-ref",
    props: { file: "x.ts", fromLine: 1, toLine: 2 },
    resolution: null,
  },
} as const;

describe("materializeReviewDocument", () => {
  it.each(["left", "center", "right"])(
    "preserves GFM table alignment %s as scalar data",
    (alignment) => {
      for (const tag of ["th", "td"]) {
        const result = materializeReviewDocument({
          tree: react.jsx(tag, {
            style: { textAlign: alignment },
            children: "Cell",
          }),
          componentNames,
        });
        expect(result).toEqual({
          body: [
            {
              type: "element",
              tag,
              props: { align: alignment },
              children: [{ type: "text", value: "Cell" }],
            },
          ],
          errors: [],
        });
      }
    },
  );

  it.each([
    { textAlign: "justify" },
    { textAlign: "left", color: "red" },
    { backgroundImage: "url(https://example.com/pixel)" },
  ])("does not admit arbitrary table styles: %j", (style) => {
    const result = materializeReviewDocument({
      tree: react.jsx("td", { style }),
      componentNames,
    });
    expect(result.errors).toEqual([
      '<td> prop "style" must be a string, number, or boolean.',
    ]);
  });

  it("turns prose, fragments, and nested registry elements into nodes", () => {
    const tree = react.jsx(FRAGMENT, {
      children: [
        react.jsx("h1", {
          "data-review-block-index": 0,
          "data-review-block-tag": "h1",
          children: "Title",
        }),
        react.jsx(stubs.ReviewSection, {
          title: "Part",
          children: [
            react.jsx("h2", {
              "data-review-block-index": 1,
              "data-review-block-tag": "h2",
              children: "Part",
            }),
            react.jsx(stubs.CodePeek, { anchor }),
          ],
        }),
      ],
    });

    const { body, errors } = materializeReviewDocument({
      tree,
      componentNames,
    });

    expect(errors).toEqual([]);
    expect(body[0]).toEqual({
      type: "element",
      tag: "h1",
      props: {
        "data-review-block-index": 0,
        "data-review-block-tag": "h1",
      },
      children: [{ type: "text", value: "Title" }],
    });
    expect(body[1]).toMatchObject({
      type: "component",
      name: "ReviewSection",
      props: { title: "Part" },
    });
    expect((body[1] as { children: unknown[] }).children[1]).toEqual({
      type: "component",
      name: "CodePeek",
      props: { anchor },
      children: [],
    });
    expect(JSON.parse(JSON.stringify(body))).toEqual(body);
  });

  it("normalizes DatabaseLens stores to data", () => {
    const session = createReviewDefinitionSession({
      softwareMap: null,
      baseSoftwareMap: null,
    });
    const stores = session.defineStores({
      db: {
        kind: "relational",
        label: "DB",
        tables: {
          orders: {
            label: "orders",
            schema: { status: { type: "text" } },
          },
        },
      },
    });
    const tree = react.jsx(stubs.DatabaseLens, {
      stores,
      children: react.jsx(stubs.DbUseCase, {
        id: "u",
        label: "U",
        children: react.jsx(stubs.DbWrite, {
          from: { __kind: "db-actor-ref", id: "svc", label: "S" },
          to: stores.db.tables.orders.status,
          label: "w",
          anchor,
        }),
      }),
    });

    const { body, errors } = materializeReviewDocument({
      tree,
      componentNames,
    });

    expect(errors).toEqual([]);
    expect(body[0]).toMatchObject({
      type: "component",
      name: "DatabaseLens",
      props: {
        stores: {
          db: {
            tables: {
              orders: {
                schema: { status: { type: "text" } },
                target: { collectionId: "orders" },
              },
            },
          },
        },
      },
    });
    expect(JSON.parse(JSON.stringify(body))).toEqual(body);
  });

  it("reports document-local components and non-literal prose props", () => {
    const local = () => null;

    expect(
      materializeReviewDocument({
        tree: react.jsx(local, {}),
        componentNames,
      }).errors[0],
    ).toMatch(/Document-local components/);
    expect(
      materializeReviewDocument({
        tree: react.jsx("p", { style: { color: "red" } }),
        componentNames,
      }).errors[0],
    ).toMatch(/style/);
  });
});

describe("collectReviewAnchors", () => {
  it("collects structural anchors and sequence content once through cycles", () => {
    const sequence = {
      __kind: "review-sequence-ref",
      messages: [{ anchor, code: { text: "const answer = 42;" } }],
    };
    interface CyclicReviewExports extends ReviewDocumentModuleExports {
      anchor: typeof anchor;
      sequence: typeof sequence;
      self?: CyclicReviewExports;
    }
    const cyclic: CyclicReviewExports = { anchor, sequence };
    cyclic.self = cyclic;

    expect(collectReviewAnchors({ cyclic })).toEqual({
      anchors: { a: anchor },
      anchorContents: { a: "const answer = 42;" },
    });
  });

  it("rejects duplicate sequence content and distinct anchors with one id", () => {
    expect(() =>
      collectReviewAnchors({
        first: {
          __kind: "review-sequence-ref",
          messages: [{ anchor, code: { text: "first" } }],
        },
        second: {
          __kind: "review-sequence-ref",
          messages: [{ anchor, code: { text: "second" } }],
        },
      }),
    ).toThrow('Review anchor id "a" has more than one authored content body.');
    expect(() =>
      collectReviewAnchors({ anchor, duplicate: { ...anchor } }),
    ).toThrow('Review anchor id "a" is defined more than once.');
  });
});
