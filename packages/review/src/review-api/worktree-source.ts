import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { type LocalVcs, gitCommonDir } from "@dev.fast/local-vcs";

import { isMissingFileError } from "../fs-utils.js";
import { ReviewInputError } from "./document.js";
import type { ReviewStore } from "./store.js";

const exec = promisify(execFile);

export const EMPTY_SOURCE = "empty-worktree-baseline";

export interface WorktreeSource {
  commit: string;
  files: Record<string, { blob?: string; committed?: true; error?: string }>;
}

const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

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
    throw new ReviewInputError("Source symlink leaves the selected worktree.");
  const stat = await lstat(candidate);

  if (!stat.isFile())
    throw new ReviewInputError("Source is not a regular file.");

  return candidate;
}

/** No index writes, synthetic commits, checkout copies, or dependency preparation. */
export async function captureWorktree(
  store: ReviewStore,
  repositoryId: string,
  vcs: LocalVcs,
  previous?: { source: WorktreeSource; stamps: Map<string, string> },
) {
  const commit =
    (await vcs.resolveRevision(vcs.kind === "jj" ? "@" : "HEAD"))?.commit ??
    EMPTY_SOURCE;

  const gitDirectory =
    vcs.kind === "jj" ? await gitCommonDir(vcs.rootPath) : undefined;

  if (vcs.kind === "jj" && !gitDirectory)
    throw new ReviewInputError(
      "Working source requires a Git-backed jj repository.",
    );

  const gitArgs = gitDirectory
    ? ["--git-dir", gitDirectory, "--work-tree", vcs.rootPath]
    : [];

  const listed = (
    await exec(
      "git",
      [
        "-C",
        vcs.rootPath,
        ...gitArgs,
        "ls-files",
        "-z",
        "--others",
        "--exclude-standard",
        "--exclude=.jj/",
        ...(vcs.kind === "git" ? ["--cached"] : []),
      ],
      { maxBuffer: 32 * 1024 * 1024 },
    )
  ).stdout
    .split("\0")
    .filter(Boolean);

  const paths =
    vcs.kind === "jj" ? [...(await vcs.listTrackedFiles()), ...listed] : listed;

  const objects = new Map<string, string>();
  const modes = new Map<string, string>();
  let objectFormat = "sha1";

  if (commit !== EMPTY_SOURCE) {
    const [tree, format] = await Promise.all([
      exec(
        "git",
        [
          "-C",
          vcs.rootPath,
          ...gitArgs,
          "ls-tree",
          "-rz",
          "--full-tree",
          commit,
        ],
        {
          maxBuffer: 32 * 1024 * 1024,
        },
      ),
      exec("git", [
        "-C",
        vcs.rootPath,
        ...gitArgs,
        "rev-parse",
        "--show-object-format",
      ]),
    ]);

    objectFormat = format.stdout.trim();

    for (const entry of tree.stdout.split("\0")) {
      const match =
        /^(100\d+|120000|160000) (?:blob|commit) ([a-f0-9]+)\t([\s\S]+)$/.exec(
          entry,
        );

      if (match) {
        objects.set(match[3]!, match[2]!);
        modes.set(match[3]!, match[1]!);
      }
    }
  }

  // SAFETY: a null-prototype dictionary holds only entries created in this function.
  const files = Object.create(null) as WorktreeSource["files"];
  const source: WorktreeSource = { commit, files };
  const stamps = new Map<string, string>();

  for (const file of [...new Set(paths)].sort()) {
    try {
      if (modes.get(file) === "160000") {
        const status = await exec("git", [
          "--no-optional-locks",
          "-C",
          vcs.rootPath,
          ...gitArgs,
          "status",
          "--porcelain",
          "--ignore-submodules=none",
          "--",
          file,
        ]);

        source.files[file] = {
          error: "Submodule contents are not available as code references.",
        };

        if (!status.stdout.trim()) source.files[file]!.committed = true;
        continue;
      }

      const candidate = resolve(vcs.rootPath, file);

      const isLink =
        modes.get(file) === "120000" &&
        (await lstat(candidate)).isSymbolicLink();

      // A tracked symlink is Git's link text, never the contents of its target.
      const parent = isLink
        ? relative(
            await realpath(vcs.rootPath),
            await realpath(dirname(candidate)),
          )
        : "";

      if (
        isLink &&
        (isAbsolute(parent) || parent === ".." || parent.startsWith(`..${sep}`))
      )
        throw new ReviewInputError(
          "Source symlink leaves the selected worktree.",
        );

      const path = isLink
        ? candidate
        : await localSourcePath(vcs.rootPath, file);

      const stat = await lstat(path, { bigint: true });
      const stamp = `${path}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
      stamps.set(file, stamp);
      const retained = previous?.source.files[file];

      if (
        retained &&
        previous.source.commit === commit &&
        previous.stamps.get(file) === stamp
      ) {
        Object.defineProperty(source.files, file, {
          value: retained,
          enumerable: true,
          writable: true,
          configurable: true,
        });
        continue;
      }

      const bytes = isLink
        ? Buffer.from(await readlink(path))
        : await readFile(path);

      const error = bytes.includes(0)
        ? "Binary files cannot be used as code references."
        : undefined;

      const object = createHash(objectFormat)
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex");

      if (objects.get(file) === object) {
        source.files[file] = { committed: true, error };
        continue;
      }

      const blob = digest(
        Buffer.concat([Buffer.from(`${repositoryId}\0`), bytes]),
      );

      store.putResource(blob, repositoryId, "source", "text/plain", bytes);
      source.files[file] = { blob, error };
    } catch (error) {
      if (isMissingFileError(error)) continue;
      source.files[file] = {
        error:
          error instanceof ReviewInputError
            ? error.message
            : "Working file is unreadable.",
      };
    }
  }

  const bytes = JSON.stringify(source);
  const generation = digest(`${repositoryId}\0${bytes}`);
  store.putResource(
    generation,
    repositoryId,
    "source-tree",
    "application/json",
    Buffer.from(bytes),
  );

  return { generation, source, stamps };
}

export function retainedWorktree(
  store: ReviewStore,
  generation: string,
): WorktreeSource {
  // Written only by captureWorktree, not by the resource upload endpoint.
  const resource = store.resource(generation);

  if (resource.kind !== "source-tree")
    throw new ReviewInputError("Invalid source generation.");

  // SAFETY: source-tree resources are written only by captureWorktree, never caller uploads.
  return JSON.parse(Buffer.from(resource.data).toString()) as WorktreeSource;
}
