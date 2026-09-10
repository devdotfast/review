import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { type ReviewNode, walkReviewNodes } from "../review-document-data";
import { evaluateReviewDocumentBundleForPublish } from "../review-publish-evaluate";
import { buildReviewDocument } from "./build";

const roots: string[] = [];
async function fixture(source: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "review-native-document-"));
  roots.push(root);
  const reviewPath = path.join(root, "review.mdx");
  await writeFile(reviewPath, source);
  return { reviewPath, ranges: "skip" as const };
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("native document builder", () => {
  it("retains rich prose, unused anchors, evidence sides and component nesting", async () => {
    const dir = path.resolve(import.meta.dirname, "../fixtures/document-json");
    const input = await fixture(
      await readFile(path.join(dir, "order-review.mdx"), "utf8"),
    );
    await cp(
      path.join(dir, "data.ts.txt"),
      path.join(path.dirname(input.reviewPath), "data.ts"),
    );
    const result = await buildReviewDocument(input);
    expect(result.diagnostics).toEqual([]);
    expect(result.errors).toEqual([]);
    const document = result.document!;
    expect(document.title).toBe("Order persistence — café ☕");
    expect(document.anchors.unused.title).toBe("Unused but retained");
    expect(document.anchors.previous.peek?.props.graph).toBe("base");
    const nodes: ReviewNode[] = [];
    walkReviewNodes(document.body, (node) => nodes.push(node));
    expect(nodes).toContainEqual(
      expect.objectContaining({
        type: "element",
        tag: "a",
        props: expect.objectContaining({
          href: "https://example.com/orders?q=ready&limit=2",
        }),
      }),
    );
    const lens = nodes.find(
      (node) => node.type === "component" && node.name === "DatabaseLens",
    );
    expect(lens?.type === "component" && lens.children).toContainEqual(
      expect.objectContaining({ type: "component", name: "DbUseCase" }),
    );
  });
  it("maps semantic failures to authored positions", async () => {
    const result = await buildReviewDocument(
      await fixture(
        '# Check\n\nexport const count: number = "wrong";\n\n<SequenceDiagram label="Test" messages={[]} typo="bad" />\n',
      ),
    );
    expect(result.document).toBeNull();
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "TS2322", line: 3, column: 14 }),
        expect.objectContaining({ code: "TS2769", line: 5 }),
      ]),
    );
  });
  it("evaluates inline JSX with the same component audit", async () => {
    const result = await buildReviewDocument(
      await fixture(
        '# Inline\n\n{true && <SequenceDiagram label="Inline" messages={[{from: {label: "A"}, to: {label: "B"}, label: "Move", code: "move()"}]} />}\n',
      ),
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.document).not.toBeNull();
  });
  it("accepts an independent parser through the owned syntax contract", async () => {
    const result = await buildReviewDocument(
      await fixture("alternate syntax"),
      async () => ({
        title: "Alternate",
        modules: [],
        expressions: [],
        bindings: [],
        body: [
          {
            kind: "element",
            name: "p",
            attributes: [],
            children: [{ kind: "text", value: "Owned syntax" }],
          },
        ],
      }),
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.document?.body).toEqual([
      {
        type: "element",
        tag: "p",
        props: {},
        children: [{ type: "text", value: "Owned syntax" }],
      },
    ]);
  });
});

it("publishes footnotes, inert inline HTML, GFM and aligned tables successfully", async () => {
  const built = await buildReviewDocument(
    await fixture(
      "# GFM extras\n\nA footnote reference[^note], ~~struck text~~, and <b>bold</b> with <kbd>Enter</kbd> and x<sup>2</sup>.\n\n| Left | Right |\n| :--- | ---: |\n| A | B |\n\n[^note]: Footnote content.\n",
    ),
  );
  expect(built.diagnostics).toEqual([]);
  expect(built.errors).toEqual([]);
  const json = JSON.stringify(built.document);
  for (const text of [
    "data-footnote-ref",
    "data-footnote-backref",
    "aria-describedby",
    "Footnote content.",
    '"align":"right"',
    '"tag":"kbd"',
  ])
    expect(json).toContain(text);
});

