import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, readlink } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { isDerivedReviewPath } from "./review-derived-paths";
import {
  hasPendingReviewAgentWrites,
  reviewThreadDbPath,
} from "./review-thread-store-backend";

const revisionSchema = z.string().regex(/^[0-9a-f]{40}$/);
export const ReviewRepairReadyRequestSchema = z.strictObject({
  reviewUuid: z.uuid(),
  stagingDir: z.string().min(1),
  expectedRecord: z.string().min(1),
  expectedFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  expectedThreadDbFingerprint: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  newDocumentRevision: revisionSchema,
  newMapRevision: revisionSchema.nullable(),
  sourceFallback: z.strictObject({ document: z.boolean(), map: z.boolean() }),
});
export type ReviewRepairReadyRequest = z.infer<
  typeof ReviewRepairReadyRequestSchema
>;

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
      if (isDerivedReviewPath(name.split(path.sep)[0] ?? "")) continue;
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
  if (hasPendingReviewAgentWrites(reviewPath))
    throw new Error(
      "Review repair is blocked by pending agent writes; wait for the active agent response to finish, then retry.",
    );
}
