import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  compileReviewDocument,
  formatReviewDocumentDiagnostics,
  reviewDocumentRevision,
} from "./review-document-compiler";

const fixturePath = path.join(process.cwd(), "reviews", "typed.mdx");

describe("compileReviewDocument", () => {
  it("reports and formats related component and anchor diagnostics from one document", async () => {
    const rootPath = await mkdtemp(
      path.join(os.tmpdir(), "review-document-diagnostic-"),
    );
    const filePath = path.join(rootPath, "typed.mdx");
    const source = [
      "export const actors = defineActors({",
      '  browser: { label: "Browser" },',
      "});",
      "export const malformedAnchors = defineAnchors({",
      '  broken: { title: "Broken", peek: {} },',
      "});",
      "export const anchors = defineAnchors({",
      '  known: { title: "Known", peek: { file: "src/example.ts", fromLine: 1, toLine: 3 } },',
      "});",
      "export const messages = [{",
      "  from: actors.heygen,",
      "  to: actors.browser,",
      '  label: "Generate video",',
      '  code: "POST /videos",',
      "}];",
      "",
      "# Review",
      "",
      '<SequenceDiagram label="Video generation" messages={[',
      "  {",
      '    from: "HeyGen",',
      "    to: actors.browser,",
      '    label: "Generate video",',
      '    code: { language: "http", text: "POST /videos" },',
      "  },",
      "]} />",
      "",
      '<SequenceDiagram lable="Video generation" messages={[]} />',
      "",
      "<SequenceDiagram messages={[]} />",
      "",
      '<SequenceDiagram label="Video generation" messages={[]}>',
      "  This component does not accept children.",
      "</SequenceDiagram>",
      "",
      '<CodePeek file="src/example.ts" fromLine={1} toLine={3} extra="invalid" />',
      "",
      '<AnchorLink anchor="details">Details</AnchorLink>',
      "",
      "<AnchorLink anchor={anchors.missing}>Details</AnchorLink>",
      "",
      "[Missing](anchors.missing)",
      "",
      '{"wrong" satisfies number}',
    ].join("\n");

    try {
      await writeFile(filePath, source);
      const result = await compileReviewDocument({
        filePath,
        reviewRootPath: rootPath,
        source,
      });

      expect(result.runtimeCode).toBeUndefined();
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "typescript",
            code: "TS2339",
            message: expect.stringContaining(
              "Property 'heygen' does not exist",
            ),
          }),
          expect.objectContaining({
            source: "typescript",
            code: "TS2769",
            message: expect.stringContaining("Type 'string' is not assignable"),
          }),
          expect.objectContaining({
            source: "typescript",
            message: expect.stringContaining("Property 'lable' does not exist"),
          }),
          expect.objectContaining({
            source: "typescript",
            message: expect.stringContaining("Property 'label' is missing"),
          }),
          expect.objectContaining({
            source: "typescript",
            message: expect.stringContaining(
              "Type 'Element' is not assignable to type 'undefined'",
            ),
          }),
          expect.objectContaining({
            source: "typescript",
            message: expect.stringContaining("Property 'file' does not exist"),
          }),
          expect.objectContaining({
            source: "typescript",
            code: "TS1360",
            message: expect.stringContaining(
              "Type 'string' does not satisfy the expected type 'number'",
            ),
          }),
          expect.objectContaining({
            source: "typescript",
            code: "TS2739",
            message: expect.stringContaining(
              "is missing the following properties",
            ),
          }),
          expect.objectContaining({
            source: "typescript",
            code: "TS2339",
            message: expect.stringContaining(
              "Property 'missing' does not exist on type",
            ),
          }),
        ]),
      );
      expect(
        result.diagnostics
          .filter((diagnostic) => diagnostic.severity === "error")
          .every((diagnostic) => diagnostic.source === "typescript"),
      ).toBe(true);
      expect(
        result.diagnostics.filter(
          (diagnostic) =>
            diagnostic.code === "TS2339" &&
            diagnostic.message.includes("Property 'missing' does not exist"),
        ).length,
      ).toBeGreaterThanOrEqual(2);

      const heygenLine =
        source.split("\n").findIndex((line) => line.includes("actors.heygen")) +
        1;
      const formatted = formatReviewDocumentDiagnostics(result.diagnostics);
      expect(formatted).toContain(`${filePath}:${heygenLine}:16 TS2339:`);
      expect(formatted).toContain(`${heygenLine} |   from: actors.heygen,`);
      expect(formatted).toContain("   |                ^");
    } finally {
      await rm(rootPath, { force: true, recursive: true });
    }
  });

  it("gives filesystem aliases the same validated revision", async () => {
    const rootPath = await mkdtemp(
      path.join(os.tmpdir(), "review-document-revision-"),
    );
    const aliasPath = `${rootPath}-alias`;
    const filePath = path.join(rootPath, "typed.mdx");
    try {
      await writeFile(filePath, "# Review\n");
      await symlink(rootPath, aliasPath, "dir");
      const source = "# Review\n";

      expect(
        reviewDocumentRevision({
          filePath,
          reviewRootPath: rootPath,
          source,
        }),
      ).toBe(
        reviewDocumentRevision({
          filePath: path.join(aliasPath, "typed.mdx"),
          reviewRootPath: aliasPath,
          source,
        }),
      );
    } finally {
      await rm(aliasPath, { force: true });
      await rm(rootPath, { force: true, recursive: true });
    }
  });
});

describe("formatReviewDocumentDiagnostics", () => {
  it("falls back to the one-line diagnostic when source is unreadable", async () => {
    const rootPath = await mkdtemp(
      path.join(os.tmpdir(), "review-document-diagnostic-missing-"),
    );
    const filePath = path.join(rootPath, "missing.mdx");
    await rm(rootPath, { force: true, recursive: true });

    expect(
      formatReviewDocumentDiagnostics([
        {
          source: "typescript",
          severity: "error",
          code: "TS2322",
          message: "Type mismatch",
          filePath,
          line: 2,
          column: 3,
        },
      ]),
    ).toBe(`${filePath}:2:3 TS2322: Type mismatch`);
  });
});
