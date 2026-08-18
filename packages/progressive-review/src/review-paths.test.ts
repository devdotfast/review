import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  normalizeReviewRoutePath,
  resolveReviewDocumentFilePath,
  reviewDocumentRoutePathForFile,
} from "./review-paths";

describe("review route paths", () => {
  it("maps PR review files to /pr/:number routes", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "review-paths-"));
    const reviewDocumentsDir = path.join(dir, ".dev", "reviews");
    const prPath = path.join(reviewDocumentsDir, "pr-123.mdx");
    mkdirSync(reviewDocumentsDir, { recursive: true });
    writeFileSync(prPath, "# PR Review\n");

    expect(
      reviewDocumentRoutePathForFile({ reviewDocumentsDir, filePath: prPath }),
    ).toBe("/pr/123");
  });

  it("resolves document query routes to safe review document files", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "review-paths-"));
    const reviewDocumentsDir = path.join(dir, ".dev", "reviews");
    const reviewPath = path.join(reviewDocumentsDir, "current", "review.mdx");
    const prPath = path.join(reviewDocumentsDir, "pr-123.mdx");
    const archivedPath = path.join(reviewDocumentsDir, "archived.mdx");
    mkdirSync(path.dirname(reviewPath), { recursive: true });
    mkdirSync(reviewDocumentsDir, { recursive: true });
    writeFileSync(reviewPath, "# Current\n");
    writeFileSync(prPath, "# PR Review\n");
    writeFileSync(archivedPath, "# Archived\n");

    const input = { reviewPath, reviewDocumentsDir };

    expect(resolveReviewDocumentFilePath({ ...input, routePath: "/" })).toBe(
      path.resolve(reviewPath),
    );
    expect(
      resolveReviewDocumentFilePath({ ...input, routePath: "/pr/123" }),
    ).toBe(path.resolve(prPath));
    expect(
      resolveReviewDocumentFilePath({ ...input, routePath: "/archived" }),
    ).toBe(path.resolve(archivedPath));
    expect(
      resolveReviewDocumentFilePath({ ...input, routePath: "/../../secret" }),
    ).toBeNull();
    expect(
      resolveReviewDocumentFilePath({
        ...input,
        routePath: "/pr/not-a-number",
      }),
    ).toBeNull();
    expect(
      resolveReviewDocumentFilePath({ ...input, routePath: "/nested/review" }),
    ).toBeNull();
  });

  it("normalizes route paths before mapping", () => {
    expect(normalizeReviewRoutePath("pr/123.mdx?tab=review")).toBe("/pr/123");
    expect(normalizeReviewRoutePath("/archived.mdx#top")).toBe("/archived");
    expect(normalizeReviewRoutePath("/")).toBe("/");
  });
});
