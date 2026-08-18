import fs from "node:fs";
import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

import * as git from "isomorphic-git";

const REVIEW_BRANCH = "refs/heads/main";
const REVIEW_AUTHOR = {
  name: "dev.fast Review",
  email: "review@dev.fast",
};
const GIT_OBJECT_ID_PATTERN = /^[0-9a-f]{40}$/i;

export interface ReviewVcsLogEntry {
  oid: string;
  message: string;
  /** Unix seconds from the commit author clock. */
  timestamp: number;
}

export interface ReviewVcs {
  init(dir: string): Promise<void>;
  seal(dir: string, message: string): Promise<string>;
  log(dir: string): Promise<ReviewVcsLogEntry[]>;
  resolve(dir: string, revision: string): Promise<string>;
  materialize(
    dir: string,
    revision: string,
    destinationPath: string,
  ): Promise<void>;
}

export const reviewVcs: ReviewVcs = {
  async init(dir) {
    await git.init({ fs, dir, defaultBranch: "main" });
  },

  async seal(dir, message) {
    await stageWorkingTree(dir);
    const parent = await resolveHead(dir);
    const timestamp = Math.floor(Date.now() / 1_000);
    return git.commit({
      fs,
      dir,
      ref: REVIEW_BRANCH,
      parent: parent ? [parent] : [],
      message,
      author: { ...REVIEW_AUTHOR, timestamp },
      committer: { ...REVIEW_AUTHOR, timestamp },
    });
  },

  async log(dir) {
    let commits: Awaited<ReturnType<typeof git.log>>;
    try {
      commits = await git.log({ fs, dir, ref: REVIEW_BRANCH });
    } catch {
      return [];
    }
    return commits.map((entry) => ({
      oid: entry.oid,
      message: entry.commit.message.trim(),
      timestamp: entry.commit.author.timestamp,
    }));
  },

  async resolve(dir, revision) {
    return resolveCommit(dir, revision);
  },

  async materialize(dir, revision, destinationPath) {
    const commitId = await resolveCommit(dir, revision);
    await rm(destinationPath, { recursive: true, force: true });
    await mkdir(destinationPath, { recursive: true });
    await git.walk({
      fs,
      dir,
      trees: [git.TREE({ ref: commitId })],
      map: async (filepath, [entry]) => {
        if (!entry || filepath === ".") return;
        const type = await entry.type();
        if (type === "tree") return;
        if (type === "commit") {
          throw new Error(
            `Cannot materialize Git submodule at ${filepath} from review ${commitId}.`,
          );
        }
        if (type === "special") {
          throw new Error(
            `Cannot materialize special file at ${filepath} from review ${commitId}.`,
          );
        }
        const content = await entry.content();
        if (!content) {
          throw new Error(
            `Review ${commitId} has no blob content for ${filepath}.`,
          );
        }
        const outputPath = path.join(destinationPath, filepath);
        await mkdir(path.dirname(outputPath), { recursive: true });
        const mode = await entry.mode();
        if (mode === 0o120000) {
          if (process.platform === "win32") {
            throw new Error(
              "Review symlink materialization is unsupported on Windows.",
            );
          }
          await symlink(Buffer.from(content).toString("utf8"), outputPath);
          return;
        }
        await writeFile(outputPath, content);
        if (mode === 0o100755) await chmod(outputPath, 0o755);
      },
    });
  },
};

async function stageWorkingTree(dir: string): Promise<void> {
  const rows = await git.statusMatrix({ fs, dir });
  await Promise.all(
    rows.map(([filepath, , worktreeStatus]) =>
      worktreeStatus === 0
        ? git.remove({ fs, dir, filepath })
        : git.add({ fs, dir, filepath }),
    ),
  );
}

async function resolveHead(dir: string): Promise<string | null> {
  try {
    return await git.resolveRef({ fs, dir, ref: "HEAD" });
  } catch {
    return null;
  }
}

async function resolveCommit(dir: string, revision: string): Promise<string> {
  const commitId = GIT_OBJECT_ID_PATTERN.test(revision)
    ? revision.toLowerCase()
    : await git.resolveRef({ fs, dir, ref: revision });
  await git.readCommit({ fs, dir, oid: commitId });
  return commitId;
}
