import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { type LocalVcs, gitCommonDir } from "@dev.fast/local-vcs";

import { isMissingFileError } from "../fs-utils.js";
import { SessionInputError } from "./document.js";

const exec = promisify(execFile);

export const EMPTY_SOURCE = "empty-worktree-baseline";

/** Never follow a working-copy link outside the selected checkout. */
export async function localSourcePath(
  root: string,
  file: string,
): Promise<string> {
  const canonicalRoot = await realpath(root);
  const candidate = await realpath(resolve(canonicalRoot, file));
  const child = relative(canonicalRoot, candidate);

  if (
    !child ||
    isAbsolute(child) ||
    child === ".." ||
    child.startsWith(`..${sep}`)
  )
    throw new SessionInputError("Source symlink leaves the selected worktree.");
  const stat = await lstat(candidate);

  if (!stat.isFile())
    throw new SessionInputError("Source is not a regular file.");

  return candidate;
}

/** List the live checkout, including untracked files but excluding ignored files. */
export async function workingFiles(vcs: LocalVcs): Promise<string[]> {
  const gitDirectory =
    vcs.kind === "jj" ? await gitCommonDir(vcs.rootPath) : undefined;

  if (vcs.kind === "jj" && !gitDirectory)
    throw new SessionInputError(
      "Working source requires a Git-backed jj repository.",
    );

  const { stdout } = await exec(
    "git",
    [
      "-C",
      vcs.rootPath,
      ...(gitDirectory
        ? ["--git-dir", gitDirectory, "--work-tree", vcs.rootPath]
        : []),
      "ls-files",
      "-z",
      "--others",
      "--exclude-standard",
      "--exclude=.jj/",
      ...(vcs.kind === "git" ? ["--cached"] : []),
    ],
    { maxBuffer: 32 * 1024 * 1024 },
  );

  const paths = [
    ...new Set([
      ...stdout.split("\0").filter(Boolean),
      ...(vcs.kind === "jj" ? await vcs.listTrackedFiles() : []),
    ]),
  ].sort();

  const present = await Promise.all(
    paths.map(async (file) => {
      try {
        await lstat(resolve(vcs.rootPath, file));

        return file;
      } catch (error) {
        if (isMissingFileError(error)) return undefined;
        throw error;
      }
    }),
  );

  return present.filter((file): file is string => file !== undefined);
}

/** A refresh token, not stored source: all reads still use the checkout. */
export async function inspectWorktree(repositoryId: string, vcs: LocalVcs) {
  const commit =
    (await vcs.resolveRevision(vcs.kind === "jj" ? "@" : "HEAD"))?.commit ??
    EMPTY_SOURCE;

  const hash = createHash("sha256").update(`${repositoryId}\0${commit}`);

  for (const file of await workingFiles(vcs)) {
    try {
      const info = await lstat(resolve(vcs.rootPath, file), { bigint: true });
      hash.update(
        `\0${file}\0${info.ino}:${info.size}:${info.mode}:${info.mtimeNs}:${info.ctimeNs}`,
      );
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
  }

  return { revision: hash.digest("hex"), commit };
}

export async function readWorkingFile(
  root: string,
  file: string,
): Promise<string | null> {
  try {
    const candidate = resolve(root, file);

    // Match Git's representation of tracked links, never read their target bytes.
    const parent = relative(
      await realpath(root),
      await realpath(dirname(candidate)),
    );

    if (isAbsolute(parent) || parent === ".." || parent.startsWith(`..${sep}`))
      throw new SessionInputError(
        "Source symlink leaves the selected worktree.",
      );

    if ((await lstat(candidate)).isSymbolicLink()) return readlink(candidate);

    return await readFile(await localSourcePath(root, file), "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}
