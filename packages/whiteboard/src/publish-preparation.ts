import { actionableWhiteboardsForCheckout } from "./whiteboard-change-scope";
import {
  type StoredWhiteboard,
  findScopedWhiteboard,
  listWhiteboards,
} from "./whiteboard-home";

export async function resolvePublishWhiteboard(
  cwd: string,
  sessionId: string | undefined,
  options: { includeTerminal?: boolean } = {},
): Promise<StoredWhiteboard> {
  if (sessionId) {
    const selected = await findScopedWhiteboard(sessionId, {
      worktreePath: cwd,
      includeTerminal: options.includeTerminal,
    });

    if (!selected) throw new Error(`Active session not found: ${sessionId}`);

    return selected;
  }

  const listed = await listWhiteboards({
    worktreePath: cwd,
    reportUnreadableWhiteboards: true,
  });

  if (listed.errors.length > 0) {
    throw new Error(
      `Could not read reviews:\n${listed.errors.map((error) => `${error.whiteboardDir}: ${error.message}`).join("\n")}`,
    );
  }

  const publishable = listed.reviews.filter(
    (review) =>
      review.review.status !== "accepted" &&
      review.review.status !== "rejected",
  );

  const scoped = await actionableWhiteboardsForCheckout(publishable, cwd);

  if (scoped.length === 0) {
    throw new Error(
      "No active session found for the checked-out change. Pass --session <uuid>.",
    );
  }

  if (scoped.length > 1) {
    throw new Error("Multiple active sessions require --session <uuid>.");
  }

  return scoped[0]!;
}
