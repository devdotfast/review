import type { Writable } from "node:stream";

import { listUploadsQuerySchema } from "@dev.fast/trace-shared";

import { StoreApiError, type StoreClient } from "./store-client";
import { inferRepoFromGit } from "./trace-repo";
import {
  type TraceRepositoryTarget,
  readCachedTraceRepositoryTarget,
  rememberTraceRepositoryTarget,
} from "./trace-repository-target";
import { listUploadReceipts } from "./trace-upload-receipts";

/** A live, writer-authorized check. Offline receipts never imply current success. */
export async function writeOwnUploadStatus(input: {
  cwd: string;
  origin: string;
  devHome: string;
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
  let target: TraceRepositoryTarget | null = null;

  try {
    const repo = await inferRepoFromGit(input.cwd);

    const store = await client.findStore({
      owner: repo.owner,
      name: repo.repo,
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
    target = {
      origin: input.origin,
      repositoryId: store.repositoryId,
      storeId: store.storeId,
      name: store.displayName,
    };
    await rememberTraceRepositoryTarget({
      cwd: input.cwd,
      target,
      checkout: `${repo.owner}/${repo.repo}`,
      devHome: input.devHome,
    }).catch(() => undefined);

    if (store.bytesStored !== undefined)
      input.stdout.write(`Stored bytes: ${store.bytesStored}\n`);
    const page = await client.listOwnUploads(target.repositoryId, query.data);

    if (page.storeId !== target.storeId)
      throw new StoreApiError(
        "store_deleted",
        410,
        "The trace store changed. Check status again.",
      );
    input.stdout.write("Your uploads (checked with the store):\n");

    if (page.uploads.length === 0)
      input.stdout.write("No upload found for this account.\n");
    const scope = client.receiptScope();

    const receipts = scope
      ? await listUploadReceipts({
          scope,
          target,
          devHome: input.devHome,
          session: input.session,
        })
      : [];

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

      const receipt = receipts.find(
        (candidate) => candidate.uploadId === upload.uploadId,
      );

      if (
        receipt &&
        (receipt.omitted.subagents.length || receipt.omitted.commits)
      ) {
        input.stdout.write(
          `Omitted from this upload: ${receipt.omitted.subagents.length} subagent file(s), ${receipt.omitted.commits} commit link(s).\n`,
        );
      }
    }

    if (page.nextCursor)
      input.stdout.write(
        `More uploads: run \`review trace status${input.session ? ` --session ${input.session}` : ""} --limit ${query.data.limit} --cursor ${page.nextCursor}\`.\n`,
      );

    return 0;
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error));
    input.stdout.write(`Upload status: not checked. ${cause.message}\n`);

    // A denial is authoritative. Do not replace it with an earlier receipt.
    if (
      cause instanceof StoreApiError &&
      [401, 403, 410].includes(cause.status)
    )
      return 1;
    target ??= await readCachedTraceRepositoryTarget(input).catch(() => null);
    const scope = client.receiptScope();

    if (target && scope) {
      const receipts = await listUploadReceipts({
        scope,
        target,
        devHome: input.devHome,
        session: input.session,
      });

      for (const receipt of receipts.slice(0, query.data.limit)) {
        input.stdout.write(
          `${receipt.sessionId}: Previously confirmed at ${receipt.confirmedAt}; current status unknown (upload ${receipt.uploadId}).\n`,
        );

        if (receipt.omitted.subagents.length || receipt.omitted.commits)
          input.stdout.write(
            `Omitted from this upload: ${receipt.omitted.subagents.length} subagent file(s), ${receipt.omitted.commits} commit link(s).\n`,
          );
      }
    }

    return 1;
  }
}
