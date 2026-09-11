import { git, resolveRepoContext } from "@dev.fast/local-vcs";

/** One GitHub repository as `owner/repo`, shared by every trace store. */
export interface TraceRepo {
  owner: string;
  repo: string;
}

export function parseRepo(value: string): TraceRepo {
  const parts = value.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("Repository must be OWNER/REPO.");
  }
  return { owner: parts[0], repo: parts[1] };
}

export function traceRepoName(repo: TraceRepo): string {
  return `${repo.owner}/${repo.repo}`;
}

export async function inferRepoFromGit(cwd: string): Promise<TraceRepo> {
  if (process.env.GITHUB_REPOSITORY) {
    return parseRepo(process.env.GITHUB_REPOSITORY);
  }
  const slug = (await resolveRepoContext(cwd))?.githubSlug;
  if (slug) {
    return parseRepo(slug);
  }
  const result = await git(cwd, ["remote", "get-url", "origin"], {
    allowFailure: true,
  });
  if (result.ok && result.stdout.trim()) {
    const raw = result.stdout.trim();
    const match = /[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(raw);
    if (match && match[1] && match[2]) {
      return parseRepo(`${match[1]}/${match[2]}`);
    }
  }
  throw new Error("Could not infer GitHub repository from origin remote.");
}
