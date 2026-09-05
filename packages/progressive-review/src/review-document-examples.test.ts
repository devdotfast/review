import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { patchChangedLines } from "./call-stack-diff";
import {
  bundleReviewDocument,
  readReviewDocumentBundle,
  writeReviewDocumentBundle,
} from "./review-bundle";
import {
  type ReviewNode,
  reviewDocumentDataSchema,
  walkReviewNodes,
} from "./review-document-data";
import { createReviewDir } from "./review-home";
import { evaluateReviewDocumentBundleForPublish } from "./review-publish-evaluate";
import { compileReviewDocumentBundle } from "./server/doc-bundler";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "review-json-example-"));
  roots.push(root);
  const headRoot = path.join(root, "head");
  const baseRoot = path.join(root, "base");
  await Promise.all([mkdir(headRoot), mkdir(baseRoot)]);
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: headRoot, encoding: "utf8" }).trim();
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@example.com"]);
  await writeFile(
    path.join(headRoot, "order.ts"),
    'export const status = "draft";\n',
  );
  await cp(path.join(headRoot, "order.ts"), path.join(baseRoot, "order.ts"));
  git(["add", "order.ts"]);
  git(["commit", "-qm", "Base"]);
  const baseCommit = git(["rev-parse", "HEAD"]);
  await writeFile(
    path.join(headRoot, "order.ts"),
    'export const status = "queued";\n',
  );
  git(["commit", "-qam", "Queue"]);
  const created = await createReviewDir({
    reviewsHomePath: path.join(root, "reviews"),
    worktreePath: headRoot,
    baseRef: baseCommit,
    baseCommit,
    sourceCommit: git(["rev-parse", "HEAD"]),
    sourceIdentity: { kind: "git-branch", name: "main" },
  });
  const examples = path.join(import.meta.dirname, "fixtures/document-json");
  await cp(
    path.join(examples, "data.ts.txt"),
    path.join(created.dir, "data.ts"),
  );
  const source = await readFile(
    path.join(examples, "order-review.mdx"),
    "utf8",
  );
  return {
    dir: created.dir,
    source,
    async evaluate(mdx = source) {
      await writeFile(path.join(created.dir, "review.mdx"), mdx);
      const compiled = await compileReviewDocumentBundle({
        reviewPath: path.join(created.dir, "review.mdx"),
        reviewDocumentsDir: path.join(created.dir, ".review-documents"),
        reviewRootPath: created.dir,
        routePath: "/",
      });
      expect(compiled.diagnostics).toEqual([]);
      if (!compiled.bundle) throw new Error("Fixture did not compile");
      return evaluateReviewDocumentBundleForPublish({
        bundleCode: compiled.bundle.code,
        reviewDir: created.dir,
        prepareEvidence: async () => ({
          head: { sourceRootPath: headRoot },
          base: { sourceRootPath: baseRoot },
        }),
        resolveChangedLines: async (file) =>
          file === "order.ts"
            ? patchChangedLines(git(["diff", baseCommit, "HEAD", "--", file]))
            : null,
      });
    },
  };
}

