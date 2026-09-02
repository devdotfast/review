import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { ReviewRepositoryIdentity } from "@dev.fast/review-protocol";

const execFilePromise = promisify(execFile);

export async function resolveReviewRepositoryIdentity(
  rootPath: string,
): Promise<ReviewRepositoryIdentity> {
  const worktreeRoot = await canonicalPath(rootPath);
  const jjRepoFile = path.join(worktreeRoot, ".jj", "repo");
  if (existsSync(jjRepoFile)) {
    const repositoryPath = await resolveJjRepositoryPath(jjRepoFile);
    return identity("jj", repositoryPath, worktreeRoot);
  }

  try {
    const { stdout } = await execFilePromise(
      "git",
      ["-C", worktreeRoot, "rev-parse", "--git-common-dir"],
      { maxBuffer: 1024 * 1024 },
    );
    const raw = stdout.trim();
    if (raw) {
      const repositoryPath = await canonicalPath(
        path.isAbsolute(raw) ? raw : path.resolve(worktreeRoot, raw),
      );
      return identity("git", repositoryPath, worktreeRoot);
    }
  } catch {
    // A non-VCS directory is still a valid Review root.
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
