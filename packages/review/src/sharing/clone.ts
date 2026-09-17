import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { digestBytes } from "./export.js";
import type { SharedReviewStore } from "./import.js";

const exec = promisify(execFile);

const jobs = new Map<string, Promise<void>>();

const git = (cwd: string, args: string[]) =>
  exec(
    "git",
    [
      "-C",
      cwd,
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      ...args,
    ],
    {
      cwd,
      timeout: 300000,
      maxBuffer: 1024 * 1024,
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) =>
            !key.startsWith("GIT_") ||
            /^(GIT_SSH|GIT_ASKPASS|GIT_TERMINAL_PROMPT)/.test(key),
        ),
      ),
    },
  );

export async function cloneSharedRepository(
  store: SharedReviewStore,
  id: string,
) {
  const existing = jobs.get(id);

  if (existing) return existing;

  const job = (async () => {
    const { manifest, snapshot } = store.get(id);

    if (!manifest.repository)
      throw new Error("This share has no repository URL.");
    const parent = path.join(store.root, ".repositories");
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const repo = path.join(parent, id);

    try {
      await stat(path.join(repo, ".git"));
    } catch {
      await git(parent, [
        "clone",
        "--no-checkout",
        "--filter=blob:none",
        "--",
        manifest.repository.cloneUrl,
        repo,
      ]);
    }

    for (const side of ["base", "head"] as const) {
      const target = path.join(parent, `${id}-${side}`),
        commit = snapshot.pins[side];

      try {
        await git(repo, ["cat-file", "-e", `${commit}^{commit}`]);
      } catch {
        await git(repo, ["fetch", "origin", commit]);
      }

      let actual: string | undefined;

      try {
        actual = (await git(target, ["rev-parse", "HEAD"])).stdout.trim();
      } catch {
        /* Create the pinned checkout below. */
      }

      if (!actual)
        await git(repo, ["worktree", "add", "--detach", target, commit]);
      else if (actual !== commit)
        throw new Error("The attached checkout changed.");
    }
  })();

  jobs.set(id, job);

  try {
    await job;
  } finally {
    jobs.delete(id);
  }
}

/** Only return native files that still match the downloaded snapshot exactly. */
export async function attachedSource(
  store: SharedReviewStore,
  id: string,
  side: "base" | "head",
  file: string,
) {
  const { manifest } = store.get(id);

  const entry = manifest.files.find(
    (value) => value.side === side && value.file === file,
  );

  if (!entry?.object) return undefined;
  const root = path.join(store.root, ".repositories", `${id}-${side}`);

  try {
    const native = await realpath(path.join(root, file));
    const canonicalRoot = await realpath(root);

    if (!native.startsWith(canonicalRoot + path.sep)) return undefined;

    if (digestBytes(await readFile(native)) !== entry.object) return undefined;

    return { localPath: native, localRoot: canonicalRoot };
  } catch {
    return undefined;
  }
}

/** Wait for a clone already in progress before deleting all of its checkouts. */
export async function removeSharedRepository(
  store: SharedReviewStore,
  id: string,
) {
  await jobs.get(id)?.catch(() => {});

  for (const name of [`${id}-base`, `${id}-head`, id]) {
    await rm(path.join(store.root, ".repositories", name), {
      recursive: true,
      force: true,
    });
  }
}
