import { execFileSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { REVIEW_SCHEMA_VERSION } from "@dev.fast/review-protocol";
import { afterEach, expect, it } from "vitest";

import { parseStoredReviewRecord } from "./review-home";
import { devReviewHome } from "./review-storage";
import {
  cleanupTempDirs,
  gitRepository,
  reviewHome,
  storedReviewFixture,
  tempDir,
  writeLegacyDocument,
} from "./review-test-utils";

afterEach(cleanupTempDirs);

it("removes every tracked directory and unstubs the review home", async () => {
  const dir = await tempDir("review-test-utils-");
  const home = await reviewHome();
  expect(devReviewHome()).toBe(home);

  await cleanupTempDirs();

  await expect(stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(home)).rejects.toMatchObject({ code: "ENOENT" });
  expect(devReviewHome()).not.toBe(home);
});

it("initializes a committed repository on the requested branch", async () => {
  const root = await gitRepository();
  const branched = await gitRepository({ initialBranch: "trunk" });

  const head = (branch: string) =>
    execFileSync("git", ["-C", branch, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
    }).trim();
  expect(head(root)).toBe("main");
  expect(head(branched)).toBe("trunk");
  expect(
    execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
  ).toMatch(/^[0-9a-f]{40}$/);
});

it("stages a promotable review directory at either stored schema", async () => {
  const current = await storedReviewFixture();
  expect(parseStoredReviewRecord(current.record).schemaVersion).toBe(
    REVIEW_SCHEMA_VERSION,
  );
  expect(
    await readFile(path.join(current.reviewDir, ".git", "HEAD"), "utf8"),
  ).toBe("old-head");
  expect((await readdir(path.dirname(current.reviewDir))).sort()).toEqual([
    "review",
  ]);

  const legacy = await storedReviewFixture({
    schemaVersion: 4,
    uuid: "22222222-2222-4222-8222-222222222222",
  });
  expect(legacy.record.schemaVersion).toBe(4);
  expect(legacy.record.uuid).toBe("22222222-2222-4222-8222-222222222222");
});

it("writes a v1 document bundle with an overridable module body", async () => {
  const { reviewDir } = await storedReviewFixture();
  await writeLegacyDocument(reviewDir, { code: "throw new Error('legacy');" });

  const bundle = path.join(reviewDir, ".bundle", "document");
  expect(
    JSON.parse(await readFile(path.join(bundle, "manifest.json"), "utf8")),
  ).toEqual({
    version: 1,
    routePath: "/",
    sourcePath: "review.mdx",
  });
  expect(await readFile(path.join(bundle, "review-document.js"), "utf8")).toBe(
    "throw new Error('legacy');",
  );

  await writeLegacyDocument(reviewDir);
  expect(
    await readFile(path.join(bundle, "review-document.js"), "utf8"),
  ).toContain("Exact sealed title");
});
