/* Builds the tutorial's shipped artifacts: a deterministic stubbed git repo
   (as `git-stub/`, because npm-packlist strips `.git` at any depth), the
   compiled review document bundle, and the software-map bundle. Runs at app
   build time; the desktop server serves these bytes without compiling,
   validating, or sealing anything on the user's machine. */
import { execFile } from "node:child_process";
import {
  chmod,
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { writeNote } from "@dev.fast/local-vcs";

import { writeReviewDocumentBundle } from "../src/review-bundle";
import { createReviewDir } from "../src/review-home";
import { evaluateReviewDocumentBundleForPublish } from "../src/review-publish-evaluate";
import { SOFTWARE_MAP_NOTES_REF } from "../src/review-storage";
import { compileReviewDocumentBundle } from "../src/server/doc-bundler";
import { canonicalizeModelImport } from "../src/software-map-artifact";
import {
  bundleReviewSoftwareMap,
  writeReviewSoftwareMapBundle,
} from "../src/software-map-bundle";
import { loadPublishSoftwareMaps } from "../src/software-map-health";

const execFilePromise = promisify(execFile);
const packageRoot = path.resolve(import.meta.dirname, "..");
const tutorialDir = path.join(packageRoot, "tutorial");

/* The commit hash must be identical on every build machine: the map-bundle
   manifest bakes it in, and the runtime checks the shipped repo's HEAD
   against that manifest. */
const COMMIT_ENV = {
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  TZ: "UTC",
};

export interface BuiltTutorialAssets {
  commit: string;
  peekCount: number;
}

export async function buildTutorialAssets(
  input: { outDir?: string } = {},
): Promise<BuiltTutorialAssets> {
  const outDir = input.outDir ?? tutorialDir;
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "review-tutorial-build-"),
  );
  try {
    // 1. Deterministic stub repository.
    const repo = path.join(temporaryRoot, "sample-service");
    await cp(path.join(tutorialDir, "sample-service"), repo, {
      recursive: true,
    });
    await git(repo, ["init", "--initial-branch=main"]);
    await git(repo, ["config", "user.name", "Review Tutorial"]);
    await git(repo, ["config", "user.email", "tutorial@review.local"]);
    await git(repo, ["add", "."]);
    await git(repo, [
      "commit",
      "--no-gpg-sign",
      "-m",
      "Create sample order service",
    ]);
    const commit = (await git(repo, ["rev-parse", "HEAD"])).trim();
    const count = (await git(repo, ["rev-list", "--count", "HEAD"])).trim();
    if (count !== "1") {
      throw new Error(`The tutorial repository must have one commit: ${count}`);
    }

    // 2. Software-map note, shipped inside the stub so the runtime
    // artifacts-refresh path keeps working.
    const mapSource = await readFile(
      path.join(tutorialDir, "software-map.ts"),
      "utf8",
    );
    await writeNote({
      rootPath: repo,
      ref: SOFTWARE_MAP_NOTES_REF,
      commit,
      content: canonicalizeModelImport(mapSource),
    });

    // 3. Compile from a throwaway review dir bound to the stub repo — the
    // compiler's software-map scan reads the store record beside the MDX.
    const review = await createReviewDir({
      reviewsHomePath: temporaryRoot,
      worktreePath: repo,
      baseRef: "main",
      baseCommit: commit,
      sourceCommit: commit,
      sourceIdentity: { kind: "git-branch", name: "main" },
    });
    await Promise.all([
      cp(
        path.join(tutorialDir, "review.mdx"),
        path.join(review.dir, "review.mdx"),
      ),
      cp(path.join(tutorialDir, "data.ts"), path.join(review.dir, "data.ts")),
    ]);
    const compiled = await compileReviewDocumentBundle({
      reviewPath: path.join(review.dir, "review.mdx"),
      reviewDocumentsDir: path.join(review.dir, ".review-documents"),
      reviewRootPath: review.dir,
      routePath: "/",
    });
    if (!compiled.bundle) {
      throw new Error(
        `Tutorial document compilation failed:\n${compiled.diagnostics.map((item) => item.message).join("\n")}`,
      );
    }

    // 4. The same validation publish runs, against the stub repository.
    const evaluation = await evaluateReviewDocumentBundleForPublish({
      bundleCode: compiled.bundle.code,
      reviewDir: review.dir,
      prepareEvidence: async () => ({
        head: { sourceRootPath: repo },
        base: { sourceRootPath: repo },
      }),
    });
    if (evaluation.errors.length > 0) {
      throw new Error(
        `Tutorial document evaluation failed:\n${evaluation.errors.join("\n")}`,
      );
    }
    if (evaluation.peekCount === 0) {
      throw new Error(
        "The tutorial document did not resolve any code evidence.",
      );
    }
    for (const peek of evaluation.rangePeeks) {
      const sourcePath = path.join(repo, peek.file);
      await stat(sourcePath);
      const lineCount = (await readFile(sourcePath, "utf8")).split(
        /\r?\n/,
      ).length;
      if (
        peek.fromLine < 1 ||
        peek.toLine < peek.fromLine ||
        peek.toLine > lineCount
      ) {
        throw new Error(
          `Tutorial range does not fit ${peek.file}: ${peek.fromLine}-${peek.toLine}.`,
        );
      }
    }

    // 5. Software-map bundle with the commit baked into its manifest.
    const maps = await loadPublishSoftwareMaps({
      repoRootPath: repo,
      baseCommit: commit,
      headCommit: commit,
    });
    if (maps.errors.length > 0 || !maps.base || !maps.head) {
      throw new Error(
        `The tutorial map did not resolve for both Review roles:\n${maps.errors.join("\n")}`,
      );
    }
    const mapBundle = bundleReviewSoftwareMap({
      head: maps.head,
      base: maps.base,
      headCommit: commit,
      baseCommit: commit,
    });

    // 6. Write outputs only after everything validated.
    await writeReviewDocumentBundle(outDir, compiled.bundle);
    await writeReviewSoftwareMapBundle(outDir, mapBundle);
    const gitStub = path.join(outDir, "git-stub");
    await rm(gitStub, { recursive: true, force: true });
    for (const entry of [
      "logs",
      "hooks",
      "dev-fast",
      "COMMIT_EDITMSG",
      "description",
    ]) {
      await rm(path.join(repo, ".git", entry), {
        recursive: true,
        force: true,
      });
    }
    // cp + rm instead of rename: the temp dir can sit on another filesystem.
    await cp(path.join(repo, ".git"), gitStub, { recursive: true });
    await makeTreeOwnerWritable(gitStub);

    return { commit, peekCount: evaluation.peekCount };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

/* Git makes loose objects read-only because their names are content hashes.
   The shipped copy is an application resource, where the bundle signature
   provides integrity. Squirrel must be able to remove macOS quarantine data
   from every resource before it installs an update. */
async function makeTreeOwnerWritable(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await makeTreeOwnerWritable(absolute);
      continue;
    }
    if (!entry.isFile()) continue;

    const current = await stat(absolute);
    if ((current.mode & 0o200) === 0) {
      await chmod(absolute, current.mode | 0o200);
    }
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFilePromise("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...COMMIT_ENV },
  });
  return stdout;
}

if (process.argv[1] === import.meta.filename) {
  const outFlag = process.argv.indexOf("--out");
  const outDir = outFlag >= 0 ? process.argv[outFlag + 1] : undefined;
  const built = await buildTutorialAssets({ outDir });
  process.stdout.write(
    `Tutorial assets built: commit ${built.commit}, ${built.peekCount} code ranges.\n`,
  );
}
