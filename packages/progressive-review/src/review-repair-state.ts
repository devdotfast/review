import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, readlink } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  readReviewThreadsReadOnly,
  reviewThreadDbPath,
} from "./review-thread-store-backend";

const revisionSchema = z.string().regex(/^[0-9a-f]{40}$/);
export const ReviewRepairReadyRequestSchema = z.strictObject({
  reviewUuid: z.uuid(),
  stagingDir: z.string().min(1),
  expectedRecord: z.string().min(1),
  expectedFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  newDocumentRevision: revisionSchema,
  newMapRevision: revisionSchema.nullable(),
  sourceFallback: z.strictObject({ document: z.boolean(), map: z.boolean() }),
});
export type ReviewRepairReadyRequest = z.infer<
  typeof ReviewRepairReadyRequestSchema
>;

/** Only durable authoring, candidates, and private history participate. */
export function includeReviewRepairInput(relative: string): boolean {
  const top = relative.split(path.sep)[0];
  return (
    top !== ".build" &&
    top !== ".native-agent" &&
    !/^review\.db(?:-|$)/.test(top ?? "") &&
    top !== ".agent-sessions.lock"
  );
}

export async function fingerprintReviewRepairInputs(
  dir: string,
): Promise<string> {
  const digest = createHash("sha256");
  const walk = async (relative: string): Promise<void> => {
    const entries = await readdir(path.join(dir, relative), {
      withFileTypes: true,
    });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const name = path.join(relative, entry.name);
      if (!includeReviewRepairInput(name)) continue;
      digest.update(`${name}\0`);
      if (entry.isDirectory()) {
        digest.update("directory\0");
        await walk(name);
      } else if (entry.isSymbolicLink())
        digest.update(`link\0${await readlink(path.join(dir, name))}\0`);
      else {
        digest.update("file\0");
        digest.update(await readFile(path.join(dir, name)));
        digest.update("\0");
      }
    }
  };
  await walk("");
  return digest.digest("hex");
}

/** Unanswered agent-directed inputs can still mutate authored files. Ordinary
 * open reviewer threads are intentionally not a repair gate. */
export function assertNoActiveReviewAgentWrites(dir: string): void {
  const reviewPath = path.join(dir, "review.mdx");
  if (!existsSync(reviewThreadDbPath(reviewPath))) return;
  const snapshot = readReviewThreadsReadOnly(reviewPath);
  const threads = [
    ...Object.values(snapshot.comments),
    ...Object.values(snapshot.drafts).map((draft) => draft.thread),
  ];
  if (
    threads.some((thread) => {
      const lastInput = thread.messages.reduce(
        (index, message, current) =>
          message.agentInput && message.role !== "agent" ? current : index,
        -1,
      );
      return (
        lastInput >= 0 &&
        !thread.messages
          .slice(lastInput + 1)
          .some((message) => message.role === "agent")
      );
    })
  )
    throw new Error(
      "Review repair is blocked by pending agent writes; wait for the active agent response to finish, then retry.",
    );
}
