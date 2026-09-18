import { randomUUID } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { DatabaseSync, backup } from "node:sqlite";

import { parseJsonText } from "@dev.fast/review-protocol";
import {
  errorMessage,
  withFileLock,
  writePrivateJsonAtomic,
} from "@dev.fast/trace-core";

import { isMissingFileError } from "../fs-utils";
import { openLocalReviewStore } from "../review-api/local-data";
import {
  type StoredReview,
  UUID_PATTERN,
  parseAnyStoredReviewRecord,
} from "../review-home";
import { reviewVcs } from "../review-vcs";
import {
  type ImportLegacyReviewInput,
  type ImportOutcome,
  importLegacyReview,
} from "./import-review";

export interface CutoverReport {
  format: "review-json-cutover/1";
  database: string;
  backup: string | null;
  outcomes: ImportOutcome[];
  /** Unpublished legacy drafts are intentionally excluded from the JSON catalog. */
  droppedDrafts: { reviewId: string; title: string }[];
  errors: { reviewId: string; reason: string }[];
  /** Directories no schema accepts. They were never imported and are left
   * exactly as found, so one dead record cannot keep the app from starting. */
  skipped: { reviewId: string; dir: string; reason: string }[];
  archivedMaps: Parameters<
    NonNullable<ImportLegacyReviewInput["archiveMap"]>
  >[0][];
}

/** Runs before opening the live store. The caller must exclusively own the
 * Review home (Desktop's host startup, or an offline migration command).
 * Originals stay untouched. A failed conversion never installs a partial DB.
 */
export async function migrateJsonReviews(input: {
  home: string;
  dryRun?: boolean;
  log?: (message: string) => void;
}): Promise<CutoverReport> {
  await mkdir(input.home, { recursive: true, mode: 0o700 });

  const locked = await withFileLock(
    path.join(input.home, ".json-cutover"),
    {
      retryMs: 100,
      timeoutMs: 10_000,
      staleMs: 120_000,
      heartbeatMs: 5_000,
      unownedGraceMs: 1_000,
    },
    async () => {
      const database = path.join(input.home, "review-api.db");
      const staging = await mkdtemp(path.join(input.home, ".json-cutover-"));
      const candidate = path.join(staging, "review-api.db");

      const report: CutoverReport = {
        format: "review-json-cutover/1",
        database: candidate,
        backup: null,
        outcomes: [],
        droppedDrafts: [],
        errors: [],
        skipped: [],
        archivedMaps: [],
      };

      const originals: StoredReview[] = [];
      let directories: string[] = [];

      try {
        directories = await readdir(path.join(input.home, "reviews"));
      } catch (error) {
        if (!isMissingFileError(error)) throw error;
      }

      for (const id of directories.filter((name) => UUID_PATTERN.test(name))) {
        const dir = path.join(input.home, "reviews", id);

        try {
          const review = parseAnyStoredReviewRecord(
            parseJsonText(
              await readFile(path.join(dir, "review.json"), "utf8"),
            ),
          );

          if (review.uuid !== id)
            throw new Error("Review directory and UUID disagree.");
          originals.push({ dir, review });
        } catch (error) {
          const reason = errorMessage(error);
          report.skipped.push({ reviewId: id, dir, reason });
          input.log?.(
            `${dir}: unreadable review.json, left untouched and skipped: ${reason}`,
          );
        }
      }

      // SQLite's backup API includes committed WAL data; copying only the main
      // database file can silently lose the most recent authored reviews.
      let source: DatabaseSync | undefined;

      try {
        await access(database);
        source = new DatabaseSync(database, { readOnly: true });
        const backupDir = path.join(input.home, "backups");
        await mkdir(backupDir, { recursive: true, mode: 0o700 });
        report.backup = path.join(
          backupDir,
          `before-json-cutover-${randomUUID()}.db`,
        );
        await backup(source, report.backup);
        await chmod(report.backup, 0o600);
        await copyFile(report.backup, candidate);
      } catch (error) {
        if (!isMissingFileError(error)) throw error;
      } finally {
        source?.close();
      }

      const { store, data } = openLocalReviewStore(candidate);

      try {
        for (const original of originals) {
          if (
            original.review.visibility !== "system" &&
            !original.review.presentedDocumentRevision
          ) {
            report.droppedDrafts.push({
              reviewId: original.review.uuid,
              title: original.review.title,
            });
            input.log?.(`${original.review.title}: dropped unpublished draft`);
            continue;
          }

          try {
            const outcome = await importLegacyReview({
              review: original,
              store,
              data,
              completeHistory: true,
              archiveMap: (map) => report.archivedMaps.push(map),
              repositoryPaths: originals.flatMap((other) =>
                other.review.repoKey === original.review.repoKey
                  ? [other.review.worktreePath]
                  : [],
              ),
              materialize: async (review, revision) => {
                const dir = path.join(
                  staging,
                  "sealed",
                  review.review.uuid,
                  revision,
                );

                await mkdir(dir, { recursive: true });
                await reviewVcs.materialize(review.dir, revision, dir);

                return dir;
              },
            });

            report.outcomes.push(outcome);

            if (
              outcome.kind === "skipped" &&
              original.review.visibility !== "system" &&
              original.review.presentedDocumentRevision
            ) {
              report.errors.push({
                reviewId: original.review.uuid,
                reason: outcome.reason,
              });
            }

            input.log?.(`${original.review.title}: ${outcome.kind}`);
          } catch (error) {
            report.errors.push({
              reviewId: original.review.uuid,
              reason: errorMessage(error),
            });
          }
        }
      } finally {
        await data.close();
        await store.close();
      }

      await chmod(candidate, 0o600);
      await writePrivateJsonAtomic(path.join(staging, "report.json"), report);

      if (report.errors.length || input.dryRun) return report;

      // No process has opened the live store yet. Retire its checkpointed WAL
      // alongside the main file, then install the fully verified candidate.
      if (report.backup) {
        const previous = new DatabaseSync(database);

        try {
          previous.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        } finally {
          previous.close();
        }
      }

      await rename(candidate, database);
      report.database = database;
      await writePrivateJsonAtomic(
        path.join(input.home, "json-cutover.json"),
        report,
      );
      await rm(staging, { recursive: true, force: true });

      return report;
    },
  );

  if (!locked.acquired) throw new Error("Another Review migration is running.");

  return locked.result;
}

/** A completed cutover is a one-time storage migration, not a Home refresh task. */
export async function ensureJsonCutover(
  home: string,
  log: (message: string) => void,
): Promise<void> {
  let marker: string | undefined;

  try {
    marker = await readFile(path.join(home, "json-cutover.json"), "utf8");
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }

  if (marker !== undefined) {
    const saved = JSON.parse(marker);

    if (
      saved.format !== "review-json-cutover/1" ||
      !Array.isArray(saved.errors) ||
      saved.errors.length
    )
      throw new Error(
        "Invalid JSON cutover record; inspect the migration report before retrying.",
      );

    try {
      await access(path.join(home, "review-api.db"));
    } catch {
      throw new Error(
        "The migrated review database is missing. Restore its backup; original review directories must not resurrect deleted reviews.",
      );
    }

    return;
  }

  const result = await migrateJsonReviews({ home, log });

  if (result.errors.length)
    throw new Error(
      `Review migration could not finish. The original database is unchanged. Report: ${path.join(path.dirname(result.database), "report.json")}\n` +
        result.errors
          .map((item) => `${item.reviewId}: ${item.reason}`)
          .join("\n"),
    );
}
