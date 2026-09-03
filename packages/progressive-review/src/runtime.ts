import { spawn } from "node:child_process";
import path from "node:path";

import {
  type RepoContext,
  currentChangeIdentity,
  defaultBranchRef,
  detectLocalVcs,
  resolveRepoContext,
  resolveRevision,
} from "@dev.fast/local-vcs";

import { errorMessage } from "./error-message";
import { reviewMdxPath } from "./review-file";

const DEFAULT_REVIEW_ROUTE = "/";

export type ReviewSubject =
  | {
      baseRef: string;
      headRef?: string;
      pullRequestNumber?: undefined;
      pullRequestTitle?: undefined;
      pullRequestUrl?: undefined;
      routePath: typeof DEFAULT_REVIEW_ROUTE;
    }
  | {
      baseRef: string;
      headRef: string;
      pullRequestNumber: number;
      pullRequestTitle: string;
      pullRequestUrl?: string;
      routePath: string;
    };

export async function resolveReviewSubject(input: {
  cwd: string;
  baseRef?: string;
  headRef?: string;
  workingTreeHead?: boolean;
  pullRequest?: string;
  execFile: typeof execFilePromise;
  fetchImpl: typeof fetch;
}): Promise<ReviewSubject> {
  if (input.pullRequest) {
    const pr = await resolvePullRequestReviewSubject({
      cwd: input.cwd,
      value: input.pullRequest,
      execFile: input.execFile,
      fetchImpl: input.fetchImpl,
    });
    return {
      baseRef: input.baseRef?.trim() || pr.baseRef,
      headRef: pr.headRef,
      pullRequestNumber: pr.number,
      pullRequestTitle: pr.title,
      pullRequestUrl: pr.repo
        ? `https://github.com/${pr.repo}/pull/${pr.number}`
        : undefined,
      routePath: `/pr/${pr.number}`,
    };
  }

  if (input.workingTreeHead) {
    return {
      baseRef: input.baseRef?.trim() || (await defaultReviewBaseRef(input.cwd)),
      routePath: DEFAULT_REVIEW_ROUTE,
    };
  }

  const headRef = input.headRef?.trim();
  const refs = await resolveReviewRefs({
    cwd: input.cwd,
    baseRef: input.baseRef,
    headRef,
    execFile: input.execFile,
  });
  return {
    baseRef: refs.baseRef,
    headRef: refs.headRef,
    routePath: DEFAULT_REVIEW_ROUTE,
  };
}

export async function resolveReviewSource(input: {
  cwd: string;
  baseRef?: string;
  headRef?: string;
  pullRequest?: string;
}): Promise<{ reviewRoot: string; subject: ReviewSubject }> {
  const reviewRoot = await resolveReviewRoot(input.cwd);
  const subject = await resolveReviewSubject({
    cwd: reviewRoot,
    baseRef: input.baseRef,
    headRef: input.headRef,
    pullRequest: input.pullRequest,
    execFile: execFilePromise,
    fetchImpl: fetch,
  });
  return { reviewRoot, subject };
}

export async function resolveReviewRoot(
  cwd: string,
  execFile: typeof execFilePromise = execFilePromise,
): Promise<string> {
  const initialCwd = path.resolve(cwd);
  try {
    // cwd-based invocation: jj walks up from cwd like git does, while
    // `-R <subdir>` fails for a subdirectory of a workspace and would
    // silently fall back to git's cwd walk (the OUTER repo, for a
    // non-colocated jj workspace nested in another git repo).
    const { stdout } = await execFile("jj", ["root"], { cwd: initialCwd });
    const root = stdout.trim();
    if (root) return path.resolve(root);
  } catch {
    // Not a jj workspace, or jj is unavailable. Try Git below.
  }
  try {
    const { stdout } = await execFile("git", [
      "-C",
      initialCwd,
      "rev-parse",
      "--show-toplevel",
    ]);
    const root = stdout.trim();
    if (root) return path.resolve(root);
  } catch {
    // Non-VCS directories keep their original cwd for existing review behavior.
  }
  return initialCwd;
}

