import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { gitAt } from "@dev.fast/local-vcs";
import { normalizeGitHubRemote } from "@dev.fast/review-share-protocol";

import { type Pins, SessionInputError } from "../review-api/document.js";

/** Keep credential helpers but prevent the calling shell from redirecting Git's object store. */
export function sharedGit(cwd: string, args: string[]) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("GIT_") ||
        [
          "GIT_SSH",
          "GIT_SSH_COMMAND",
          "GIT_ASKPASS",
          "GIT_SSH_VARIANT",
        ].includes(key),
    ),
  );

  return gitAt(
    cwd,
    ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
    {
      env: { ...env, GIT_TERMINAL_PROMPT: "0" },
      timeout: 300_000,
    },
  );
}

function fetchError(stderr: string, publishing: boolean): SessionInputError {
  if (/not our ref|couldn't find remote ref|unadvertised object/i.test(stderr))
    return new SessionInputError(
      publishing
        ? "Push the reviewed commits to GitHub before sharing."
        : "The shared commits are no longer available on GitHub. Ask the sender to restore them, then retry.",
      409,
    );

  return new SessionInputError(
    "Could not fetch the GitHub repository. Check your connection and Git credentials for this repository, then retry.",
    409,
  );
}

/** Recipients need complete history; publication only checks that the commits exist. */
export async function fetchPinnedRepository(
  root: string,
  url: string,
  pins: Pick<Pins, "base" | "head">,
  publishing = false,
) {
  if (
    ![pins.base, pins.head].every((commit) =>
      /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit),
    )
  )
    throw new SessionInputError(
      "Sharing requires immutable base and head commits.",
    );
  await mkdir(root, { recursive: true, mode: 0o700 });
  await sharedGit(root, ["init", "--quiet"]);

  if (!publishing) {
    await sharedGit(root, ["config", "core.hooksPath", "/dev/null"]);
    await sharedGit(root, ["config", "core.fsmonitor", "false"]);
    await sharedGit(root, ["remote", "add", "origin", url]);
  }

  // Branch refs make Git reject non-commit objects during the fetch itself.
  const refs = publishing ? "refs/heads/review" : "refs/review";

  try {
    await sharedGit(root, [
      "fetch",
      "--no-tags",
      "--force",
      ...(publishing ? ["--depth=1", "--filter=tree:0"] : []),
      publishing ? url : "origin",
      `${pins.base}:${refs}/base`,
      `${pins.head}:${refs}/head`,
    ]);
  } catch (error) {
    throw fetchError(
      error instanceof Error && "stderr" in error ? String(error.stderr) : "",
      publishing,
    );
  }

  if (!publishing)
    for (const commit of [pins.base, pins.head])
      await sharedGit(root, ["cat-file", "-e", `${commit}^{commit}`]);
}

export async function repositoryReady(
  root: string,
  pins: Pick<Pins, "base" | "head">,
): Promise<boolean> {
  try {
    const head = await sharedGit(root, ["rev-parse", "HEAD"]);

    if (head.stdout.trim() !== pins.head) return false;

    for (const commit of [pins.base, pins.head])
      await sharedGit(root, ["cat-file", "-e", `${commit}^{commit}`]);

    return true;
  } catch {
    return false;
  }
}

export async function readShareRepository(root: string) {
  let cloneUrl: string;

  try {
    cloneUrl = normalizeGitHubRemote(
      (await sharedGit(root, ["remote", "get-url", "origin"])).stdout,
    );
  } catch {
    throw new SessionInputError("Sharing requires a GitHub origin remote.");
  }

  return { cloneUrl };
}

export async function verifyShareRepository(
  root: string,
  pins: Pins,
  repository?: { cloneUrl: string },
) {
  const { cloneUrl } = repository ?? (await readShareRepository(root));
  const temporary = await mkdtemp(path.join(tmpdir(), "review-share-check-"));

  try {
    await fetchPinnedRepository(temporary, cloneUrl, pins, true);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }

  return { cloneUrl };
}
