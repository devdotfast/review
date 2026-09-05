import { cp, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveRevision } from "@dev.fast/local-vcs";
import {
  type JsonValue,
  isJsonObject,
  jsonString,
} from "@dev.fast/review-protocol";
import { describe, expect, it } from "vitest";

import {
  reviewDocumentDataSchema,
  walkReviewNodes,
} from "./review-document-data";
import { createReviewDir } from "./review-home";
import { evaluateReviewDocumentBundleForPublish } from "./review-publish-evaluate";
import { compileReviewDocumentBundle } from "./server/doc-bundler";

describe("tutorial review document data", () => {
  it("compiles and materializes the real tutorial against its stub repository", async () => {
    const packageRoot = path.resolve(import.meta.dirname, "..");
    const tutorialDir = path.join(packageRoot, "tutorial");
    await stat(path.join(tutorialDir, "git-stub", "HEAD"));
    const temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "review-tutorial-document-data-"),
    );
    try {
      const sourceRootPath = path.join(temporaryRoot, "sample-service");
      await cp(path.join(tutorialDir, "sample-service"), sourceRootPath, {
        recursive: true,
      });
      await cp(
        path.join(tutorialDir, "git-stub"),
        path.join(sourceRootPath, ".git"),
        { recursive: true },
      );
      const head = await resolveRevision(sourceRootPath, "main");
      const base = await resolveRevision(sourceRootPath, "main~1");
      expect(head).not.toBeNull();
      expect(base).not.toBeNull();
      const review = await createReviewDir({
        reviewsHomePath: temporaryRoot,
        worktreePath: sourceRootPath,
        baseRef: "main~1",
        baseCommit: base!.commit,
        sourceCommit: head!.commit,
        sourceIdentity: { kind: "git-branch", name: "main" },
      });
      await Promise.all(
        ["review.mdx", "data.ts", "authoring-conversation.json"].map((name) =>
          cp(path.join(tutorialDir, name), path.join(review.dir, name)),
        ),
      );

      const compiled = await compileReviewDocumentBundle({
        reviewPath: path.join(review.dir, "review.mdx"),
        reviewDocumentsDir: path.join(review.dir, ".review-documents"),
        reviewRootPath: review.dir,
        routePath: "/",
      });
      expect(compiled.diagnostics).toEqual([]);
      expect(compiled.bundle).not.toBeNull();

      const evaluation = await evaluateReviewDocumentBundleForPublish({
        bundleCode: compiled.bundle!.code,
        reviewDir: review.dir,
        prepareEvidence: async () => ({
          head: { sourceRootPath },
          base: { sourceRootPath },
        }),
      });

      expect(evaluation.errors).toEqual([]);
      expect(evaluation.document).not.toBeNull();
      const componentNames = new Set<string>();
      const inlineAnchorIds = new Set<string>();
      walkReviewNodes(evaluation.document!.body, (node) => {
        if (node.type !== "component") return;
        componentNames.add(node.name);
        collectInlineAnchorIds(node.props, inlineAnchorIds);
      });
      expect([...componentNames].sort()).toEqual(
        [
          "ReviewSection",
          "AnchorLink",
          "CodePeek",
          "SequenceDiagram",
          "DatabaseLens",
          "DbUseCase",
          "DbWrite",
          "TutorialKeymapPicker",
          "TutorialAuthoringConversation",
          "TutorialViewButton",
          "TutorialFeature",
        ].sort(),
      );
      expect(JSON.stringify(evaluation.document)).not.toContain(
        '"resolution":{',
      );
      expect(Object.keys(evaluation.document!.anchors).sort()).toEqual([
        "checkout",
        "dequeue",
        "insertOrder",
        "ordersTable",
        "placeOrder",
        "ship",
        "validateInventory",
      ]);
      expect(
        [...inlineAnchorIds].every((id) => id in evaluation.document!.anchors),
      ).toBe(true);
      expect(inlineAnchorIds.has("ordersTable")).toBe(false);
      expect(
        reviewDocumentDataSchema.parse(
          JSON.parse(JSON.stringify(evaluation.document)),
        ),
      ).toEqual(evaluation.document);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 30_000);
});

function collectInlineAnchorIds(value: JsonValue, ids: Set<string>): void {
  if (Array.isArray(value)) {
    for (const child of value) collectInlineAnchorIds(child, ids);
    return;
  }
  if (!isJsonObject(value)) return;
  const anchorId =
    jsonString(value.__kind) === "db-anchor-ref"
      ? jsonString(value.id)
      : undefined;
  if (anchorId !== undefined) ids.add(anchorId);
  for (const child of Object.values(value)) {
    collectInlineAnchorIds(child, ids);
  }
}
