import { describe, expect, it } from "vitest";

import { createWhiteboardDefinitionSession } from "./authoring";
import { selectSource } from "./lens-selection";
import { defineSoftwareMap } from "./software-map-model";
import {
  type WhiteboardDocumentModuleExports,
  collectDocumentSoftwareModels,
  collectWhiteboardAnchors,
  materializeWhiteboardDocument,
} from "./whiteboard-document-materialize";
import {
  FRAGMENT,
  type PublishAuditComponent,
  type WhiteboardDocumentPublishAudit,
  auditWhiteboardDocumentComponent,
  createPublishValidationReact,
} from "./whiteboard-publish-element-audit";

const react = createPublishValidationReact();

function auditDocument(
  Component: PublishAuditComponent,
): WhiteboardDocumentPublishAudit {
  const audit = auditWhiteboardDocumentComponent({
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
  peek: selectSource({ side: "head", file: "x.ts", fromLine: 1, toLine: 2 }),
} as const;

describe("materializeWhiteboardDocument", () => {
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
          react.jsx(components.WhiteboardSection, {
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

    const audit = auditWhiteboardDocumentComponent({
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
    expect(materializeWhiteboardDocument(audit).errors).toEqual([]);
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
        const result = materializeWhiteboardDocument(
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
    const result = materializeWhiteboardDocument(
      auditDocument(() => react.jsx("td", { style })),
    );

    expect(result.errors).toEqual([
      '<td> prop "style" must be a string, number, or boolean.',
    ]);
  });

  it("turns prose, fragments, and nested registry elements into nodes", () => {
    const { body, errors } = materializeWhiteboardDocument(
      auditDocument(({ components }) => {
        if (!components) throw new Error("Expected Review components.");

        return react.jsx(FRAGMENT, {
          children: [
            react.jsx("h1", { children: "Title" }),
            react.jsx(components.WhiteboardSection, {
              title: "Part",
              children: [
                react.jsx("h2", { children: "Part" }),
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
      props: {},
      children: [{ type: "text", value: "Title" }],
    });
    expect(body[1]).toMatchObject({
      type: "component",
      name: "WhiteboardSection",
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

  it("lowers a DatabaseLens and its use cases to the canonical block", () => {
    const session = createWhiteboardDefinitionSession({
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

    const { body, errors } = materializeWhiteboardDocument(
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
        id: "db:database",
        stores: {
          db: {
            storage: "relational",
            collections: {
              orders: { fields: { status: { dataType: "text" } } },
            },
          },
        },
        useCases: [
          {
            id: "u",
            label: "U",
            operations: [
              {
                kind: "write",
                store: "db",
                collection: "orders",
                field: "status",
                actor: "svc",
                label: "w",
              },
            ],
          },
        ],
      },
      children: [],
    });
    expect(JSON.parse(JSON.stringify(body))).toEqual(body);
  });

  it("reports document-local components and non-literal prose props", () => {
    const local = () => null;

    expect(
      materializeWhiteboardDocument(auditDocument(() => react.jsx(local, {})))
        .errors[0],
    ).toMatch(/Document-local components/);
    expect(
      materializeWhiteboardDocument(
        auditDocument(() => react.jsx("p", { style: { color: "red" } })),
      ).errors[0],
    ).toMatch(/style/);
  });
});

describe("collectWhiteboardAnchors", () => {
  it("collects structural anchors and sequence content once through cycles", () => {
    const sequence = {
      __kind: "review-sequence-ref",
      messages: [{ anchor, code: { text: "const answer = 42;" } }],
    };

    interface CyclicWhiteboardExports extends WhiteboardDocumentModuleExports {
      anchor: typeof anchor;
      sequence: typeof sequence;
      self?: CyclicWhiteboardExports;
    }

    const cyclic: CyclicWhiteboardExports = { anchor, sequence };
    cyclic.self = cyclic;

    expect(collectWhiteboardAnchors({ cyclic })).toEqual({
      anchors: { a: anchor },
      anchorContents: { a: "const answer = 42;" },
    });
  });

  it("rejects duplicate sequence content and distinct anchors with one id", () => {
    expect(() =>
      collectWhiteboardAnchors({
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
      collectWhiteboardAnchors({ anchor, duplicate: { ...anchor } }),
    ).toThrow('Review anchor id "a" is defined more than once.');
  });
});

describe("collectDocumentSoftwareModels", () => {
  it("finds nested models once, preferred names first, through cycles", () => {
    const first = defineSoftwareMap({ people: { a: { label: "A" } } });
    const second = defineSoftwareMap({ people: { b: { label: "B" } } });

    interface CyclicModelExports extends WhiteboardDocumentModuleExports {
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
