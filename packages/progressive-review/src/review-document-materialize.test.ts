import { describe, expect, it } from "vitest";

import { createReviewDefinitionSession } from "./authoring";
import {
  type ReviewDocumentModuleExports,
  collectDocumentSoftwareModels,
  collectReviewAnchors,
  materializeReviewDocument,
} from "./review-document-materialize";
import {
  FRAGMENT,
  type PublishAuditComponent,
  type ReviewDocumentPublishAudit,
  auditReviewDocumentComponent,
  createPublishValidationReact,
} from "./review-publish-element-audit";
import { defineSoftwareMap } from "./software-map-model";

const react = createPublishValidationReact();

function auditDocument(
  Component: PublishAuditComponent,
): ReviewDocumentPublishAudit {
  const audit = auditReviewDocumentComponent({
    Component,
    reportError: (message) => {
      throw new Error(message);
    },
  });
  if (!audit) throw new Error("Expected the document audit to succeed.");
  return audit;
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
  it("parses component props once across materialization and audit collectors", () => {
    let titleReads = 0;
    let callStackHeadReads = 0;
    let traceSessionReads = 0;
    let callStackCollections = 0;
    let traceCollections = 0;
    const Component: PublishAuditComponent = ({ components }) => {
      if (!components) throw new Error("Expected Review components.");
      return react.jsx(FRAGMENT, {
        children: [
          react.jsx(components.ReviewSection, {
            get title() {
              titleReads += 1;
              return "Part";
            },
            children: "Body",
          }),
          react.jsx(components.CallStackDiff, {
            base: [],
            get head() {
              callStackHeadReads += 1;
              return [anchor];
            },
          }),
          react.jsx(components.TraceQuote, {
            get sessionId() {
              traceSessionReads += 1;
              return "session-1";
            },
            children: "Quote",
          }),
        ],
      });
    };
    const audit = auditReviewDocumentComponent({
      Component,
      reportError: (message) => {
        throw new Error(message);
      },
      collectCallStackDiff: () => {
        callStackCollections += 1;
      },
      collectTraceQuote: () => {
        traceCollections += 1;
      },
    });
    if (!audit) throw new Error("Expected the document audit to succeed.");
    const readsAfterAudit = {
      title: titleReads,
      callStackHead: callStackHeadReads,
      traceSession: traceSessionReads,
    };

    expect(readsAfterAudit).toEqual({
      title: 1,
      callStackHead: 1,
      traceSession: 1,
    });
    expect(materializeReviewDocument(audit).errors).toEqual([]);
    expect({
      title: titleReads,
      callStackHead: callStackHeadReads,
      traceSession: traceSessionReads,
    }).toEqual(readsAfterAudit);
    expect(callStackCollections).toBe(1);
    expect(traceCollections).toBe(1);
  });

  it.each(["left", "center", "right"])(
    "preserves GFM table alignment %s as scalar data",
    (alignment) => {
      for (const tag of ["th", "td"]) {
        const result = materializeReviewDocument(
          auditDocument(() =>
            react.jsx(tag, {
              style: { textAlign: alignment },
              children: "Cell",
            }),
          ),
        );
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
    const result = materializeReviewDocument(
      auditDocument(() => react.jsx("td", { style })),
    );
    expect(result.errors).toEqual([
      '<td> prop "style" must be a string, number, or boolean.',
    ]);
  });

  it("turns prose, fragments, and nested registry elements into nodes", () => {
    const { body, errors } = materializeReviewDocument(
      auditDocument(({ components }) => {
        if (!components) throw new Error("Expected Review components.");
        return react.jsx(FRAGMENT, {
          children: [
            react.jsx("h1", {
              "data-review-block-index": 0,
              "data-review-block-tag": "h1",
              children: "Title",
            }),
            react.jsx(components.ReviewSection, {
              title: "Part",
              children: [
                react.jsx("h2", {
                  "data-review-block-index": 1,
                  "data-review-block-tag": "h2",
                  children: "Part",
                }),
                react.jsx(components.CodePeek, { anchor }),
              ],
            }),
          ],
        });
      }),
    );

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
    const { body, errors } = materializeReviewDocument(
      auditDocument(({ components }) => {
        if (!components) throw new Error("Expected Review components.");
        return react.jsx(components.DatabaseLens, {
          stores,
          children: react.jsx(components.DbUseCase, {
            id: "u",
            label: "U",
            children: react.jsx(components.DbWrite, {
              from: { __kind: "db-actor-ref", id: "svc", label: "S" },
              to: stores.db.tables.orders.status,
              label: "w",
              anchor,
            }),
          }),
        });
      }),
    );

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
      materializeReviewDocument(auditDocument(() => react.jsx(local, {})))
        .errors[0],
    ).toMatch(/Document-local components/);
    expect(
      materializeReviewDocument(
        auditDocument(() => react.jsx("p", { style: { color: "red" } })),
      ).errors[0],
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

describe("collectDocumentSoftwareModels", () => {
  it("finds nested models once, preferred names first, through cycles", () => {
    const first = defineSoftwareMap({ people: { a: { label: "A" } } });
    const second = defineSoftwareMap({ people: { b: { label: "B" } } });
    interface CyclicModelExports extends ReviewDocumentModuleExports {
      second: typeof second;
      self?: CyclicModelExports;
    }
    const cyclic: CyclicModelExports = { second };
    cyclic.self = cyclic;
    const models = { nested: cyclic, first, alsoFirst: first };

    expect(collectDocumentSoftwareModels(models, ["first"])).toEqual([
      first,
      second,
    ]);
  });
});
