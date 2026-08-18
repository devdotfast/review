import { parseGitRemoteSlug, resolveRepoContext } from "@dev.fast/local-vcs";

// Compatibility surface for review callers. Repository identity itself is
// resolved once in local-vcs through the jj-first shared Git directory.
export async function resolveGithubRepoSlug(
  rootPath: string,
): Promise<string | undefined> {
  return (await resolveRepoContext(rootPath))?.githubSlug ?? undefined;
}

export function parseGithubRemoteSlug(remote: string): string | undefined {
  return parseGitRemoteSlug(remote) ?? undefined;
}

export { resolveRepoContext } from "@dev.fast/local-vcs";