async function resolveReviewRefs(input: {
  cwd: string;
  baseRef?: string;
  headRef?: string;
  execFile: typeof execFilePromise;
}): Promise<{ baseRef: string; headRef: string }> {
  const headRef = input.headRef
    ? await resolveReviewHeadRef(input.cwd, input.headRef, input.execFile)
    : await defaultReviewHeadRef(input.cwd);
  const baseRef =
    input.baseRef?.trim() || (await defaultReviewBaseRef(input.cwd));
  return { baseRef, headRef };
}

async function defaultReviewHeadRef(cwd: string): Promise<string> {
  const identity = await currentChangeIdentity(cwd);
  if (identity) return identity.name;
  const vcs = await detectLocalVcs(cwd);
  return vcs?.kind === "jj" ? "@" : "HEAD";
}

// One default for both VCSes: the default branch by NAME, so scaffold pins
// the fork point against trunk (GitHub semantics) and every later update can
// re-derive it — a frozen fork-point SHA would absorb trunk history after a
// rebase. Reviews of a single stacked change opt in with --base @-. The
// fallbacks cover repos with no default branch at all.
async function defaultReviewBaseRef(cwd: string): Promise<string> {
  const name = await defaultBranchRef(cwd);
  if (name) return name;
  const vcs = await detectLocalVcs(cwd);
  return vcs?.kind === "jj" ? "@-" : "HEAD";
}

export async function resolvePullRequestReviewSubject(input: {
  cwd: string;
  value: string;
  execFile?: typeof execFilePromise;
  fetchImpl?: typeof fetch;
}): Promise<{
  number: number;
  title: string;
  repo?: string;
  baseRef: string;
  headRef: string;
}> {
  const execFile = input.execFile ?? execFilePromise;
  const fetchImpl = input.fetchImpl ?? fetch;
  const repoContext = await resolveRepoContext(input.cwd);
  if (!repoContext) {
    throw new Error(`No Git repository found at ${input.cwd}.`);
  }
  // A PR URL names its repository explicitly and outranks the origin remote
  // (reviewing someone else's PR from a fork checkout must hit THEIR repo).
  // When neither the URL nor origin yields a slug, omit -R entirely and let
  // gh resolve the repository itself rather than failing hard.
  const repoSlug =
    parseGithubPullRequestRepoSlug(input.value) ??
    repoContext.githubSlug ??
    undefined;
  let stdout: string | undefined;
  let parsed: PullRequestMetadata | undefined;
  try {
    ({ stdout } = await execFile(
      "gh",
      [
        "pr",
        "view",
        input.value,
        "--json",
        "number,title,baseRefName,baseRefOid",
        ...(repoSlug ? ["-R", repoSlug] : []),
      ],
      { cwd: input.cwd },
    ));
  } catch (error) {
    const pullRequestNumber = parseGithubPullRequestNumber(input.value);
    if (repoSlug && pullRequestNumber) {
      try {
        parsed = await fetchPublicGithubPullRequestMetadata({
          repoSlug,
          pullRequestNumber,
          fetchImpl,
        });
      } catch (fallbackError) {
        throw new Error(
          [
            `Unable to read pull request metadata with gh pr view for ${input.value}.`,
            `The unauthenticated public GitHub API fallback also failed: ${errorMessage(fallbackError)}`,
            "For private repositories or exhausted public API rate limits, run `gh auth status` and authenticate the GitHub CLI.",
            `Original gh error: ${errorMessage(error)}`,
          ].join("\n"),
        );
      }
    } else {
      throw new Error(
        [
          `Unable to read pull request metadata with gh pr view for ${input.value}.`,
          "Progressive review could not determine a public GitHub repository and numeric PR for an unauthenticated API fallback; run `gh auth status` for this host and ensure the CLI can access the repository.",
          `Original error: ${errorMessage(error)}`,
        ].join("\n"),
      );
    }
  }

  if (!parsed) {
    try {
      parsed = JSON.parse(stdout ?? "") as PullRequestMetadata;
    } catch (error) {
      throw new Error(
        `Unable to parse gh pr view output for ${input.value}: ${errorMessage(
          error,
        )}`,
      );
    }
  }
  if (typeof parsed.number !== "number") {
    throw new Error(
      `Could not resolve pull request number for ${input.value}.`,
    );
  }
  if (typeof parsed.baseRefName !== "string" || !parsed.baseRefName.trim()) {
    throw new Error(`Could not resolve base branch for PR ${parsed.number}.`);
  }

  const headRef = `refs/dev-fast/reviews/pr-${parsed.number}/head`;
  const preparedRefs = await preparePullRequestRefs({
    cwd: input.cwd,
    baseRefName: parsed.baseRefName,
    headRef,
    pullRequestNumber: parsed.number,
    baseRefOid:
      typeof parsed.baseRefOid === "string" && parsed.baseRefOid
        ? parsed.baseRefOid
        : undefined,
    repoContext,
    execFile,
  });

  return {
    number: parsed.number,
    title:
      typeof parsed.title === "string" && parsed.title.trim()
        ? parsed.title.trim()
        : `PR ${parsed.number}`,
    repo: repoSlug,
    baseRef: preparedRefs.baseRef,
    headRef: preparedRefs.headRef,
  };
}

