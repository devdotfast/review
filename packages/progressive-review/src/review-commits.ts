import type { LocalVcsCommitSummary } from "@dev.fast/local-vcs";

export function resolveReviewCommitScope(
  commits: readonly LocalVcsCommitSummary[],
  commit: string,
): { baseRef: string; headRef: string } {
  const entry = commits.find((candidate) => candidate.commit === commit);
  if (!entry) {
    throw new Error("The commit is outside the pinned review range.");
  }
  return { baseRef: entry.parentCommit, headRef: entry.commit };
}
