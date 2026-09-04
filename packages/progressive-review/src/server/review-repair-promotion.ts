import { cp, lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { jsonObject, parseJsonText } from "@dev.fast/review-protocol";

import {
  parseStoredReviewRecord,
  parseStoredReviewRecordForRecovery,
} from "../review-home";
import { withReviewMutationLock } from "../review-mutation-lock";
import {
  type ReviewRepairReadyRequest,
  assertNoActiveReviewAgentWrites,
  fingerprintReviewRepairInputs,
} from "../review-repair-state";
import { reviewVcs } from "../review-vcs";
import { writePrivateJsonAtomic } from "./desktop-paths";

/** A staged seal may extend private objects and advance main/index, but cannot
 * replace repository config, remove history, or redirect writes through links. */
export async function validateRepairStagingRepository(
  dir: string,
  stagingDir: string,
): Promise<void> {
  for (const root of [dir, stagingDir]) {
    const metadata = await lstat(path.join(root, ".git"));
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new Error("Repair requires an isolated private Git directory.");
  }
  const compare = async (relative: string): Promise<void> => {
    const liveEntries = await readdir(path.join(dir, ".git", relative), {
      withFileTypes: true,
    });
    for (const entry of liveEntries) {
      const name = path.join(relative, entry.name);
      if (name === "index" || name === path.join("refs", "heads", "main"))
        continue;
      const staged = await lstat(path.join(stagingDir, ".git", name));
      if (entry.isSymbolicLink() || staged.isSymbolicLink())
        throw new Error(
          "Repair private Git metadata cannot contain symbolic links.",
        );
      if (entry.isDirectory()) {
        if (!staged.isDirectory())
          throw new Error("Prepared repair removed private history.");
        await compare(name);
      } else if (
        !staged.isFile() ||
        !(await readFile(path.join(dir, ".git", name))).equals(
          await readFile(path.join(stagingDir, ".git", name)),
        )
      )
        throw new Error(
          "Prepared repair changed existing private history or repository configuration.",
        );
    }
  };
  await compare("");
  const inspectStaged = async (relative: string): Promise<void> => {
    for (const entry of await readdir(path.join(stagingDir, ".git", relative), {
      withFileTypes: true,
    })) {
      const name = path.join(relative, entry.name);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()))
        throw new Error(
          "Repair private Git metadata cannot contain symbolic links or special files.",
        );
      const exists = await lstat(path.join(dir, ".git", name))
        .then(() => true)
        .catch(() => false);
      if (
        !exists &&
        name !== "index" &&
        name !== path.join("refs", "heads", "main") &&
        !/^objects\/[0-9a-f]{2}(?:\/[0-9a-f]{38})?$/.test(
          name.split(path.sep).join("/"),
        )
      )
        throw new Error(
          "Prepared repair added unexpected private Git metadata.",
        );
      if (entry.isDirectory()) await inspectStaged(name);
    }
  };
  await inspectStaged("");
  const oldHistory = await reviewVcs.log(dir);
  const newHistory = new Set(
    (await reviewVcs.log(stagingDir)).map((entry) => entry.oid),
  );
  if (oldHistory.some((entry) => !newHistory.has(entry.oid)))
    throw new Error("Prepared repair must retain existing private history.");
}

export async function assertReviewRepairInputsUnchanged(
  dir: string,
  request: ReviewRepairReadyRequest,
): Promise<void> {
  if (
    (await readFile(path.join(dir, "review.json"), "utf8")) !==
      request.expectedRecord ||
    (await fingerprintReviewRepairInputs(dir)) !== request.expectedFingerprint
  )
    throw new Error(
      "Review changed while preparing repair; retry without changing its pinned commits or review status.",
    );
  assertNoActiveReviewAgentWrites(dir);
}

export async function readPreparedReviewRepairRecord(
  request: ReviewRepairReadyRequest,
) {
  const previous = parseStoredReviewRecordForRecovery(
    parseJsonText(request.expectedRecord),
  );
  if (previous.uuid !== request.reviewUuid)
    throw new Error("Repair review UUID does not match its record.");
  if (!previous.presentedDocumentRevision)
    throw new Error("A draft without a presentation must use review publish.");
  if (!previous.presentedSoftwareMapRevision && request.newMapRevision)
    throw new Error("Repair cannot invent an absent software map.");
  if (
    previous.presentedSoftwareMapRevision &&
    !request.newMapRevision &&
    jsonObject(parseJsonText(request.expectedRecord))?.schemaVersion !== 2
  )
    throw new Error("Repair cannot discard a presented software map.");
  const next = {
    ...previous,
    presentedDocumentRevision: request.newDocumentRevision,
    presentedSoftwareMapRevision: request.newMapRevision,
  };
  const prepared = parseStoredReviewRecord(
    parseJsonText(
      await readFile(path.join(request.stagingDir, "review.json"), "utf8"),
    ),
  );
  if (!isDeepStrictEqual(prepared, next))
    throw new Error(
      "Prepared repair must preserve review status, pins, title, timestamps and attention metadata.",
    );
  return next;
}

/** The only repair writer. Mount validation precedes this transaction; every
 * live input is checked again after acquiring the shared mutation lock. */
export async function applyPreparedReviewRepair(
  dir: string,
  request: ReviewRepairReadyRequest,
  dependencies: { writeRecord?: typeof writePrivateJsonAtomic } = {},
) {
  return withReviewMutationLock(dir, async () => {
    await assertReviewRepairInputsUnchanged(dir, request);
    const next = await readPreparedReviewRepairRecord(request);
    const backup = await mkdtemp(path.join(tmpdir(), "review-repair-backup-"));
    const names = [".bundle", ".git", "review.json"];
    let retainBackup = false;
    try {
      for (const name of names)
        await copyPresent(path.join(dir, name), path.join(backup, name));
      try {
        for (const name of [".bundle", ".git"]) {
          await rm(path.join(dir, name), { recursive: true, force: true });
          await cp(path.join(request.stagingDir, name), path.join(dir, name), {
            recursive: true,
          });
        }
        await (dependencies.writeRecord ?? writePrivateJsonAtomic)(
          path.join(dir, "review.json"),
          next,
        );
        return next;
      } catch (error) {
        try {
          for (const name of names) {
            await rm(path.join(dir, name), { recursive: true, force: true });
            await copyPresent(path.join(backup, name), path.join(dir, name));
          }
        } catch (rollbackError) {
          retainBackup = true;
          throw new AggregateError(
            [error, rollbackError],
            `Repair rollback could not complete. Original review files are preserved at ${backup}.`,
          );
        }
        throw error;
      }
    } finally {
      if (!retainBackup) await rm(backup, { recursive: true, force: true });
    }
  });
}

async function copyPresent(source: string, destination: string): Promise<void> {
  try {
    await cp(source, destination, { recursive: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return;
    throw error;
  }
}