// A merged PR whose head was absorbed into the base branch has
// merge-base(origin/base, head) == head, so a symbolic base yields an empty
// diff. GitHub's PR record freezes base.sha (gh: baseRefOid) at the PR's last
// update; merge-base(baseRefOid, head) is the fork point GitHub itself diffs
// against, and it survives base branches that are force-rebuilt (VSCodium's
// insider). Fetch the oid when the local clone no longer reaches it. Open and
// squash/rebase-merged PRs keep a diverged head and are unaffected.
async function resolveAbsorbedPullRequestBaseRef(input: {
  repoContext: RepoContext;
  baseRef: string;
  headRef: string;
  baseRefOid?: string;
  execFile: typeof execFilePromise;
}): Promise<string> {
  if (!input.baseRefOid) return input.baseRef;
  try {
    const [mergeBase, headCommit] = await Promise.all([
      gitStdout(input.execFile, input.repoContext, [
        "merge-base",
        input.baseRef,
        input.headRef,
      ]),
      gitStdout(input.execFile, input.repoContext, [
        "rev-parse",
        input.headRef,
      ]),
    ]);
    if (!mergeBase || !headCommit || mergeBase !== headCommit) {
      return input.baseRef;
    }
    try {
      await gitStdout(input.execFile, input.repoContext, [
        "cat-file",
        "-e",
        `${input.baseRefOid}^{commit}`,
      ]);
    } catch {
      await gitStdout(input.execFile, input.repoContext, [
        "fetch",
        "origin",
        input.baseRefOid,
      ]);
    }
    const pinnedBase = await gitStdout(input.execFile, input.repoContext, [
      "merge-base",
      input.baseRefOid,
      headCommit,
    ]);
    return pinnedBase || input.baseRef;
  } catch {
    return input.baseRef;
  }
}

async function gitStdout(
  execFile: typeof execFilePromise,
  repoContext: RepoContext,
  args: string[],
): Promise<string> {
  const { stdout } = await execFile("git", [
    "--git-dir",
    repoContext.commonDir,
    ...args,
  ]);
  return stdout.trim();
}

function parseGithubPullRequestRepoSlug(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.hostname !== "github.com") return undefined;
    const [, owner, repo, resource, number] = url.pathname.split("/");
    if (owner && repo && resource === "pull" && number) {
      return `${owner}/${repo.replace(/\.git$/, "")}`;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

interface PullRequestMetadata {
  number?: unknown;
  title?: unknown;
  baseRefName?: unknown;
  baseRefOid?: unknown;
}

function parseGithubPullRequestNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (/^[1-9]\d*$/.test(trimmed)) return Number(trimmed);
  try {
    const url = new URL(trimmed);
    if (url.hostname !== "github.com") return undefined;
    const [, , , resource, number] = url.pathname.split("/");
    if (resource !== "pull" || !number || !/^[1-9]\d*$/.test(number)) {
      return undefined;
    }
    return Number(number);
  } catch {
    return undefined;
  }
}

