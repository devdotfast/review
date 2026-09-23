import { describe, expect, it } from "vitest";

import { selectSource } from "./lens-selection";
import {
  PROSE_TAGS,
  WHITEBOARD_DOCUMENT_FORMAT,
  upgradeWhiteboardDocumentJson,
  walkWhiteboardNodes,
  whiteboardDocumentDataSchema,
} from "./whiteboard-document-data";

const anchor = {
  __kind: "db-anchor-ref",
  id: "a",
  title: "A",
  peek: selectSource({ side: "head", file: "x.ts", fromLine: 1, toLine: 2 }),
};

const base = {
  format: WHITEBOARD_DOCUMENT_FORMAT,
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
          props: {},
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
      whiteboardDocumentDataSchema.parse(JSON.parse(JSON.stringify(document))),
    ).toEqual(document);
  });

  it("accepts exactly the prose tag allowlist", () => {
    for (const tag of PROSE_TAGS) {
      expect(
        whiteboardDocumentDataSchema.safeParse({
          ...base,
          body: [{ type: "element", tag, props: {}, children: [] }],
        }).success,
      ).toBe(true);
    }
  });

  it("allows table alignment only on cells and only with the three values", () => {
    const node = (tag: string, align: string) => ({
      ...base,
      body: [{ type: "element", tag, props: { align }, children: [] }],
    });

    expect(
      whiteboardDocumentDataSchema.safeParse(node("td", "left")).success,
    ).toBe(true);
    expect(
      whiteboardDocumentDataSchema.safeParse(node("th", "center")).success,
    ).toBe(true);
    expect(
      whiteboardDocumentDataSchema.safeParse(node("td", "banana")).success,
    ).toBe(false);
    expect(
      whiteboardDocumentDataSchema.safeParse(node("p", "left")).success,
    ).toBe(false);
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
        whiteboardDocumentDataSchema.safeParse({ ...base, body }).success,
      ).toBe(false);
    }
  });

  it("rejects registry component props that do not match their schema", () => {
    for (const body of [
      [
        {
          type: "component",
          name: "WhiteboardSection",
          props: { title: "" },
          children: [],
        },
      ],
      [
        {
          type: "component",
          name: "WhiteboardSection",
          props: { title: "T", surprise: 1 },
          children: [],
        },
      ],
      [
        {
          type: "component",
          name: "TutorialViewButton",
          props: { view: "banana" },
          children: [],
        },
      ],
      [
        {
          type: "component",
          name: "TraceQuote",
          props: { sessionId: "s", event: -1 },
          children: [],
        },
      ],
      [
        {
          type: "component",
          name: "CodePeek",
          props: { anchor: { ...anchor, peek: undefined } },
          children: [],
        },
      ],
    ]) {
      expect(
        whiteboardDocumentDataSchema.safeParse({ ...base, body }).success,
      ).toBe(false);
    }
  });

  it("reports the failing component prop by path", () => {
    const parsed = whiteboardDocumentDataSchema.safeParse({
      ...base,
      body: [
        {
          type: "component",
          name: "WhiteboardSection",
          props: { title: 7 },
          children: [],
        },
      ],
    });

    expect(parsed.success).toBe(false);
    expect(
      parsed.success ? [] : parsed.error.issues.map((issue) => issue.path),
    ).toContainEqual(["body", 0, "props", "title"]);
  });

  it("keeps a valid registry component", () => {
    expect(
      whiteboardDocumentDataSchema.safeParse({
        ...base,
        body: [
          {
            type: "component",
            name: "WhiteboardSection",
            props: { title: "T", defaultCollapsed: true },
            children: [],
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("upgrades stored code-peek refs to plain source ranges, anywhere", () => {
    const stored = {
      anchors: {
        a: {
          __kind: "db-anchor-ref",
          id: "a",
          title: "A",
          peek: {
            __kind: "code-peek-ref",
            props: {
              file: "src/a.ts",
              fromLine: 2,
              toLine: 4,
              graph: "base",
              theme: "dark",
            },
            resolution: null,
          },
        },
      },
      body: [
        {
          type: "component",
          name: "CallStackDiff",
          props: {
            base: [
              {
                __kind: "db-anchor-ref",
                id: "a",
                title: "A",
                peek: {
                  __kind: "code-peek-ref",
                  props: { file: "src/a.ts", fromLine: 2, toLine: 4 },
                  resolution: null,
                },
              },
            ],
          },
          children: [],
        },
      ],
    };

    expect(upgradeWhiteboardDocumentJson(stored)).toEqual({
      anchors: {
        a: {
          __kind: "db-anchor-ref",
          id: "a",
          title: "A",
          peek: selectSource({
            side: "base",
            file: "src/a.ts",
            fromLine: 2,
            toLine: 4,
          }),
        },
      },
      body: [
        {
          type: "component",
          name: "CallStackDiff",
          props: {
            base: [
              {
                id: "a",
                key: "a",
                source: {
                  file: "src/a.ts",
                  start: { side: "head", line: 2 },
                  end: { side: "head", line: 4 },
                },
                label: "A",
              },
            ],
          },
          children: [],
        },
      ],
    });
  });

  it("leaves already-upgraded documents byte-identical", () => {
    const current = {
      anchors: {
        a: {
          peek: selectSource({
            side: "head",
            file: "f",
            fromLine: 1,
            toLine: 1,
          }),
        },
      },
    };

    expect(JSON.stringify(upgradeWhiteboardDocumentJson(current))).toBe(
      JSON.stringify(current),
    );
  });

  it("walks components with their parent", () => {
    const seen: string[] = [];
    walkWhiteboardNodes(
      [
        {
          type: "component",
          name: "WhiteboardSection",
          props: { title: "Create" },
          children: [
            {
              type: "component",
              name: "WhiteboardSection",
              props: { title: "Inner" },
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

    expect(seen).toEqual([
      "root>WhiteboardSection",
      "WhiteboardSection>WhiteboardSection",
    ]);
  });
});
