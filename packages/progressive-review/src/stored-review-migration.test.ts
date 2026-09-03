import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createReviewDir } from "./review-home";
import { migrateStoredReviewData } from "./stored-review-migration";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("migrateStoredReviewData", () => {
  it("deletes reviews from before the hard schema cutover", async () => {
    const reviewHome = await tempDir();
    const uuid = "3b241101-e2bb-4255-8caf-4136c566a962";
    const reviewDir = path.join(reviewHome, "reviews", uuid);
    await mkdir(reviewDir, { recursive: true });
    await writeFile(
      path.join(reviewDir, "review.json"),
      `${JSON.stringify({ schemaVersion: 1, uuid })}\n`,
    );

    await expect(
      migrateStoredReviewData({ reviewHome }),
    ).resolves.toMatchObject({ droppedReviews: 1, documents: 0 });
    await expect(
      readFile(path.join(reviewDir, "review.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a legacy draft and removes legacy thread files", async () => {
    const reviewHome = await tempDir();
    const sourceRoot = await gitRepository();
    const sourceCommit = execFileSync(
      "git",
      ["-C", sourceRoot, "rev-parse", "HEAD"],
      { encoding: "utf8" },
    ).trim();
    const created = await createReviewDir({
      reviewsHomePath: reviewHome,
      worktreePath: sourceRoot,
      baseRef: "main",
      baseCommit: sourceCommit,
      sourceCommit,
      sourceIdentity: { kind: "git-branch", name: "main" },
    });
    const current = created.review as Record<string, unknown>;
    const {
      presentedDocumentRevision: _documentRevision,
      presentedSoftwareMapRevision: _softwareMapRevision,
      ...legacy
    } = current;
    await writeFile(
      path.join(created.dir, "review.json"),
      `${JSON.stringify({
        ...legacy,
        schemaVersion: 2,
        presentedRevision: null,
      })}\n`,
    );
    await writeFile(path.join(created.dir, "comments.json"), '{"old":{}}\n');
    await writeFile(path.join(created.dir, "questions.json"), '{"old":{}}\n');

    await expect(
      migrateStoredReviewData({ reviewHome }),
    ).resolves.toMatchObject({
      documents: 1,
      droppedLegacyPeekReviews: 0,
      droppedReviews: 0,
      droppedComments: 1,
      droppedQuestions: 1,
    });
    await expect(
      readFile(path.join(created.dir, "review.json"), "utf8"),
    ).resolves.toContain('"schemaVersion": 4');
    await expect(
      readFile(path.join(created.dir, "review.json"), "utf8"),
    ).resolves.toContain('"sourceSession": "disabled:review"');
    await expect(
      readFile(path.join(created.dir, "comments.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("drops a current Review that uses removed code peek fields", async () => {
    const reviewHome = await tempDir();
    const sourceRoot = await gitRepository();
    const sourceCommit = execFileSync(
      "git",
      ["-C", sourceRoot, "rev-parse", "HEAD"],
      { encoding: "utf8" },
    ).trim();
    const created = await createReviewDir({
      reviewsHomePath: reviewHome,
      worktreePath: sourceRoot,
      baseRef: "main",
      baseCommit: sourceCommit,
      sourceCommit,
      sourceIdentity: { kind: "git-branch", name: "main" },
    });
    await writeFile(
      path.join(created.dir, "review.json"),
      `${JSON.stringify(created.review)}\n`,
    );
    await writeFile(
      path.join(created.dir, "data.ts"),
      [
        'import { defineAnchors } from "virtual:progressive-review-authoring";',
        "export const anchors = defineAnchors({",
        "  oldSymbol: {",
        '    title: "Old symbol",',
        '    peek: { symbol: "resolveThing" },',
        "  },",
        "  oldDeclaration: {",
        '    title: "Old declaration",',
        '    peek: { declarationId: "src/thing.ts::resolveThing" },',
        "  },",
        "});",
      ].join("\n"),
    );

    const log: string[] = [];
    await expect(
      migrateStoredReviewData({
        reviewHome,
        log: (message) => log.push(message),
      }),
    ).resolves.toMatchObject({
      documents: 0,
      droppedLegacyPeekReviews: 1,
      droppedReviews: 1,
    });
    expect(log).toContain(
      `Dropped Review ${created.review.uuid} with removed peek fields: declarationId, symbol.`,
    );
    await expect(
      readFile(path.join(created.dir, "review.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps range Reviews that only mention removed field names", async () => {
    const reviewHome = await tempDir();
    const sourceRoot = await gitRepository();
    const sourceCommit = execFileSync(
      "git",
      ["-C", sourceRoot, "rev-parse", "HEAD"],
      { encoding: "utf8" },
    ).trim();
    const created = await createReviewDir({
      reviewsHomePath: reviewHome,
      worktreePath: sourceRoot,
      baseRef: "main",
      baseCommit: sourceCommit,
      sourceCommit,
      sourceIdentity: { kind: "git-branch", name: "main" },
    });
    await writeFile(
      path.join(created.dir, "review.json"),
      `${JSON.stringify(created.review)}\n`,
    );
    await writeFile(
      path.join(created.dir, "data.ts"),
      [
        'import { defineAnchors } from "virtual:progressive-review-authoring";',
        "// symbol: and declarationId: are removed.",
        'const compatibility = "symbol: declarationId:";',
        "export const anchors = defineAnchors({",
        "  range: {",
        '    title: "Range",',
        '    peek: { file: "src/thing.ts", fromLine: 1, toLine: 2 },',
        "  },",
        "});",
        "void compatibility;",
      ].join("\n"),
    );

    await expect(
      migrateStoredReviewData({ reviewHome }),
    ).resolves.toMatchObject({
      documents: 1,
      droppedLegacyPeekReviews: 0,
      droppedReviews: 0,
    });
    await expect(
      readFile(path.join(created.dir, "review.json"), "utf8"),
    ).resolves.toContain(created.review.uuid);
  });
});

async function gitRepository(): Promise<string> {
  const root = await tempDir("review-migration-source-");
  execFileSync("git", ["init", "-b", "main", root], { stdio: "ignore" });
  execFileSync("git", [
    "-C",
    root,
    "config",
    "user.email",
    "review@example.test",
  ]);
  execFileSync("git", ["-C", root, "config", "user.name", "Review Test"]);
  await writeFile(path.join(root, "README.md"), "# Source\n");
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-m", "initial"], {
    stdio: "ignore",
  });
  return root;
}

async function tempDir(prefix = "review-migration-"): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}
