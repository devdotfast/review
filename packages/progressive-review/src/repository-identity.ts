import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { gitAt } from "@dev.fast/local-vcs";
import type { ReviewRepositoryIdentity } from "@dev.fast/review-protocol";

export async function resolveReviewRepositoryIdentity(
  rootPath: string,
): Promise<ReviewRepositoryIdentity> {
  const worktreeRoot = await canonicalPath(rootPath);
  const jjRepoFile = path.join(worktreeRoot, ".jj", "repo");

  if (existsSync(jjRepoFile)) {
    const repositoryPath = await resolveJjRepositoryPath(jjRepoFile);

    return identity("jj", repositoryPath, worktreeRoot);
  }

  // A non-VCS directory is still a valid Review root: a failed rev-parse
  // falls through to the "none" identity.
  const result = await gitAt(worktreeRoot, ["rev-parse", "--git-common-dir"], {
    allowFailure: true,
  });

  const raw = result.ok ? result.stdout.trim() : "";

  if (raw) {
    const repositoryPath = await canonicalPath(
      path.isAbsolute(raw) ? raw : path.resolve(worktreeRoot, raw),
    );

    return identity("git", repositoryPath, worktreeRoot);
  }

  return identity("none", worktreeRoot, worktreeRoot);
}

async function resolveJjRepositoryPath(repoFile: string): Promise<string> {
  const info = await stat(repoFile);

  if (info.isDirectory()) return canonicalPath(repoFile);
  const target = (await readFile(repoFile, "utf8")).trim();

  if (!target) return canonicalPath(repoFile);

  return canonicalPath(path.resolve(path.dirname(repoFile), target));
}

function identity(
  kind: ReviewRepositoryIdentity["kind"],
  repositoryPath: string,
  worktreeRoot: string,
): ReviewRepositoryIdentity {
  return {
    kind,
    repositoryId: crypto
      .createHash("sha256")
      .update(`${kind}\0${repositoryPath}`)
      .digest("hex")
      .slice(0, 24),
    repositoryPath,
    worktreeRoot,
  };
}

async function canonicalPath(value: string): Promise<string> {
  const resolved = path.resolve(value);

  return realpath(resolved).catch(() => resolved);
}
