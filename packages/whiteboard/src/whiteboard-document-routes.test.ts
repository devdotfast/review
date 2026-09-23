import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  normalizeWhiteboardRoutePath,
  resolveWhiteboardDocumentFilePath,
} from "./whiteboard-document-routes";

describe("review document routes", () => {
  it("resolves document query routes to safe review document files", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "review-paths-"));
    const whiteboardDocumentsDir = path.join(dir, ".dev", "reviews");

    const whiteboardPath = path.join(
      whiteboardDocumentsDir,
      "current",
      "review.mdx",
    );

    const prPath = path.join(whiteboardDocumentsDir, "pr-123.mdx");
    const archivedPath = path.join(whiteboardDocumentsDir, "archived.mdx");
    mkdirSync(path.dirname(whiteboardPath), { recursive: true });
    mkdirSync(whiteboardDocumentsDir, { recursive: true });
    writeFileSync(whiteboardPath, "# Current\n");
    writeFileSync(prPath, "# PR Review\n");
    writeFileSync(archivedPath, "# Archived\n");

    const input = { whiteboardPath, whiteboardDocumentsDir };

    expect(
      resolveWhiteboardDocumentFilePath({ ...input, routePath: "/" }),
    ).toBe(path.resolve(whiteboardPath));
    expect(
      resolveWhiteboardDocumentFilePath({ ...input, routePath: "/pr/123" }),
    ).toBe(path.resolve(prPath));
    expect(
      resolveWhiteboardDocumentFilePath({ ...input, routePath: "/archived" }),
    ).toBe(path.resolve(archivedPath));
    expect(
      resolveWhiteboardDocumentFilePath({
        ...input,
        routePath: "/../../secret",
      }),
    ).toBeNull();
    expect(
      resolveWhiteboardDocumentFilePath({
        ...input,
        routePath: "/pr/not-a-number",
      }),
    ).toBeNull();
    expect(
      resolveWhiteboardDocumentFilePath({
        ...input,
        routePath: "/nested/review",
      }),
    ).toBeNull();
  });

  it("normalizes route paths before mapping", () => {
    expect(normalizeWhiteboardRoutePath("pr/123.mdx?tab=review")).toBe(
      "/pr/123",
    );
    expect(normalizeWhiteboardRoutePath("/archived.mdx#top")).toBe("/archived");
    expect(normalizeWhiteboardRoutePath("/")).toBe("/");
  });
});
