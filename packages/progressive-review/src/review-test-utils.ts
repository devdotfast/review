import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { JsonObject } from "@dev.fast/review-protocol";
import { vi } from "vitest";

import { deleteReviewState } from "./review-state-db";

/**
 * One place for the filesystem scaffolding every Review test needs. Vitest runs
 * this package with `isolate: false` and `maxWorkers: 1`, so a stubbed env
 * variable outlives the file that set it: cleanupTempDirs unstubs as well as
 * deletes, and every suite that creates a directory here must call it.
 */
const trackedTempDirs: string[] = [];

const DEFAULT_STORED_REVIEW_UUID = "11111111-1111-4111-8111-111111111111";

const DEFAULT_LEGACY_DOCUMENT_CODE = `import { createActiveReviewDocument, jsx } from "review-doc-runtime";
export default createActiveReviewDocument({ title: "Sealed", routePath: "/", filePath: "review.mdx", modelNames: [], models: {}, Component: () => jsx("h1", { children: "Exact sealed title" }), isDefault: true });`;

export async function tempDir(prefix = "review-test-"): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  trackedTempDirs.push(dir);
  return dir;
}

export async function cleanupTempDirs(): Promise<void> {
  vi.unstubAllEnvs();
  await Promise.all(
    trackedTempDirs
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
}

export async function gitRepository(
  options: { initialBranch?: string } = {},
): Promise<string> {
  const root = await tempDir("review-test-source-");
  execFileSync(
    "git",
    ["-C", root, "init", "-b", options.initialBranch ?? "main"],
    { stdio: "pipe" },
  );
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  git("config", "user.email", "review@example.test");
  git("config", "user.name", "Review Test");
  await writeFile(path.join(root, "README.md"), "# Review\n", "utf8");
  git("add", ".");
  git("commit", "-m", "initial");
  return root;
}

export async function reviewHome(): Promise<string> {
  const home = await tempDir("review-test-home-");
  vi.stubEnv("DEV_REVIEW_HOME", home);
  return home;
}

/** A review directory whose `.git` and `.bundle` are promotable placeholders. */
export async function storedReviewFixture(
  options: { schemaVersion?: 4 | 5; uuid?: string } = {},
): Promise<{ reviewDir: string; record: JsonObject }> {
  const root = await tempDir("review-promotion-");
  const reviewDir = path.join(root, "review");
  await mkdir(path.join(reviewDir, ".git"), { recursive: true });
  await mkdir(path.join(reviewDir, ".bundle"));
  const record: JsonObject = {
    schemaVersion: options.schemaVersion ?? 5,
    uuid: options.uuid ?? DEFAULT_STORED_REVIEW_UUID,
    repoKey: "repo",
    worktreePath: "/source",
    baseRef: "main",
    baseCommit: "a".repeat(40),
    sourceCommit: "b".repeat(40),
    sourceIdentity: null,
    title: "Preserve",
    sourceSession: "disabled:review",
    status: "accepted",
    presentedDocumentRevision: "c".repeat(40),
    presentedSoftwareMapRevision: null,
    createdAt: "created",
    lastPublishedAt: "published",
    viewedAt: "viewed",
    dismissedAt: "dismissed",
  };
  await writeFile(path.join(reviewDir, "review.json"), JSON.stringify(record));
  await writeFile(path.join(reviewDir, ".git", "HEAD"), "old-head");
  await writeFile(path.join(reviewDir, ".bundle", "document"), "old-document");
  // Every fixture directory is named "review", so two fixtures in the same
  // test run share a database row unless it is cleared: drop any stray row
  // (from an earlier fixture, or this dir's own past life) before returning.
  deleteReviewState(reviewDir);
  return { reviewDir, record };
}

/** The pre-JSON `.bundle/document` shape: a v1 manifest and an ESM module. */
export async function writeLegacyDocument(
  reviewDir: string,
  options: { code?: string } = {},
): Promise<void> {
  const target = path.join(reviewDir, ".bundle/document");
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await writeFile(
    path.join(target, "manifest.json"),
    JSON.stringify({ version: 1, routePath: "/", sourcePath: "review.mdx" }),
  );
  await writeFile(
    path.join(target, "review-document.js"),
    options.code ?? DEFAULT_LEGACY_DOCUMENT_CODE,
  );
}
