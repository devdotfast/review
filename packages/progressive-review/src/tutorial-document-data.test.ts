import { cp, mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { resolveRevision } from "@dev.fast/local-vcs";
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
      walkReviewNodes(evaluation.document!.body, (node) => {
        if (node.type === "component") componentNames.add(node.name);
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
