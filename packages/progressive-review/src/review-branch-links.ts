import { git, parseGitRemote } from "@dev.fast/local-vcs";

export interface ReviewBranchLinks {
  baseUrl: string | null;
  headUrl: string | null;
}

type GitRunner = typeof git;

/**
 * Resolve review branch names to GitHub tree URLs only when a corresponding
 * remote-tracking ref exists locally. A local-only branch therefore remains
 * useful as a label without turning into a dead link.
 */
export async function resolveReviewBranchLinks(
  input: {
    rootPath: string;
    baseRef: string;
    headRef: string;
    pullRequestUrl?: string;
  },
  runGit: GitRunner = git,
): Promise<ReviewBranchLinks> {
  const [remoteResult, refsResult] = await Promise.all([
    runGit(input.rootPath, ["remote"], { allowFailure: true }),
    runGit(
      input.rootPath,
      ["for-each-ref", "--format=%(refname:strip=2)", "refs/remotes"],
      { allowFailure: true },
    ),
  ]);
  if (!remoteResult.ok || !refsResult.ok) return emptyBranchLinks();

  const remotes = nonEmptyLines(remoteResult.stdout);
  const refs = new Set(nonEmptyLines(refsResult.stdout));
  const candidates = {
    baseUrl: remoteBranch(input.baseRef, remotes, refs),
    headUrl: remoteBranch(input.headRef, remotes, refs),
  };
  const usedRemotes = new Set(
    [candidates.baseUrl, candidates.headUrl]
      .filter((value): value is RemoteBranch => value !== null)
      .map((value) => value.remote),
  );
  const remoteUrls = new Map<string, string>();
  await Promise.all(
    [...usedRemotes].map(async (remote) => {
      const result = await runGit(
        input.rootPath,
        ["remote", "get-url", remote],
        { allowFailure: true },
      );
      if (result.ok && result.stdout.trim()) {
        remoteUrls.set(remote, result.stdout.trim());
      }
    }),
  );
  const pullRequestHost = githubPullRequestHost(input.pullRequestUrl);
  return {
    baseUrl: githubTreeUrl(candidates.baseUrl, remoteUrls, pullRequestHost),
    headUrl: githubTreeUrl(candidates.headUrl, remoteUrls, pullRequestHost),
  };
}

interface RemoteBranch {
  remote: string;
  branch: string;
}

function remoteBranch(
  ref: string,
  remotes: readonly string[],
  remoteRefs: ReadonlySet<string>,
): RemoteBranch | null {
  let normalized = ref.replace(/^refs\/remotes\//u, "");
  normalized = normalized.replace(/^refs\/heads\//u, "");
  if (!normalized || normalized === "HEAD") return null;

  const explicitRemote = remotes.find((remote) =>
    normalized.startsWith(`${remote}/`),
  );
  const eligibleRemotes = explicitRemote ? [explicitRemote] : remotes;
  for (const remote of eligibleRemotes) {
    const branch = explicitRemote
      ? normalized.slice(`${remote}/`.length)
      : normalized;
    if (branch && branch !== "HEAD" && remoteRefs.has(`${remote}/${branch}`)) {
      return { remote, branch };
    }
  }
  return null;
}

function githubTreeUrl(
  target: RemoteBranch | null,
  remoteUrls: ReadonlyMap<string, string>,
  pullRequestHost: string | null,
): string | null {
  if (!target) return null;
  const parsed = parseGitRemote(remoteUrls.get(target.remote) ?? "");
  if (!parsed) return null;
  if (parsed.host !== "github.com" && parsed.host !== pullRequestHost) {
    return null;
  }
  const branchPath = target.branch
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `https://${parsed.host}/${parsed.slug}/tree/${branchPath}`;
}

function githubPullRequestHost(value?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return /^\/[^/]+\/[^/]+\/pull\/\d+(?:\/|$)/u.test(url.pathname)
      ? url.hostname.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

function nonEmptyLines(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function emptyBranchLinks(): ReviewBranchLinks {
  return { baseUrl: null, headUrl: null };
}
