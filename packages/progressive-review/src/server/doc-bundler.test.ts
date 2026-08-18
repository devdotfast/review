import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { REVIEW_SCHEMA_VERSION } from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it } from "vitest";

import { bundleReviewDocument } from "./doc-bundler";

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