it("refreshes transitive helpers, recovers failed imports, and preserves symlink identity", async () => {
  const input = await fixture(
    'import { label, sectionProps } from "./data.ts";\n\n# Freshness\n\n<ReviewSection {...sectionProps}>{label}</ReviewSection>\n',
  );
  const dir = path.dirname(input.reviewPath);
  await writeFile(
    path.join(dir, "data.ts"),
    'export { label } from "./helper";\nexport const sectionProps = { title: "Spread" };\n',
  );
  const helper = path.join(dir, "helper.ts");
  await writeFile(helper, 'export const label = "before";');
  expect(JSON.stringify((await buildReviewDocument(input)).document)).toContain(
    "before",
  );
  await writeFile(helper, 'export const label = "after";');
  expect(JSON.stringify((await buildReviewDocument(input)).document)).toContain(
    "after",
  );
  await writeFile(
    helper,
    'throw new Error("intentional failed import"); export const label = "failed";',
  );
  expect((await buildReviewDocument(input)).errors.join("\n")).toContain(
    "intentional failed import",
  );
  await writeFile(helper, 'export const label = "recovered";');
  const recovered = await buildReviewDocument(input);
  expect(recovered.errors).toEqual([]);
  expect(JSON.stringify(recovered.document)).toContain("recovered");
  const alias = `${dir}-alias`;
  roots.push(alias);
  await symlink(dir, alias, "dir");
  expect(
    await buildReviewDocument({
      ...input,
      reviewPath: path.join(alias, "review.mdx"),
    }),
  ).toEqual(recovered);
});

it("isolates concurrent authored builds from each other and the sealed legacy evaluator", async () => {
  const inputs = await Promise.all(
    ["One", "Two"].map((label) =>
      fixture(
        `export const anchors = defineAnchors({used: {title: ${JSON.stringify(label)}, peek: {file: "source.ts", fromLine: 1, toLine: 1}}});\n\n# ${label}\n\n<CodePeek anchor={anchors.used} />\n`,
      ),
    ),
  );
  const expected = await Promise.all(
    inputs.map((input) => buildReviewDocument(input)),
  );
  for (const built of expected) {
    expect(built.diagnostics).toEqual([]);
    expect(built.errors).toEqual([]);
  }
  const [concurrent, legacy] = await Promise.all([
    Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        buildReviewDocument(inputs[index % 2]),
      ),
    ),
    evaluateReviewDocumentBundleForPublish({
      reviewDir: path.dirname(inputs[0].reviewPath),
      bundleCode:
        'import { createActiveReviewDocument, jsx } from "review-doc-runtime"; export default createActiveReviewDocument({title: "Sealed", routePath: "/", filePath: "review.mdx", models: {}, modelNames: [], Component: () => jsx("p", {children: "Legacy"})});',
    }),
  ]);
  concurrent.forEach((built, index) =>
    expect(built).toEqual(expected[index % 2]),
  );
  expect(legacy.errors).toEqual([]);
  expect(legacy.document?.title).toBe("Sealed");
}, 30000);

it.each([
  [
    "ts",
    'enum Label { Value = "helper content" }; export const content = Label.Value;',
  ],
  ["mts", 'export const content: string = "helper content";'],
  ["cts", 'export const content: string = "helper content";'],
  ["cjs", 'exports.content = "helper content";'],
  [
    "tsx",
    'import React from "react"; export const content = <strong>helper content</strong>;',
  ],
  ["json", '{"content":"helper content"}'],
])("loads %s helpers without authored bundling", async (extension, source) => {
  const input = await fixture(
    `import ${extension === "json" ? "data" : "{ content }"} from "./helper.${extension}";\n\n# Helpers\n\n{${extension === "json" ? "data.content" : "content"}}\n`,
  );
  await writeFile(
    path.join(path.dirname(input.reviewPath), `helper.${extension}`),
    source,
  );
  const built = await buildReviewDocument(input);
  expect(built.diagnostics).toEqual([]);
  expect(built.errors).toEqual([]);
  expect(JSON.stringify(built.document)).toContain("helper content");
});

