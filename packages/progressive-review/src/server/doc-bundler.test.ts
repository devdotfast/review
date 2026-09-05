import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { REVIEW_SCHEMA_VERSION } from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it } from "vitest";

import { formatReviewDocumentDiagnostics } from "../compiler/review-document-compiler";
import {
  bundleReviewDocument,
  compileReviewDocumentBundle,
} from "./doc-bundler";

describe("review document bundler", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("bundles explicit authoring imports into the active browser ESM document", async () => {
    const rootPath = await mkdtemp(path.join(tmpdir(), "review-doc-bundle-"));
    roots.push(rootPath);
    await writeReviewStore(rootPath);
    const documentsDir = path.join(rootPath, ".review-documents");
    const reviewPath = path.join(documentsDir, "current", "review.mdx");
    await mkdir(path.dirname(reviewPath), { recursive: true });
    await writeFile(
      reviewPath,
      [
        "import {",
        "  defineActors,",
        "  defineAnchors,",
        '} from "virtual:progressive-review-authoring";',
        "",
        "export const actors = defineActors({",
        '  reviewer: { label: "Reviewer" },',
        "});",
        "export const anchors = defineAnchors({",
        '  evidence: { title: "Evidence", peek: { file: "src/example.ts", fromLine: 1, toLine: 3 } },',
        "});",
        "export const comments = {};",
        "",
        "# Bundled review",
        "",
        "The desktop canvas loads this document without Vite.",
        "",
        "[Inspect the evidence](anchors.evidence).",
      ].join("\n"),
      "utf8",
    );

    const bundle = await bundleReviewDocument({
      reviewPath,
      reviewDocumentsDir: documentsDir,
      reviewRootPath: rootPath,
      routePath: "/",
    });

    expect(bundle.routePath).toBe("/");
    expect(bundle.sourcePath).toBe(reviewPath);
    expect(bundle.contentHash).toMatch(/^[a-f0-9]{20}$/);
    expect(bundle.code).toContain("activeReviewDocument");
    expect(bundle.code).toMatch(/export\s*\{[^}]*activeReviewDocument/);
    expect(bundle.code).toContain("review-doc-runtime");
    expect(bundle.code).toContain("Inspect the evidence");
    expect(bundle.code).toContain("activeReviewDocument");
  });

  it("bundles colocated data.ts definitions into the document", async () => {
    const rootPath = await mkdtemp(path.join(tmpdir(), "review-doc-bundle-"));
    roots.push(rootPath);
    await writeReviewStore(rootPath);
    const documentsDir = path.join(rootPath, ".review-documents");
    const reviewDir = path.join(documentsDir, "current");
    const reviewPath = path.join(reviewDir, "review.mdx");
    await mkdir(reviewDir, { recursive: true });
    await writeFile(
      path.join(reviewDir, "data.ts"),
      [
        'import { defineActors } from "virtual:progressive-review-authoring";',
        "export const actors = defineActors({",
        '  reviewer: { label: "Data file reviewer" },',
        "});",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      reviewPath,
      [
        'import { actors } from "./data.ts";',
        "",
        "# Data-backed review",
        "",
        "<SequenceDiagram",
        '  label="Data-backed flow"',
        "  messages={[{",
        "    from: actors.reviewer,",
        "    to: actors.reviewer,",
        '    label: "Review data separately",',
        '    code: "pnpm test",',
        "  }]}",
        "/>",
      ].join("\n"),
      "utf8",
    );

    const bundle = await bundleReviewDocument({
      reviewPath,
      reviewDocumentsDir: documentsDir,
      reviewRootPath: rootPath,
      routePath: "/",
    });

    expect(bundle.code).toContain("Data file reviewer");
    expect(bundle.code).toContain("Review data separately");
    expect(bundle.code).not.toContain('from "./data.ts"');
  });

  it("reports a 1-based column for an esbuild error at column 0 in a colocated .js dependency", async () => {
    // Safety note: This test deliberately feeds esbuild an invalid .js module so
    // that compileReviewDocumentBundle surfaces a structured build diagnostic;
    // the file is never executed.
    const rootPath = await mkdtemp(path.join(tmpdir(), "review-doc-bundle-"));
    roots.push(rootPath);
    await writeReviewStore(rootPath);
    const documentsDir = path.join(rootPath, ".review-documents");
    const reviewDir = path.join(documentsDir, "current");
    const reviewPath = path.join(reviewDir, "review.mdx");
    await mkdir(reviewDir, { recursive: true });
    // The trailing comma opens a declarator list whose next identifier is the
    // end of the file at the first byte of line 3, so esbuild reports column 0.
    await writeFile(
      path.join(reviewDir, "dep.js"),
      'export const marker = "v"\n,\n',
      "utf8",
    );
    await writeFile(
      reviewPath,
      [
        'import { marker } from "./dep.js";',
        "",
        "# Column-zero review",
        "",
        "The marker is {marker}.",
      ].join("\n"),
      "utf8",
    );

    const result = await compileReviewDocumentBundle({
      reviewPath,
      reviewDocumentsDir: documentsDir,
      reviewRootPath: rootPath,
      routePath: "/",
    });

    expect(result.bundle).toBeNull();
    const diagnostic = result.diagnostics.find((entry) =>
      entry.filePath.endsWith("dep.js"),
    );
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.source).toBe("review");
    expect(diagnostic?.severity).toBe("error");
    expect(diagnostic?.code).toBe("bundle");
    expect(diagnostic?.line).toBe(3);
    // esbuild's column is 0-based, so column 0 must convert to 1 (not be
    // dropped by a truthy guard).
    expect(diagnostic?.column).toBe(1);
    // The user-facing formatted location must include the column, which the
    // bug previously omitted for column-0 errors.
    expect(formatReviewDocumentDiagnostics(result.diagnostics)).toContain(
      "dep.js:3:1",
    );
  });

  it("bundles a valid colocated .js dependency into the document", async () => {
    const rootPath = await mkdtemp(path.join(tmpdir(), "review-doc-bundle-"));
    roots.push(rootPath);
    await writeReviewStore(rootPath);
    const documentsDir = path.join(rootPath, ".review-documents");
    const reviewDir = path.join(documentsDir, "current");
    const reviewPath = path.join(reviewDir, "review.mdx");
    await mkdir(reviewDir, { recursive: true });
    await writeFile(
      path.join(reviewDir, "dep.js"),
      'export const marker = "colocated-js-value"\n',
      "utf8",
    );
    await writeFile(
      reviewPath,
      [
        'import { marker } from "./dep.js";',
        "",
        "# Js-backed review",
        "",
        "The marker is {marker}.",
      ].join("\n"),
      "utf8",
    );

    const bundle = await bundleReviewDocument({
      reviewPath,
      reviewDocumentsDir: documentsDir,
      reviewRootPath: rootPath,
      routePath: "/",
    });

    expect(bundle.code).toContain("colocated-js-value");
    expect(bundle.code).not.toContain('from "./dep.js"');
  });
});

async function writeReviewStore(worktreePath: string): Promise<void> {
  await writeFile(
    path.join(worktreePath, "review.json"),
    JSON.stringify({
      schemaVersion: REVIEW_SCHEMA_VERSION,
      uuid: "11111111-1111-4111-8111-111111111111",
      repoKey: "test-repo",
      worktreePath,
      baseRef: "main",
      baseCommit: "base",
      sourceCommit: null,
      sourceIdentity: null,
      pullRequestNumber: null,
      pullRequestUrl: null,
      title: "Test Review",
      sourceSession: "disabled:review",
      status: "awaiting-review",
      presentedDocumentRevision: null,
      presentedSoftwareMapRevision: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      lastPublishedAt: null,
    }),
    "utf8",
  );
}
