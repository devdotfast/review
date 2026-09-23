import type { LocalVcsCommitSummary } from "@dev.fast/local-vcs";

export interface WhiteboardCommitRefs {
  baseRef: string;
  headRef: string;
}

export function resolveWhiteboardCommitScope(
  commits: readonly LocalVcsCommitSummary[],
  commit: string,
): WhiteboardCommitRefs {
  const entry = commits.find((candidate) => candidate.commit === commit);

  if (!entry) {
    throw new Error("The commit is outside the pinned review range.");
  }

  return { baseRef: entry.parentCommit, headRef: entry.commit };
}
