import type { LocalVcsCommitSummary } from "@dev.fast/local-vcs";

export interface ReviewCommitRefs {
  baseRef: string;
  headRef: string;
}

export function resolveReviewCommitScope(
  commits: readonly LocalVcsCommitSummary[],
  commit: string,
): ReviewCommitRefs {
  const entry = commits.find((candidate) => candidate.commit === commit);
  if (!entry) {
    throw new Error("The commit is outside the pinned review range.");
  }
  return { baseRef: entry.parentCommit, headRef: entry.commit };
}
