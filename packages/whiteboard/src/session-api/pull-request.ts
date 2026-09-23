import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";

import { type LocalVcsKind, parseGitRemoteSlug } from "@dev.fast/local-vcs";
import { errorMessage } from "@dev.fast/trace-core";
import { z } from "zod";

import { SessionInputError } from "./document.js";

/** Runs one subprocess and resolves its stdout; rejects on failure or timeout. */
export type RunCommand = (
  file: string,
  args: string[],
  options: { cwd?: string; timeoutMs: number },
) => Promise<string>;

export interface PullRequestDeps {
  run: RunCommand;
  fetch: typeof fetch;
}

/** What GitHub says about a PR; the commits are fetched separately. */
export interface PullRequestRecord {
  slug: string;
  number: number;
  title: string;
  baseRefName: string;
  /** GitHub's base commit, frozen at the PR's last update. */
  baseRefOid?: string;
}

const GH_TIMEOUT_MS = 20_000;

const API_TIMEOUT_MS = 15_000;

const FETCH_TIMEOUT_MS = 120_000;

const LOCAL_TIMEOUT_MS = 30_000;

export const defaultPullRequestDeps: PullRequestDeps = {
  run: (file, args, options) =>
    new Promise((resolve, reject) => {
      execFile(
        file,
        args,
        {
          cwd: options.cwd,
          timeout: options.timeoutMs,
          maxBuffer: 16 * 1024 * 1024,
          // Never wait on a credential or confirmation prompt nobody can see.
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: "0",
            GH_PROMPT_DISABLED: "1",
            GIT_SSH_COMMAND:
              process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
          },
        },
        (error, stdout, stderr) => {
          if (!error) return resolve(stdout);

          const reason = error.killed
            ? `timed out after ${options.timeoutMs / 1000}s`
            : String(stderr).trim() || error.message;

          reject(new Error(`${file} ${args[0]}: ${reason}`));
        },
      );
    }),
  fetch: (input, init) => fetch(input, init),
};

/** owner/repo and number from a canonical PR URL (validated by the command schema). */
export function pullRequestAddress(url: string) {
  const [, owner, repo, , number] = new URL(url).pathname.split("/");

  return { slug: `${owner}/${repo}`, number: Number(number) };
}

const metadataSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  baseRefName: z.string().min(1),
  baseRefOid: z.string().optional(),
});

