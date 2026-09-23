import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, it, vi } from "vitest";

import {
  createReviewDir,
  readStoredReview,
  sealReviewCandidate,
} from "./review-home";
import { reviewVcs } from "./review-vcs";
import { migrateStoredReview } from "./stored-review-migration";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it.each(["document", "seal"])(
  "keeps the record unchanged until %s validation succeeds",
  async (failure) => {
    const { review, original } = await fixture(failure === "document");

    const failedSeal =
      failure === "seal"
        ? vi
            .spyOn(reviewVcs, "seal")
            .mockRejectedValue(new Error("candidate seal failed"))
        : undefined;

    await expect(
      migrateStoredReview({ reviewDir: review.dir }),
    ).rejects.toThrow(
      failure === "document" ? "broken document" : "candidate seal failed",
    );
    expect(await readFile(path.join(review.dir, "review.json"), "utf8")).toBe(
      original,
    );
    failedSeal?.mockRestore();
  },
);

it("binds the legacy authoring session as the source session", async () => {
  const { review } = await fixture();
  const migrated = await migrateStoredReview({ reviewDir: review.dir });

  expect(migrated.record.sourceSession).toBe("codex:original");
  expect(migrated.record.agentSessions?.["codex:original"]?.roles).toEqual([
    "author",
  ]);
  expect(await readStoredReview(review.dir)).toMatchObject({
    review: { sourceSession: "codex:original" },
  });
});

async function fixture(broken = false) {
  const home = await mkdtemp(path.join(tmpdir(), "review-source-migration-"));
  roots.push(home);
  vi.stubEnv("DEV_WHITEBOARD_HOME", home);
  const source = path.join(home, "source");
  await mkdir(source);

  const git = (args: string[]) =>
    execFileSync("git", ["-C", source, ...args], { encoding: "utf8" }).trim();

  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "review@example.test"]);
  git(["config", "user.name", "Review Test"]);
  await writeFile(path.join(source, "README.md"), "# Source\n");
  git(["add", "."]);
  git(["commit", "-qm", "source"]);
  const commit = git(["rev-parse", "HEAD"]);

  const review = await createReviewDir({
    worktreePath: source,
    baseRef: "main",
    baseCommit: commit,
    sourceCommit: commit,
    sourceIdentity: { kind: "git-branch", name: "main" },
  });

  const bundle = path.join(review.dir, ".bundle/document");
  await mkdir(bundle, { recursive: true });
  await writeFile(
    path.join(bundle, "manifest.json"),
    JSON.stringify({ version: 1, routePath: "/", sourcePath: "review.mdx" }),
  );
  await writeFile(
    path.join(bundle, "review-document.js"),
    broken
      ? 'import { jsx } from "review-doc-runtime"; throw new Error("broken document");'
      : legacyDocument,
  );
  const revision = await sealReviewCandidate(review.dir, "Legacy document");

  const original = JSON.stringify({
    ...review.review,
    schemaVersion: 3,
    agentSession: "codex:original",
    sourceSession: undefined,
    presentedDocumentRevision: revision,
  });

  await writeFile(path.join(review.dir, "review.json"), original);

  return { review, original };
}

const legacyDocument =
  'import { createActiveReviewDocument, jsx } from "review-doc-runtime"; export default createActiveReviewDocument({ title: "Legacy", routePath: "/", filePath: "review.mdx", modelNames: [], models: {}, Component: () => jsx("p", { children: "Legacy" }), isDefault: true });';
