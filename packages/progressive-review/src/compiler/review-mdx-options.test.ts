import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  checkReviewMdxTableSupport,
  compileReviewMdx,
} from "./review-mdx-options";

const packageRoot = path.resolve(import.meta.dirname, "../..");

describe("review MDX options", () => {
  it("compiles GitHub-style pipe tables to table output", async () => {
    const compiled = await compileReviewMdx(
      [
        "| State | Meaning |",
        "| --- | --- |",
        "| ready | renders as a table |",
      ].join("\n"),
    );

    expect(compiled).toContain("table");
    expect(compiled).toContain("thead");
    expect(compiled).toContain("td");
  });

  it("compiles anchors.* Markdown links into typed AnchorLink elements", async () => {
    const compiled = await compileReviewMdx(
      "[`Review runtime`](anchors.reviewRuntime)",
    );

    expect(compiled).toContain("AnchorLink");
    expect(compiled).toContain("anchor={anchors.reviewRuntime}");
    expect(compiled).not.toContain("href");
  });

  it("keeps the stamped h2 as the first child of a collapsed ReviewSection", async () => {
    const compiled = await compileReviewMdx(
      ["## Testing [collapsed]", "", "Persistence suites pass."].join("\n"),
    );

    const sectionIndex = compiled.indexOf(
      '<ReviewSection title="Testing" defaultCollapsed>',
    );
    const headingIndex = compiled.indexOf(
      '<_components.h2 data-review-block-index="0" data-review-block-tag="h2">',
      sectionIndex,
    );
    const paragraphIndex = compiled.indexOf(
      '<_components.p data-review-block-index="1" data-review-block-tag="p">',
      headingIndex,
    );
    expect(sectionIndex).toBeGreaterThan(-1);
    expect(headingIndex).toBeGreaterThan(sectionIndex);
    expect(paragraphIndex).toBeGreaterThan(headingIndex);
  });

  it("rejects malformed anchors.* Markdown links", async () => {
    await expect(
      compileReviewMdx("[Broken](anchors.review.runtime)"),
    ).rejects.toThrow(
      "Review anchor links must use [label](anchors.key); received anchors.review.runtime.",
    );
  });

  it("compiles duplicate diagram labels; the render-time registry rejects them", async () => {
    // Duplicate labels — literal or computed — are the live-diagram registry's
    // job (thread-target-model.tsx), which sees resolved values. Compilation
    // must not half-enforce this with a literals-only check.
    await expect(
      compileReviewMdx(
        [
          '<SequenceDiagram label="Request flow" messages={messages} />',
          '<DatabaseLens title="Request flow" stores={stores}>',
          '  <DbUseCase id="one" label="One">{null}</DbUseCase>',
          "</DatabaseLens>",
        ].join("\n"),
      ),
    ).resolves.toContain("SequenceDiagram");
  });

  it("uses the shared MDX options through the desktop document compiler", () => {
    const compilerSource = readFileSync(
      path.join(import.meta.dirname, "review-document-compiler.ts"),
      "utf8",
    );

    expect(compilerSource).toContain('from "./review-mdx-options"');
    expect(compilerSource).toContain("...reviewMdxOptions");
  });

  it("includes review document table styling", () => {
    const source = readFileSync(
      path.join(packageRoot, "app/src/styles.css"),
      "utf8",
    );

    expect(source).toMatch(/\.review-document table\s*{/);
    expect(source).toMatch(/\.review-document th,\s*\n\.review-document td/);
  });

  it("passes the runtime table-support sentinel", async () => {
    await expect(checkReviewMdxTableSupport()).resolves.toEqual({ ok: true });
  });
});
