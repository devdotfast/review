import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { sessionIdSchema, uploadIdSchema } from "@dev.fast/trace-shared";
import { z } from "zod";

import { devReviewHome } from "./review-storage";
import { writePrivateJsonAtomic } from "./server/desktop-paths";
import type { TraceRepositoryTarget } from "./trace-repository-target";

const receiptSchema = z.object({
  sessionId: sessionIdSchema,
  uploadId: uploadIdSchema,
  confirmedAt: z.string().datetime(),
  omitted: z.object({
    subagents: z.array(z.string()),
    commits: z.number().int().nonnegative(),
  }),
});

export type UploadReceipt = z.infer<typeof receiptSchema>;

function directory(
  scope: string,
  target: TraceRepositoryTarget,
  devHome: string,
): string {
  // Scope is an origin/login digest, never a bearer token or a display name.
  if (
    !/^[a-f0-9]{64}$/.test(scope) ||
    !/^[a-f0-9]{32}$/.test(target.storeId) ||
    !Number.isSafeInteger(target.repositoryId) ||
    target.repositoryId < 1
  )
    throw new Error("Invalid receipt scope.");

  return path.join(
    devHome,
    "trace",
    "upload-receipts",
    scope,
    String(target.repositoryId),
    target.storeId,
  );
}

export async function saveUploadReceipt(
  input: UploadReceipt & {
    scope: string;
    target: TraceRepositoryTarget;
    devHome?: string;
  },
): Promise<void> {
  const receipt = receiptSchema.parse(input);
  await writePrivateJsonAtomic(
    path.join(
      directory(input.scope, input.target, input.devHome ?? devReviewHome()),
      `${receipt.uploadId}.json`,
    ),
    receipt,
  );
}

export async function listUploadReceipts(input: {
  scope: string;
  target: TraceRepositoryTarget;
  session?: string;
  devHome?: string;
}): Promise<UploadReceipt[]> {
  const dir = directory(
    input.scope,
    input.target,
    input.devHome ?? devReviewHome(),
  );

  const files = await readdir(dir).catch(() => []);
  const receipts: UploadReceipt[] = [];

  for (const file of files) {
    if (!/^[a-f0-9]{32}\.json$/.test(file)) continue;

    try {
      const receipt = receiptSchema.parse(
        JSON.parse(await readFile(path.join(dir, file), "utf8")),
      );

      if (input.session === undefined || receipt.sessionId === input.session)
        receipts.push(receipt);
    } catch {
      /* Ignore damaged local receipts. They are not server status. */
    }
  }

  return receipts.sort(
    (a, b) =>
      b.confirmedAt.localeCompare(a.confirmedAt) ||
      b.uploadId.localeCompare(a.uploadId),
  );
}
