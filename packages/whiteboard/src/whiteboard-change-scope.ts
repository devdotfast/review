import { currentHead } from "@dev.fast/local-vcs";

import { resolveWhiteboardHeadRelationship } from "./whiteboard-head-relationship";
import type { StoredWhiteboard } from "./whiteboard-home";

const POSITIONAL_REFS = new Set(["@", "HEAD"]);

/**
 * The actionable reviews for the checked-out unit of change: non-terminal,
 * with the checkout at or descended from the review's head. Terminal reviews
 * are history: every ancestor change's accepted review would otherwise
 * accumulate forever. Legacy positional identities ("@", "HEAD") name no unit,
 * so they match on their pinned commit instead. A directory with no repository
 * cannot scope by change, so it keeps the full list.
 */
export async function actionableWhiteboardsForCheckout(
  reviews: readonly StoredWhiteboard[],
  whiteboardRoot: string,
): Promise<StoredWhiteboard[]> {
  const checkout = await currentHead(whiteboardRoot);

  if (!checkout) return [...reviews];

  const matches = await Promise.all(
    reviews.map(async (stored) => {
      if (
        stored.review.status === "accepted" ||
        stored.review.status === "rejected"
      ) {
        return false;
      }

      return whiteboardMatchesCheckout(stored, whiteboardRoot);
    }),
  );

  return reviews.filter((_, index) => matches[index]);
}

export async function whiteboardMatchesCheckout(
  stored: StoredWhiteboard,
  whiteboardRoot: string,
): Promise<boolean> {
  const identity = stored.review.sourceIdentity?.name;

  const headRef =
    !identity || POSITIONAL_REFS.has(identity)
      ? stored.review.sourceCommit
      : identity;

  if (!headRef) return false;

  const relationship = await resolveWhiteboardHeadRelationship({
    rootPath: whiteboardRoot,
    headRef,
  });

  return relationship.kind === "exact" || relationship.kind === "descendant";
}