async function fetchPublicGithubPullRequestMetadata(input: {
  repoSlug: string;
  pullRequestNumber: number;
  fetchImpl: typeof fetch;
}): Promise<PullRequestMetadata> {
  const [owner, repo, ...rest] = input.repoSlug.split("/");
  if (!owner || !repo || rest.length > 0) {
    throw new Error(`Invalid GitHub repository slug: ${input.repoSlug}`);
  }
  const response = await input.fetchImpl(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${input.pullRequestNumber}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!response.ok) {
    throw new Error(
      `GitHub REST API returned HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
    );
  }
  const metadata = (await response.json()) as {
    number?: unknown;
    title?: unknown;
    base?: { ref?: unknown; sha?: unknown };
  };
  return {
    number: metadata.number,
    title: metadata.title,
    baseRefName: metadata.base?.ref,
    baseRefOid: metadata.base?.sha,
  };
}

async function preparePullRequestRefs(input: {
  cwd: string;
  baseRefName: string;
  headRef: string;
  pullRequestNumber: number;
  baseRefOid?: string;
  repoContext: RepoContext;
  execFile: typeof execFilePromise;
}): Promise<{ baseRef: string; headRef: string }> {
  const symbolicBaseRef = `origin/${input.baseRefName}`;
  let resolvedBaseRef = symbolicBaseRef;
  const fetchArgs = [
    "fetch",
    "origin",
    `+refs/heads/${input.baseRefName}:refs/remotes/origin/${input.baseRefName}`,
    `+refs/pull/${input.pullRequestNumber}/head:${input.headRef}`,
  ];
  try {
    await input.execFile("git", [
      "--git-dir",
      input.repoContext.commonDir,
      ...fetchArgs,
    ]);
  } catch (error) {
    if (!input.baseRefOid) {
      throw formatPullRequestFetchError({
        pullRequestNumber: input.pullRequestNumber,
        baseRefName: input.baseRefName,
        error,
      });
    }
    try {
      await input.execFile("git", [
        "--git-dir",
        input.repoContext.commonDir,
        "fetch",
        "origin",
        `+refs/pull/${input.pullRequestNumber}/head:${input.headRef}`,
      ]);
      await ensureGitCommitAvailable({
        repoContext: input.repoContext,
        commit: input.baseRefOid,
        execFile: input.execFile,
      });
      resolvedBaseRef = input.baseRefOid;
    } catch (fallbackError) {
      throw formatPullRequestFetchError({
        pullRequestNumber: input.pullRequestNumber,
        baseRefName: input.baseRefName,
        error: new Error(
          `${errorMessage(error)}\nFrozen base ${input.baseRefOid} fallback failed: ${errorMessage(fallbackError)}`,
        ),
      });
    }
  }

  const vcs = await detectLocalVcs(input.cwd);
  if (vcs?.kind === "jj") {
    await input.execFile("jj", ["-R", input.cwd, "git", "import"]);
    const [baseBranchCommit, headCommit] = await Promise.all([
      resolveGitDirCommit(
        input.repoContext.commonDir,
        resolvedBaseRef === symbolicBaseRef
          ? `refs/remotes/${symbolicBaseRef}`
          : resolvedBaseRef,
        input.execFile,
      ),
      resolveGitDirCommit(
        input.repoContext.commonDir,
        input.headRef,
        input.execFile,
      ),
    ]);
    let baseCommit = await resolveGitDirMergeBase(
      input.repoContext.commonDir,
      baseBranchCommit,
      headCommit,
      input.execFile,
    );
    if (
      resolvedBaseRef === symbolicBaseRef &&
      baseCommit === headCommit &&
      input.baseRefOid
    ) {
      // Same guard as the git path (resolveAbsorbedPullRequestBaseRef):
      // the frozen baseRefOid may be absent locally — verify it exists,
      // fetch it if not, and keep the symbolic base on any failure rather
      // than surfacing a merge-base error as a fetch failure.
      try {
        await ensureGitCommitAvailable({
          repoContext: input.repoContext,
          commit: input.baseRefOid,
          execFile: input.execFile,
        });
        baseCommit = await resolveGitDirMergeBase(
          input.repoContext.commonDir,
          input.baseRefOid,
          headCommit,
          input.execFile,
        );
      } catch {
        // Keep the absorbed-head base; an empty diff beats a hard failure.
      }
    }
    return { baseRef: baseCommit, headRef: headCommit };
  }
  const absorbedBase = await resolveAbsorbedPullRequestBaseRef({
    repoContext: input.repoContext,
    baseRef: resolvedBaseRef,
    headRef: input.headRef,
    baseRefOid: input.baseRefOid,
    execFile: input.execFile,
  });
  // Pin the review base to the fork point, matching the jj path above. For
  // a PR behind its base branch, the branch tip is not an ancestor of the
  // head: diffing against it drags in unrelated base-side changes, and a
  // base software-map note flushed onto it sits off the head's first-parent
  // line, so head hydration seeds from a stub instead of the base map.
  // (Idempotent for absorbed PRs — their base is already the fork point.)
  let pinnedBase = absorbedBase;
  try {
    const mergeBase = await gitStdout(input.execFile, input.repoContext, [
      "merge-base",
      absorbedBase,
      input.headRef,
    ]);
    if (mergeBase) pinnedBase = mergeBase;
  } catch {
    // Unrelated histories or a vanished ref: keep the resolved base.
  }
  return { baseRef: pinnedBase, headRef: input.headRef };
}

async function ensureGitCommitAvailable(input: {
  repoContext: RepoContext;
  commit: string;
  execFile: typeof execFilePromise;
}): Promise<void> {
  try {
    await gitStdout(input.execFile, input.repoContext, [
      "cat-file",
      "-e",
      `${input.commit}^{commit}`,
    ]);
  } catch {
    await gitStdout(input.execFile, input.repoContext, [
      "fetch",
      "origin",
      input.commit,
    ]);
  }
}

async function resolveGitDirMergeBase(
  gitDir: string,
  baseRef: string,
  headRef: string,
  execFile: typeof execFilePromise,
): Promise<string> {
  const { stdout } = await execFile("git", [
    "--git-dir",
    gitDir,
    "merge-base",
    baseRef,
    headRef,
  ]);
  return stdout.trim();
}

async function resolveGitDirCommit(
  gitDir: string,
  ref: string,
  execFile: typeof execFilePromise,
): Promise<string> {
  const { stdout } = await execFile("git", [
    "--git-dir",
    gitDir,
    "rev-parse",
    "--verify",
    `${ref}^{commit}`,
  ]);
  return stdout.trim();
}

function formatPullRequestFetchError(input: {
  pullRequestNumber: number;
  baseRefName: string;
  error: unknown;
}): Error {
  return new Error(
    [
      `Unable to fetch refs for PR ${input.pullRequestNumber} with git fetch origin.`,
      `Progressive review uses your existing git remote credentials; verify \`git fetch origin ${input.baseRefName}\` and your SSH/HTTPS credential setup, then retry.`,
      "If you are in a jj-only workspace, ensure it is backed by a Git remote that jj can import.",
      `Original error: ${errorMessage(input.error)}`,
    ].join("\n"),
  );
}

