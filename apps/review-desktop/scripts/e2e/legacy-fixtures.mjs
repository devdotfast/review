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

/** Windows' own bsdtar reads a drive-letter path as a path; a Git for Windows tar earlier on PATH would read it as a remote host. */
const tar =
  process.platform === "win32"
    ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "tar";

/** The repository the fixtures' commits are fetched from: this checkout, or the git store behind a secondary jj workspace, which has no `.git` of its own. */
async function fixtureCommitSource() {
  try {
    await exec("git", ["-C", workspace, "rev-parse", "--git-dir"]);

    return workspace;
  } catch {
    const { stdout } = await exec(
      "jj",
      ["--ignore-working-copy", "git", "root"],
      { cwd: workspace },
    );

    return stdout.trim();
  }
}

async function seedLegacyFixture(ctx, fixture) {
  const { name, metadata } = fixture;
  const legacyDir = path.join(ctx.home, "reviews", metadata.sourceUuid);
  await mkdir(legacyDir, { recursive: true });
  await exec(tar, [
    "-xzf",
    path.join(legacyRoot, `${name}.tgz`),
    "-C",
    legacyDir,
  ]);
  let worktreePath = ctx.repo;

  if (metadata.sourceRepository === "devdotfast/review") {
    const source = await fixtureCommitSource();

    worktreePath = path.join(ctx.root, name);
    await exec("git", [
      "clone",
      "--no-hardlinks",
      "--no-checkout",
      "--quiet",
      source,
      worktreePath,
    ]);
    await exec("git", [
      "-C",
      worktreePath,
      "fetch",
      "--quiet",
      source,
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

/** Opens an imported fixture through the shared `whiteboard app pick` helper. */
export const openLegacyReview = (ctx, fixture) =>
  pickReview(ctx, fixture.metadata.sourceUuid, fixture.worktreePath);

/** Startup migrates the legacy directory before exposing the JSON catalog. */
export const waitForImport = (ctx, reviewId) =>
  ctx.until(async () => {
    await ctx.api("/reviews-api");
    const snapshot = await ctx.api(`/reviews-api/${reviewId}?full=true`);

    return snapshot.status === 200 ? snapshot.value : null;
  }, `${reviewId} imported`);