it("discards CJS globals and outstanding timers on every worker lifetime", async () => {
  const input = await fixture(
    'import { content } from "./state.cjs";\n\n# Isolation\n\n{content}\n',
  );
  const key = "__reviewDocumentTestCounter";
  await writeFile(
    path.join(path.dirname(input.reviewPath), "state.cjs"),
    `globalThis.${key} = (globalThis.${key} ?? 0) + 1; exports.content = "fresh " + globalThis.${key}; setInterval(() => {}, 60000);`,
  );
  for (let index = 0; index < 20; index++) {
    const built = await buildReviewDocument(input);
    expect(built.diagnostics).toEqual([]);
    expect(built.errors).toEqual([]);
    expect(JSON.stringify(built.document)).toContain('"value":"fresh 1"');
  }
  expect(Object.hasOwn(globalThis, key)).toBe(false);
}, 40000);

it.each([
  ["unsafe tag", '<script>alert("no")</script>'],
  ["unsafe URL", "[bad](javascript:alert%281%29)"],
  ["event handler", "<a onClick={() => {}}>bad</a>"],
  ["missing anchor", "<CodePeek anchor={anchors.missing} />"],
  ["invalid JSX", "<CodePeek anchor={"],
])("rejects %s without producing an artifact", async (_name, source) => {
  const built = await buildReviewDocument(
    await fixture(`# Invalid\n\n${source}\n`),
  );
  expect(built.document).toBeNull();
  expect(built.errors.length + built.diagnostics.length).toBeGreaterThan(0);
});

it("resolves authored package exports and package-local imports", async () => {
  const input = await fixture(
    'import { content } from "fixture-helper/label";\n\n# Package\n\n{content}\n',
  );
  const dir = path.join(
    path.dirname(input.reviewPath),
    "node_modules/fixture-helper",
  );
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "fixture-helper",
      type: "module",
      exports: { "./label": "./label.js" },
      imports: { "#value": "./value.js" },
    }),
  );
  await writeFile(
    path.join(dir, "label.js"),
    'export { content } from "#value";',
  );
  await writeFile(
    path.join(dir, "value.js"),
    'export const content = "package exports resolved";',
  );
  const built = await buildReviewDocument(input);
  expect(built.diagnostics).toEqual([]);
  expect(built.errors).toEqual([]);
  expect(JSON.stringify(built.document)).toContain("package exports resolved");
});

it("prepares evidence lazily once and delivers changed-line callbacks across the worker boundary", async () => {
  const input = await fixture(
    'export const anchors = defineAnchors({before: {title: "Before", peek: {file: "source.ts", fromLine: 1, toLine: 1, graph: "base"}}, after: {title: "After", peek: {file: "source.ts", fromLine: 1, toLine: 1}}});\n\n# Evidence\n\n<CodePeek anchor={anchors.before} />\n<CallStackDiff title="Change" base={[anchors.before]} head={[anchors.after]} />\n',
  );
  const dir = path.dirname(input.reviewPath);
  await writeFile(path.join(dir, "source.ts"), "export const value = 1;\n");
  let prepared = 0;
  const requested: string[] = [];
  const prepareEvidence = async () => {
    prepared++;
    return { head: { sourceRootPath: dir }, base: { sourceRootPath: dir } };
  };
  const built = await buildReviewDocument({
    ...input,
    ranges: "validate",
    prepareEvidence,
    resolveChangedLines: async (file, side) => {
      requested.push(`${side}:${file}`);
      return { added: new Set([1]), deleted: new Set([1]) };
    },
  });
  expect(built.diagnostics).toEqual([]);
  expect(built.errors).toEqual([]);
  expect(prepared).toBe(1);
  expect(requested.sort()).toEqual(["base:source.ts", "head:source.ts"]);
  await buildReviewDocument({
    ...(await fixture("# No evidence\n\nPlain prose.\n")),
    prepareEvidence,
  });
  expect(prepared).toBe(1);
});