async function resolveReviewHeadRef(
  cwd: string,
  headRef: string,
  execFile: typeof execFilePromise,
): Promise<string> {
  if (await resolveRevision(cwd, headRef)) return headRef;
  const repoContext = await resolveRepoContext(cwd);
  if (!repoContext) {
    throw new Error(`Review head ref does not exist: ${headRef}`);
  }
  if (await gitRefExists(repoContext, headRef, execFile)) return headRef;
  if (!headRef.startsWith("origin/") && !headRef.startsWith("refs/")) {
    const originRef = `origin/${headRef}`;
    if (await gitRefExists(repoContext, originRef, execFile)) return originRef;
    await execFile("git", [
      "--git-dir",
      repoContext.commonDir,
      "fetch",
      "origin",
      `+refs/heads/${headRef}:refs/remotes/origin/${headRef}`,
    ]).catch(() => undefined);
    if (await gitRefExists(repoContext, originRef, execFile)) return originRef;
  }
  throw new Error(`Review head ref does not exist: ${headRef}`);
}

async function gitRefExists(
  repoContext: RepoContext,
  ref: string,
  execFile: typeof execFilePromise,
): Promise<boolean> {
  try {
    await execFile("git", [
      "--git-dir",
      repoContext.commonDir,
      "rev-parse",
      "--verify",
      `${ref}^{commit}`,
    ]);
    return true;
  } catch {
    return false;
  }
}

export function activeReviewMdxPath(rootPath: string): string {
  return reviewMdxPath(rootPath);
}

function execFilePromise(
  file: string,
  args: string[],
  options: { cwd?: string } = {},
): Promise<{ stdout: string }> {
  return execFileUntraced(file, args, options);
}

function execFileUntraced(
  file: string,
  args: string[],
  options: { cwd?: string } = {},
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve({ stdout });
      else reject(new Error(stderr.trim() || `${file} exited with ${code}`));
    });
  });
}
