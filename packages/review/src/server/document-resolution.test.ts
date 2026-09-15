import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { REVIEW_SCHEMA_VERSION } from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it } from "vitest";

import { buildReviewDocument } from "../document/build";

describe("review document native module resolution", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("loads explicit authoring imports into audited JSON", async () => {
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

    const evaluated = await buildReviewDocument({
      reviewPath,
      ranges: "skip",
    });

    expect(evaluated.diagnostics).toEqual([]);
    expect(evaluated.errors).toEqual([]);
    expect(evaluated.document?.routePath).toBe("/");
    expect(evaluated.document?.sourcePath).toBe("review.mdx");
    expect(JSON.stringify(evaluated.document)).toContain(
      "Inspect the evidence",
    );
  });

  it("loads colocated data.ts definitions into the document", async () => {
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
        'import { defineAnchors, defineSoftwareModel } from "virtual:progressive-review-authoring";',
        "export const anchors = defineAnchors({",
        '  used: { title: "Used", peek: { file: "src/used.ts", fromLine: 1, toLine: 1 } },',
        '  unused: { title: "Unused", peek: { file: "src/unused.ts", fromLine: 1, toLine: 1 } },',
        "});",
        'export const importedModel = defineSoftwareModel({ systems: { app: { label: "Imported app" } } });',
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      reviewPath,
      [
        'import { anchors, importedModel } from "./data.ts";',
        "",
        "# Data-backed review",
        "",
        "<CodePeek anchor={anchors.used} />",
      ].join("\n"),
      "utf8",
    );

    const evaluated = await buildReviewDocument({
      reviewPath,
      ranges: "skip",
    });

    expect(evaluated.diagnostics).toEqual([]);
    expect(evaluated.errors).toEqual([]);
    expect(Object.keys(evaluated.document?.anchors ?? {}).sort()).toEqual([
      "unused",
      "used",
    ]);
    expect(evaluated.document?.softwareModels[0]?.elements[0]?.label).toBe(
      "Imported app",
    );
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