it("cancels an outstanding worker evidence request and ignores its late completion", async () => {
  const input = await fixture(
    'export const anchors = defineAnchors({a: {title: "A", peek: {file: "source.ts", fromLine: 1, toLine: 1}}});\n\n# Cancel\n\n<CodePeek anchor={anchors.a} />\n',
  );
  const controller = new AbortController();
  let complete!: (value: { head: { sourceRootPath: string } }) => void;
  const pending = new Promise<{ head: { sourceRootPath: string } }>(
    (resolve) => {
      complete = resolve;
    },
  );
  const built = buildReviewDocument({
    ...input,
    ranges: "validate",
    signal: controller.signal,
    prepareEvidence: () => {
      controller.abort(new Error("cancelled by test"));
      return pending;
    },
  });
  await expect(built).rejects.toThrow("cancelled by test");
  complete({ head: { sourceRootPath: path.dirname(input.reviewPath) } });
  const recovered = await buildReviewDocument(
    await fixture("# After cancellation\n"),
  );
  expect(recovered.errors).toEqual([]);
  expect(recovered.document?.title).toBe("After cancellation");
});

it.each([
  [
    new Error("evidence unavailable", { cause: () => undefined }),
    "evidence unavailable",
  ],
  [undefined, "undefined"],
])(
  "preserves evidence callback rejection messages across RPC (%s)",
  async (error, message) => {
    const input = await fixture(
      'export const anchors = defineAnchors({a: {title: "A", peek: {file: "source.ts", fromLine: 1, toLine: 1}}});\n\n# Evidence error\n\n<CodePeek anchor={anchors.a} />\n',
    );
    const result = await buildReviewDocument({
      ...input,
      ranges: "validate",
      prepareEvidence: async () => {
        throw error;
      },
    });
    expect(result.document).toBeNull();
    expect(result.errors.join("\n")).toContain(message);
  },
);

it("rejects an uncloneable callback result without waiting for the worker deadline", async () => {
  const input = await fixture(
    'export const anchors = defineAnchors({a: {title: "A", peek: {file: "source.ts", fromLine: 1, toLine: 1}}});\n\n# Invalid transport\n\n<CodePeek anchor={anchors.a} />\n',
  );
  await expect(
    buildReviewDocument({
      ...input,
      ranges: "validate",
      prepareEvidence: async () => ({
        head: { sourceRootPath: path.dirname(input.reviewPath) },
        uncloneable: () => undefined,
      }),
    }),
  ).rejects.toThrow(/clone/i);
}, 10_000);

it("rejects a pending RPC when an authored helper exits the worker", async () => {
  const input = await fixture('import "./exit.cjs";\n\n# Worker exit\n');
  await writeFile(
    path.join(path.dirname(input.reviewPath), "exit.cjs"),
    "process.exit(7);\n",
  );
  await expect(buildReviewDocument(input)).rejects.toThrow(
    "Document worker exited before returning (7)",
  );
}, 10_000);

it("terminates an authored infinite loop at the publication deadline", async () => {
  const input = await fixture('import "./loop.cjs";\n\n# Timeout\n');
  await writeFile(
    path.join(path.dirname(input.reviewPath), "loop.cjs"),
    "while (true) {}\n",
  );
  await expect(buildReviewDocument(input)).rejects.toThrow(
    "Document build exceeded 30 seconds",
  );
}, 35000);

it.each([
  ["ts", "export const value = ;", 22],
  ["tsx", "export const value = <strong>bad;", 23],
  ["cjs", "exports.value = {", 18],
])(
  "rejects malformed %s helpers with their original source position",
  async (extension, source, column) => {
    const input = await fixture(
      `import {value} from "./helper.${extension}";\n\n# Invalid helper\n\n{value}\n`,
    );
    const helper = path.join(
      path.dirname(input.reviewPath),
      `helper.${extension}`,
    );
    await writeFile(helper, source);
    const built = await buildReviewDocument(input);
    expect(built.document).toBeNull();
    expect(built.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ filePath: helper, line: 1, column }),
      ]),
    );
  },
);

it("retains the existing helper semantic-checking boundary", async () => {
  const input = await fixture(
    'import {value} from "./helper.ts";\n\n# Helper semantics\n\n{value}\n',
  );
  await writeFile(
    path.join(path.dirname(input.reviewPath), "helper.ts"),
    'export const unused: number = "not checked here"; export const value = "Valid content";',
  );
  const built = await buildReviewDocument(input);
  expect(built.diagnostics).toEqual([]);
  expect(built.errors).toEqual([]);
  expect(JSON.stringify(built.document)).toContain("Valid content");
});
