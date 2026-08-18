import { currentHead, mergeBase, resolveRevision } from "@dev.fast/local-vcs";

export type ReviewHeadRelationship =
  | {
      kind: "exact" | "descendant" | "mismatch";
      pinnedCommit: string;
      checkoutCommit: string;
    }
  | {
      kind: "unresolved";
      pinnedCommit: string | null;
      checkoutCommit: string | null;
    };

export async function resolveReviewHeadRelationship(input: {
  rootPath: string;
  headRef: string;
}): Promise<ReviewHeadRelationship> {
  const [pinnedHead, checkout] = await Promise.all([
    resolveRevision(input.rootPath, input.headRef).catch(() => null),
    currentHead(input.rootPath).catch(() => null),
  ]);
  if (!pinnedHead || !checkout) {
    return {
      kind: "unresolved",
      pinnedCommit: pinnedHead?.commit ?? null,
      checkoutCommit: checkout?.commit ?? null,
    };
  }
  if (pinnedHead.commit === checkout.commit) {
    return {
      kind: "exact",
      pinnedCommit: pinnedHead.commit,
      checkoutCommit: checkout.commit,
    };
  }
  const ancestor = await mergeBase({
    rootPath: input.rootPath,
    baseRef: pinnedHead.commit,
    headRef: checkout.commit,
  }).catch(() => null);
  return {
    kind: ancestor?.commit === pinnedHead.commit ? "descendant" : "mismatch",
    pinnedCommit: pinnedHead.commit,
    checkoutCommit: checkout.commit,
  };
}
