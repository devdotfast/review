import type { Writable } from "node:stream";

import { listUploadsQuerySchema } from "@dev.fast/trace-shared";

import { StoreApiError, type StoreClient } from "./store-client";
import type { TraceRepo } from "./trace-repo";

/** A live, writer-authorized check of recorded uploads. */
export async function writeOwnUploadStatus(input: {
  repo: TraceRepo;
  client: StoreClient | null;
  stdout: Writable;
  session?: string;
  cursor?: string;
  limit?: number;
}): Promise<number> {
  const query = listUploadsQuerySchema.safeParse({
    session: input.session,
    cursor: input.cursor,
    limit: input.limit ?? 10,
  });

  if (!query.success) {
    input.stdout.write("Upload status: invalid session, cursor, or limit.\n");

    return 1;
  }

  if (!input.client) {
    input.stdout.write(
      "Upload status: not checked. Log in to the selected store.\n",
    );

    return 1;
  }

  const client = input.client;

  try {
    const store = await client.findStore({
      owner: input.repo.owner,
      name: input.repo.repo,
    });

    if (!store)
      throw new StoreApiError(
        "not_found",
        404,
        "This repository has no hosted trace store.",
      );

    if (store.status !== "active")
      throw new StoreApiError(
        "store_deleted",
        410,
        "This trace store was deleted.",
      );

    if (store.bytesStored !== undefined)
      input.stdout.write(`Stored bytes: ${store.bytesStored}\n`);
    const page = await client.listOwnUploads(store.repositoryId, query.data);

    if (page.storeId !== store.storeId)
      throw new StoreApiError(
        "store_deleted",
        410,
        "The trace store changed. Check status again.",
      );
    input.stdout.write("Your uploads (checked with the store):\n");

    if (page.uploads.length === 0)
      input.stdout.write("No upload found for this account.\n");

    for (const upload of page.uploads) {
      const label =
        upload.status === "pending"
          ? "Not completed"
          : upload.current
            ? "Uploaded"
            : "Uploaded, later replaced";

      input.stdout.write(
        `${upload.sessionId}: ${label} at ${upload.completedAt ?? upload.createdAt} (upload ${upload.uploadId}).\n`,
      );
    }

    if (page.nextCursor)
      input.stdout.write(
        `More uploads: run \`review trace status${input.session ? ` --session ${input.session}` : ""} --limit ${query.data.limit} --cursor ${page.nextCursor}\`.\n`,
      );

    return 0;
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error));
    input.stdout.write(`Upload status: not checked. ${cause.message}\n`);

    return 1;
  }
}