describe("real authored document JSON conversion", () => {
  it("preserves rich Markdown and component inputs through compilation, conversion, and disk round-trip", async () => {
    const example = await fixture();
    const result = await example.evaluate();
    expect(result.errors).toEqual([]);
    if (!result.document) throw new Error("Missing materialized document");
    const document = result.document;
    const nodes: ReviewNode[] = [];
    walkReviewNodes(document.body, (node) => nodes.push(node));
    const components = nodes.filter((node) => node.type === "component");
    expect([...new Set(components.map((node) => node.name))].sort()).toEqual([
      "AnchorLink",
      "CallStackDiff",
      "CodePeek",
      "DatabaseLens",
      "DbRead",
      "DbUseCase",
      "DbWrite",
      "ReviewSection",
      "SequenceDiagram",
    ]);
    expect(nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          value: "Order persistence — café ☕",
        }),
        expect.objectContaining({ type: "element", tag: "strong" }),
        expect.objectContaining({ type: "element", tag: "em" }),
        expect.objectContaining({ type: "element", tag: "blockquote" }),
        expect.objectContaining({ type: "element", tag: "table" }),
        expect.objectContaining({
          type: "element",
          tag: "ol",
        }),
        expect.objectContaining({
          type: "element",
          tag: "a",
          props: expect.objectContaining({
            href: "https://example.com/orders?q=ready&limit=2",
            title: "Order API",
          }),
        }),
        expect.objectContaining({
          type: "element",
          tag: "input",
          props: expect.objectContaining({ checked: true, disabled: true }),
        }),
        expect.objectContaining({
          type: "element",
          tag: "input",
          props: { type: "checkbox", disabled: true },
        }),
      ]),
    );
    expect(
      nodes
        .filter((node) => node.type === "element")
        .filter((node) => node.tag === "th" || node.tag === "td")
        .map((node) => node.props.align),
    ).toEqual(["left", "right", "left", "right"]);
    expect(
      nodes
        .filter((node) => node.type === "text")
        .map((node) => node.value)
        .join(""),
    ).toContain(
      'const status = "queued";\nif (status !== "shipped") enqueue();',
    );
    expect(components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "ReviewSection",
          props: expect.objectContaining({
            title: "Storage details",
            defaultCollapsed: true,
          }),
        }),
        expect.objectContaining({
          name: "DbRead",
          props: expect.objectContaining({
            from: expect.objectContaining({
              path: ["status"],
              collectionId: "orders",
            }),
          }),
        }),
        expect.objectContaining({
          name: "DbWrite",
          props: expect.objectContaining({
            to: expect.objectContaining({
              path: ["status"],
              collectionId: "orders",
            }),
          }),
        }),
      ]),
    );
    expect(Object.keys(document.anchors).sort()).toEqual([
      "current",
      "previous",
      "unused",
    ]);
    expect(document.anchors.previous?.peek?.props.graph).toBe("base");
    expect(result.rangePeeks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ anchorId: "previous", graph: "base" }),
        expect.objectContaining({ anchorId: "current" }),
      ]),
    );
    expect(
      nodes
        .filter((node) => node.type === "text")
        .map((node) => node.value)
        .join(""),
    ).toContain("Preserve & decode entities");
    const indices = nodes
      .filter((node) => node.type === "element")
      .filter((node) => node.props["data-review-block-index"] !== undefined)
      .map((node) => Number(node.props["data-review-block-index"]));
    expect(indices).toEqual(
      Array.from({ length: indices.length }, (_, index) => index),
    );
    expect(JSON.stringify(document)).not.toContain('"resolution":{');
    expect(
      reviewDocumentDataSchema.parse(JSON.parse(JSON.stringify(document))),
    ).toEqual(document);
    const bundle = bundleReviewDocument(document);
    await writeReviewDocumentBundle(example.dir, bundle);
    expect(await readReviewDocumentBundle(example.dir, "/")).toEqual(bundle);
    const repeat = await example.evaluate();
    expect(repeat.errors).toEqual([]);
    expect(repeat.document).toEqual(document);
    if (!repeat.document) throw new Error("Missing repeat document");
    expect(bundleReviewDocument(repeat.document).contentHash).toBe(
      bundle.contentHash,
    );
  });

  it.each([
    [
      "unsafe URL",
      '<a href="javascript:alert(1)">Unsafe</a>',
      /URL|href|javascript|document data/i,
    ],
    ["non-data prose prop", '<p style={{ color: "red" }}>Styled</p>', /style/],
    ["unsupported tag", "<video />", /video|document data/i],
  ])(
    "rejects %s from actual MDX without producing document data",
    async (_name, body, diagnostic) => {
      const example = await fixture();
      const result = await example.evaluate(`# Invalid document\n\n${body}\n`);
      expect(result.document).toBeNull();
      expect(result.errors.join("\n")).toMatch(diagnostic);
    },
  );

  it("rejects an invalid source range in real authored data", async () => {
    const example = await fixture();
    const dataPath = path.join(example.dir, "data.ts");
    await writeFile(
      dataPath,
      (await readFile(dataPath, "utf8")).replaceAll("toLine: 1", "toLine: 999"),
    );
    const result = await example.evaluate();
    expect(result.document).toBeNull();
    expect(result.errors.join("\n")).toMatch(/exceeds/);
  });
});