/** gh first (it carries the user's auth), then GitHub's public REST API. */
export async function readPullRequest(
  url: string,
  deps: PullRequestDeps,
): Promise<PullRequestRecord> {
  const { slug, number } = pullRequestAddress(url);
  let ghFailure: string;

  try {
    const stdout = await deps.run(
      "gh",
      [
        "pr",
        "view",
        String(number),
        "--repo",
        slug,
        "--json",
        "number,title,baseRefName,baseRefOid",
      ],
      { timeoutMs: GH_TIMEOUT_MS },
    );

    return { slug, ...metadataSchema.parse(JSON.parse(stdout)) };
  } catch (error) {
    ghFailure = firstLine(errorMessage(error));
  }

  let response: Response;

  try {
    response = await deps.fetch(
      `https://api.github.com/repos/${slug}/pulls/${number}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      },
    );
  } catch (error) {
    throw unreadable(
      url,
      ghFailure,
      `the GitHub API is unreachable (${firstLine(errorMessage(error))})`,
    );
  }

  if (response.status === 404)
    throw new SessionInputError(
      `${url} was not found: it does not exist, or it is private and gh is not signed in to an account that can read it (run \`gh auth status\`). gh said: ${ghFailure}`,
      404,
    );

  if (response.status === 403 || response.status === 429)
    throw unreadable(
      url,
      ghFailure,
      response.headers.get("x-ratelimit-remaining") === "0" ||
        response.status === 429
        ? "the unauthenticated GitHub API rate limit is exhausted"
        : "the GitHub API refused the request",
    );

  if (!response.ok)
    throw unreadable(
      url,
      ghFailure,
      `the GitHub API returned HTTP ${response.status}`,
    );

  const parsed = z
    .object({
      number: z.number(),
      title: z.string(),
      base: z.object({ ref: z.string().min(1), sha: z.string() }),
    })
    .safeParse(await response.json().catch(() => undefined));

  if (!parsed.success)
    throw unreadable(url, ghFailure, "the GitHub API response was malformed");

  return {
    slug,
    number: parsed.data.number,
    title: parsed.data.title,
    baseRefName: parsed.data.base.ref,
    baseRefOid: parsed.data.base.sha,
  };
}

/** Remotes whose configured URL names a github.com repository, as owner/repo.
 * The configured URL, not the insteadOf rewrite: a mirror still names its repo. */
export async function githubRemotes(
  gitDir: string,
  deps: PullRequestDeps,
): Promise<{ name: string; slug: string }[]> {
  const stdout = await deps
    .run(
      "git",
      [
        "--git-dir",
        gitDir,
        "config",
        "--get-regexp",
        String.raw`^remote\..*\.url$`,
      ],
      { timeoutMs: LOCAL_TIMEOUT_MS },
    )
    .catch(() => "");

  return stdout.split("\n").flatMap((line) => {
    const match = /^remote\.(.+)\.url\s+(\S+)/.exec(line.trim());
    const slug = match && parseGitRemoteSlug(match[2]!);

    return match && slug ? [{ name: match[1]!, slug }] : [];
  });
}

/** Refs Review owns for one PR; the user's branches and bookmarks never move. */
export function pullRequestRefs(pr: { slug: string; number: number }) {
  const prefix = `refs/whiteboard/github/${pr.slug.toLowerCase()}/pull/${pr.number}`;

  return {
    head: `${prefix}/head`,
    base: `${prefix}/base`,
    frozenBase: `${prefix}/frozen-base`,
  };
}

/**
 * Fetch the PR head (refs/pull/N/head, so fork PRs work) and its base branch
 * into Review's own namespace, and return the comparison GitHub shows: the
 * head, and the merge base of the head with the base branch.
 *
 * A PR merged with a merge commit is absorbed: merge-base(base branch, head)
 * is the head itself and the diff is empty. GitHub freezes the base commit
 * (baseRefOid) at the PR's last update, so its merge base with the head is
 * the fork point GitHub diffs against, and it survives base branches that are
 * force-rebuilt or deleted.
 */
export async function fetchPullRequest(
  input: {
    rootPath: string;
    gitDir: string;
    kind: LocalVcsKind;
    remote: string;
    pullRequest: PullRequestRecord;
  },
  deps: PullRequestDeps,
): Promise<{ head: string; base: string }> {
  const { pullRequest: pr } = input;
  const refs = pullRequestRefs(pr);

  const git = (args: string[], timeoutMs = LOCAL_TIMEOUT_MS) =>
    deps
      .run("git", ["--git-dir", input.gitDir, ...args], { timeoutMs })
      .then((stdout) => stdout.trim());

  const fetchRefs = (...refspecs: string[]) =>
    git(
      [
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--quiet",
        input.remote,
        ...refspecs,
      ],
      FETCH_TIMEOUT_MS,
    );

  const commit = (ref: string) =>
    git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).catch(
      () => undefined,
    );

  const mergeBase = (left: string, right: string) =>
    git(["merge-base", left, right]).catch(() => undefined);

  const frozenBase = async () => {
    if (!pr.baseRefOid) return undefined;

    if (!(await commit(pr.baseRefOid)))
      await fetchRefs(`+${pr.baseRefOid}:${refs.frozenBase}`).catch(
        () => undefined,
      );

    return commit(pr.baseRefOid);
  };

  let baseTip: string | undefined;

  try {
    await fetchRefs(
      `+refs/pull/${pr.number}/head:${refs.head}`,
      `+refs/heads/${pr.baseRefName}:${refs.base}`,
    );
    baseTip = await commit(refs.base);
  } catch (error) {
    // The base branch may be gone; the head and the frozen base suffice.
    try {
      await fetchRefs(`+refs/pull/${pr.number}/head:${refs.head}`);
    } catch {
      throw new SessionInputError(
        `Could not fetch PR #${pr.number} from remote "${input.remote}" (${pr.slug}). Check \`git fetch ${input.remote}\` works with your Git credentials, then retry. Git said: ${firstLine(errorMessage(error))}`,
        409,
      );
    }
  }

  const head = await commit(refs.head);

  baseTip ??= await frozenBase();

  if (!head || !baseTip)
    throw new SessionInputError(
      `Fetched PR #${pr.number} but could not resolve its ${head ? `base branch ${pr.baseRefName}` : "head"}.`,
      409,
    );

  let base = await mergeBase(baseTip, head);

  if (!base || base === head) {
    const frozen = await frozenBase();

    if (frozen && frozen !== baseTip)
      base = (await mergeBase(frozen, head)) ?? base;
  }

  if (!base)
    throw new SessionInputError(
      `PR #${pr.number}'s head shares no history with ${pr.baseRefName}.`,
      409,
    );

  if (input.kind === "jj")
    await indexForJj(input.rootPath, [base, head], git, deps);

  return { head, base };
}

/**
 * jj resolves only commits in its index, and `jj git import` indexes only
 * branches, remote branches and tags. Import the commits through a
 * transient tag, then drop it: the commits stay indexed (hidden, resolvable
 * by commit id) and no bookmark or tag remains.
 */
async function indexForJj(
  rootPath: string,
  commits: string[],
  git: (args: string[]) => Promise<string>,
  deps: PullRequestDeps,
) {
  const tags = commits.map(() => `refs/tags/whiteboard-index-${randomUUID()}`);

  const jjImport = () =>
    deps.run(
      "jj",
      ["-R", rootPath, "git", "import", "--ignore-working-copy", "--quiet"],
      { cwd: rootPath, timeoutMs: LOCAL_TIMEOUT_MS },
    );

  try {
    for (const [index, tag] of tags.entries())
      await git(["update-ref", tag, commits[index]!]);
    await jjImport();
  } finally {
    for (const tag of tags)
      await git(["update-ref", "-d", tag]).catch(() => undefined);
    await jjImport().catch(() => undefined);
  }
}

function unreadable(url: string, ghFailure: string, fallback: string) {
  return new SessionInputError(
    `Could not read ${url}: gh failed (${ghFailure}) and ${fallback}. Run \`gh auth status\` and sign in with an account that can read the repository, then retry.`,
    409,
  );
}

function firstLine(text: string) {
  return text.split("\n")[0]!.slice(0, 300);
}
