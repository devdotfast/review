/** Seeds the schema-4 legacy review tarballs into a journey's isolated home. */
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { pickReview, sourcePackage, workspace } from "./harness.mjs";

const exec = promisify(execFile);

export const legacyRoot = path.join(
  sourcePackage,
  "src/fixtures/legacy-reviews",
);

async function seedLegacyFixture(ctx, fixture) {
  const { name, metadata } = fixture;
  const legacyDir = path.join(ctx.home, "reviews", metadata.sourceUuid);
  await mkdir(legacyDir, { recursive: true });
  await exec("tar", [
    "-xzf",
    path.join(legacyRoot, `${name}.tgz`),
    "-C",
    legacyDir,
  ]);
  let worktreePath = ctx.repo;

  if (metadata.sourceRepository === "devdotfast/review") {
    worktreePath = path.join(ctx.root, name);
    await exec("git", [
      "clone",
      "--no-hardlinks",
      "--no-checkout",
      "--quiet",
      workspace,
      worktreePath,
    ]);
    await exec("git", [
      "-C",
      worktreePath,
      "fetch",
      "--quiet",
      workspace,
      metadata.baseCommit,
      metadata.sourceCommit,
    ]);
  }

  const legacyRecordPath = path.join(legacyDir, "review.json");
  const original = JSON.parse(await readFile(legacyRecordPath, "utf8"));
  await writeFile(
    legacyRecordPath,
    JSON.stringify({ ...original, worktreePath }),
  );
  Object.assign(fixture, {
    legacyDir,
    worktreePath,
    legacyRecordPath,
    original,
  });
}

/** Extracts every legacy fixture into `ctx.home` and stashes them on `ctx.legacyFixtures`. */
export async function seedLegacyFixtures(ctx) {
  const legacyFixtures = [];

  for (const archive of (await readdir(legacyRoot))
    .filter((name) => name.endsWith(".tgz"))
    .sort()) {
    const name = archive.slice(0, -4);

    const metadata = JSON.parse(
      await readFile(path.join(legacyRoot, `${name}.json`), "utf8"),
    );

    const fixture = { name, metadata };

    await seedLegacyFixture(ctx, fixture);
    legacyFixtures.push(fixture);
  }

  ctx.legacyFixtures = legacyFixtures;

  return legacyFixtures;
}

/** Opens an imported fixture through the shared `review app pick` helper. */
export const openLegacyReview = (ctx, fixture) =>
  pickReview(ctx, fixture.metadata.sourceUuid, fixture.worktreePath);

/** Startup migrates the legacy directory before exposing the JSON catalog. */
export const waitForImport = (ctx, sessionId) =>
  ctx.until(async () => {
    await ctx.api("/reviews-api");
    const snapshot = await ctx.api(`/reviews-api/${sessionId}?full=true`);

    return snapshot.status === 200 ? snapshot.value : null;
  }, `${sessionId} imported`);
