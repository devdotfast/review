import type { WhiteboardDocumentVersionWire } from "@dev.fast/whiteboard-protocol";

import type { StoredWhiteboard } from "./whiteboard-home";
import { whiteboardVcs } from "./whiteboard-vcs";

const WHITEBOARD_PUBLISH_CANDIDATE_MESSAGE = "Review publish candidate";

/** Published document versions, newest first. */
export async function listWhiteboardDocumentVersions(
  review: StoredWhiteboard,
): Promise<WhiteboardDocumentVersionWire[]> {
  const current = review.review.presentedDocumentRevision;

  if (!current) return [];
  const entries = await whiteboardVcs.log(review.dir);
  const currentIndex = entries.findIndex((entry) => entry.oid === current);
  const presented = currentIndex === -1 ? entries : entries.slice(currentIndex);

  return presented
    .filter(
      (entry) =>
        entry.message === WHITEBOARD_PUBLISH_CANDIDATE_MESSAGE ||
        entry.oid === current,
    )
    .map((entry) => ({
      revision: entry.oid,
      sealedAt: entry.timestamp * 1000,
      isCurrent: entry.oid === current,
    }));
}
