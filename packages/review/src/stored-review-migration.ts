import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  type JsonObject,
  REVIEW_SCHEMA_VERSION,
  jsonObject,
  jsonString,
  parseJsonText,
} from "@dev.fast/review-protocol";
import { errorMessage, writePrivateJsonAtomic } from "@dev.fast/trace-core";
import { z } from "zod";

import {
  authoringSessionKey,
  parseAuthoringSessionKey,
} from "./agent-session-ref";
import { isMissingFileError } from "./fs-utils";
import { promoteReviewArtifactFiles } from "./review-artifact-promotion";
import {
  bundleReviewDocument,
  readReviewDocumentBundle,
  writeReviewDocumentBundle,
} from "./review-bundle";
import { isAuthoringInput } from "./review-derived-paths";
import { removeLegacyReviewCheckouts } from "./review-head-checkout";
import {
  DISABLED_REVIEW_SOURCE_SESSION,
  type StoredReviewRecord,
  allowsAbsentSoftwareMap,
  materializeReviewRevision,
  parseAnyStoredReviewRecord,
  parseStoredReviewRecord,
  sealReviewCandidate,
} from "./review-home";
import { withReviewMutationLock } from "./review-mutation-lock";
import { evaluateSealedReviewDocument } from "./review-sealed-document";
import { reviewSourcePins } from "./review-source-pins";
import {
  type ReviewSoftwareMapBundle,
  bundleReviewSoftwareMap,
  readReviewSoftwareMapBundle,
  writeReviewSoftwareMapBundle,
} from "./software-map-bundle";
import {
  type NormalizedSoftwareModel,
  isNormalizedSoftwareModel,
} from "./software-map-model";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StoredReviewMigrationResult {
  failedReviewUuids?: string[];
  documents: number;
  droppedLegacyPeekReviews: number;
  droppedReviews: number;
  legacyCheckoutsRemoved: number;
}

export interface StoredReviewMigrationOutcome {
  record: StoredReviewRecord;
  migrated: boolean;
}

interface StoredReviewMigrationInput {
  reviewDir: string;
  log?: (message: string) => void;
}

/** One review: record normalization and sealed artifact conversion. Shared by
 * the CLI sweep and the store loader. Repo-level cleanup (legacy checkouts,
 * `repos/`) stays in the sweep. */
export async function migrateStoredReview(
  input: StoredReviewMigrationInput,
): Promise<StoredReviewMigrationOutcome> {
  return withReviewMutationLock(input.reviewDir, () =>
    migrateStoredReviewLocked(input),
  );
}

async function migrateStoredReviewLocked(
  input: StoredReviewMigrationInput,
): Promise<StoredReviewMigrationOutcome> {
  const value = jsonObject(
    parseJsonText(
      await readFile(path.join(input.reviewDir, "review.json"), "utf8"),
    ),
  );

  const schemaVersion = value?.schemaVersion;

  if (
    !value ||
    ![2, 3, 4, REVIEW_SCHEMA_VERSION].includes(Number(schemaVersion))
  ) {
    throw new Error("Unsupported Review schema; the record was preserved.");
  }

  const validatedRecord = parseAnyStoredReviewRecord(value);

  const migratedRecord =
    schemaVersion === 3 || schemaVersion === 2
      ? parseStoredReviewRecord({
          ...validatedRecord,
          sourceSession: DISABLED_REVIEW_SOURCE_SESSION,
        })
      : validatedRecord;

  if (migratedRecord.uuid !== path.basename(input.reviewDir))
    throw new Error("review.json UUID does not match its directory");

  const migrated =
    schemaVersion !== REVIEW_SCHEMA_VERSION &&
    (await regeneratePresentedArtifacts({
      reviewDir: input.reviewDir,
      review: migratedRecord,
      original: value,
      allowAbsentMap: allowsAbsentSoftwareMap({
        schemaVersion: Number(schemaVersion),
      }),
      log: input.log,
      finalizeSource: async (record) =>
        schemaVersion === 2 || schemaVersion === 3
          ? migrateLegacyReviewSourceSession(record, value, input.log)
          : record,
    }));

  const record = parseStoredReviewRecord(
    parseJsonText(
      await readFile(path.join(input.reviewDir, "review.json"), "utf8"),
    ),
  );

  return { record, migrated };
}

export async function migrateStoredReviewData(input: {
  reviewHome: string;
  log?: (message: string) => void;
  onBlocker?: (message: string) => void;
}): Promise<StoredReviewMigrationResult> {
  await rm(path.join(input.reviewHome, "repos"), {
    recursive: true,
    force: true,
  });

  const total: StoredReviewMigrationResult = {
    failedReviewUuids: [],
    documents: 0,
    droppedLegacyPeekReviews: 0,
    droppedReviews: 0,
    legacyCheckoutsRemoved: 0,
  };

  const reviewsRoot = path.join(input.reviewHome, "reviews");
  const cleanedLegacyRoots = new Set<string>();
  let entries: import("node:fs").Dirent[];

  try {
    entries = await readdir(reviewsRoot, { withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) return total;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) continue;
    const reviewDir = path.join(reviewsRoot, entry.name);

    try {
      const outcome = await migrateStoredReview({
        reviewDir,
        log: input.log,
      });

      const worktreePath = outcome.record.worktreePath;

      if (!cleanedLegacyRoots.has(worktreePath)) {
        cleanedLegacyRoots.add(worktreePath);
        total.legacyCheckoutsRemoved += await removeLegacyReviewCheckouts({
          rootPath: worktreePath,
          onBlocker: input.onBlocker,
        });
      }

      total.documents += 1;
    } catch (error) {
      total.failedReviewUuids?.push(entry.name);
      const message = `${reviewDir}: current artifact migration failed: ${errorMessage(error)} Review preserved; retry review migrate apply after resolving the blocker.`;
      input.onBlocker?.(message);
      input.log?.(message);
    }
  }

  return total;
}

/** Schema 2 and 3 records named the authoring session `agentSession`. It
 * becomes the source session as-is; a record without a usable session keeps
 * the disabled marker. */
function migrateLegacyReviewSourceSession(
  record: StoredReviewRecord,
  original: JsonObject,
  log?: (message: string) => void,
): StoredReviewRecord {
  const source = parseAuthoringSessionKey(jsonString(original.agentSession));

  if (!source) {
    log?.(
      `Review ${record.uuid} has no usable authoring session; the Review was preserved.`,
    );

    return { ...record, sourceSession: DISABLED_REVIEW_SOURCE_SESSION };
  }

  const sourceSession = authoringSessionKey(source);

  if (record.agentSessions?.[sourceSession])
    return { ...record, sourceSession };
  const now = new Date().toISOString();

  return {
    ...record,
    sourceSession,
    agentSessions: {
      ...record.agentSessions,
      [sourceSession]: { firstSeenAt: now, lastSeenAt: now, roles: ["author"] },
    },
  };
}

async function regeneratePresentedArtifacts(input: {
  reviewDir: string;
  review: ReturnType<typeof parseAnyStoredReviewRecord>;
  original: JsonObject;
  allowAbsentMap: boolean;
  log?: (message: string) => void;
  finalizeSource: (record: StoredReviewRecord) => Promise<StoredReviewRecord>;
}): Promise<boolean> {
  const staging = await mkdtemp(
    path.join(tmpdir(), "review-artifact-migration-"),
  );

  const documentDir = path.join(staging, "document");
  const mapDir = path.join(staging, "map");

  try {
    let documentBundle: ReturnType<typeof bundleReviewDocument> | null = null;

    let evaluatedDocument:
      | Awaited<ReturnType<typeof evaluateSealedReviewDocument>>
      | undefined;

    let documentRecord: StoredReviewRecord | undefined;
    let mapRecord: StoredReviewRecord | undefined;
    let mapBundle: ReviewSoftwareMapBundle | null = null;
    let mapRevision = input.review.presentedSoftwareMapRevision;
    const documentRevision = input.review.presentedDocumentRevision;

    if (documentRevision) {
      await materializeReviewRevision(
        input.reviewDir,
        documentRevision,
        documentDir,
      );
      documentRecord = parseAnyStoredReviewRecord(
        parseJsonText(
          await readFile(path.join(documentDir, "review.json"), "utf8"),
        ),
      );

      if (!(await readReviewDocumentBundle(documentDir, "/"))) {
        evaluatedDocument = await evaluateSealedReviewDocument(
          documentDir,
          input.log,
        );
        documentBundle = bundleReviewDocument(evaluatedDocument.document);
      }
    }

    if (mapRevision) {
      await materializeReviewRevision(input.reviewDir, mapRevision, mapDir);
      mapRecord = parseAnyStoredReviewRecord(
        parseJsonText(await readFile(path.join(mapDir, "review.json"), "utf8")),
      );

      if (!(await readReviewSoftwareMapBundle(mapDir))) {
        mapBundle = await legacySoftwareMapBundle(mapDir);

        if (!mapBundle) {
          if (!input.allowAbsentMap)
            throw new Error("The presented software map is missing.");

          const evaluated =
            mapRevision === documentRevision && evaluatedDocument
              ? evaluatedDocument
              : await evaluateSealedReviewDocument(mapDir, input.log);

          if (evaluated.legacySoftwareMap) {
            const sealed = mapRecord;

            if (!sealed.sourceCommit)
              throw new Error(
                "The embedded software map has no sealed source commit.",
              );
            mapBundle = bundleReviewSoftwareMap({
              ...evaluated.legacySoftwareMap,
              baseCommit: sealed.baseCommit,
              headCommit: sealed.sourceCommit,
            });
          } else {
            mapRevision = null;
          }
        }
      }
    }

    // Source migration and schema normalization must not race a lifecycle or pin change.
    return await withReviewMutationLock(input.reviewDir, async () => {
      const recordPath = path.join(input.reviewDir, "review.json");
      const currentText = await readFile(recordPath, "utf8");

      if (
        JSON.stringify(parseJsonText(currentText)) !==
        JSON.stringify(input.original)
      ) {
        throw new Error(
          "Review changed while preparing migration; rerun review migrate apply.",
        );
      }

      if (!documentBundle && !mapBundle) {
        if (
          input.original.schemaVersion !== REVIEW_SCHEMA_VERSION ||
          mapRevision !== input.review.presentedSoftwareMapRevision
        ) {
          await writePrivateJsonAtomic(
            recordPath,
            await input.finalizeSource({
              ...input.review,
              presentedSoftwareMapRevision: mapRevision,
            }),
          );
          input.log?.("Migrated Review " + input.review.uuid + " to schema 5.");

          return true;
        }

        return false;
      }

      const candidateDir = path.join(staging, "candidate");
      await cp(
        path.join(input.reviewDir, ".git"),
        path.join(candidateDir, ".git"),
        {
          recursive: true,
        },
      );
      await cp(
        path.join(documentRevision ? documentDir : mapDir, ".bundle"),
        path.join(candidateDir, ".bundle"),
        { recursive: true },
      );

      if (!mapBundle) {
        await rm(path.join(candidateDir, ".bundle/software-map"), {
          recursive: true,
          force: true,
        });

        if (mapRevision) {
          await cp(
            path.join(mapDir, ".bundle/software-map"),
            path.join(candidateDir, ".bundle/software-map"),
            { recursive: true },
          );
        }
      }

      const candidateRecordPath = path.join(candidateDir, "review.json");
      let completed = false;
      const newRevisions: string[] = [];

      try {
        if (documentBundle) {
          await rm(path.join(candidateDir, ".bundle/document"), {
            recursive: true,
            force: true,
          });
          await rm(path.join(candidateDir, ".bundle/review-document.js"), {
            force: true,
          });
          await rm(path.join(candidateDir, ".bundle/manifest.json"), {
            force: true,
          });
          await writeReviewDocumentBundle(candidateDir, documentBundle);
        }

        if (mapBundle) {
          await rm(path.join(candidateDir, ".bundle/software-map"), {
            recursive: true,
            force: true,
          });
          await writeReviewSoftwareMapBundle(candidateDir, mapBundle);
        }

        let next = {
          ...input.review,
          presentedSoftwareMapRevision: mapRevision,
        };

        if (mapBundle) {
          await replaceCandidateSources(candidateDir, mapDir);
          await writePrivateJsonAtomic(candidateRecordPath, {
            ...next,
            ...reviewSourcePins(mapRecord!),
          });
          mapRevision = await sealReviewCandidate(
            candidateDir,
            "Migrate current Review software map to JSON",
          );
          newRevisions.push(mapRevision);
          next = { ...next, presentedSoftwareMapRevision: mapRevision };
        }

        if (documentBundle) {
          await replaceCandidateSources(candidateDir, documentDir);
          await writePrivateJsonAtomic(candidateRecordPath, {
            ...next,
            ...reviewSourcePins(documentRecord!),
          });

          const revision = await sealReviewCandidate(
            candidateDir,
            "Migrate current Review document to JSON",
          );

          newRevisions.push(revision);
          next = { ...next, presentedDocumentRevision: revision };
        }

        for (const revision of newRevisions) {
          await materializeReviewRevision(
            candidateDir,
            revision,
            path.join(input.reviewDir, ".build", revision),
          );
        }

        next = await input.finalizeSource(next);
        await promoteReviewArtifactFiles({
          reviewDir: input.reviewDir,
          candidateDir,
          record: next,
        });
        completed = true;
        input.log?.(
          "Migrated current presentation for Review " +
            input.review.uuid +
            " to JSON.",
        );

        return true;
      } finally {
        if (!completed) {
          for (const revision of newRevisions)
            await rm(path.join(input.reviewDir, ".build", revision), {
              recursive: true,
              force: true,
            });
        }
      }
    });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function replaceCandidateSources(
  candidateDir: string,
  sourceDir: string,
): Promise<void> {
  for (const name of await readdir(candidateDir)) {
    if (name !== ".git" && name !== ".bundle") {
      await rm(path.join(candidateDir, name), { recursive: true, force: true });
    }
  }

  await cp(sourceDir, candidateDir, {
    recursive: true,
    filter: (source) =>
      isAuthoringInput(
        path.relative(sourceDir, source).split(path.sep)[0] ?? "",
      ),
  });
}

async function legacySoftwareMapBundle(
  legacyBuildDir: string,
): Promise<ReviewSoftwareMapBundle | null> {
  const mapDir = path.join(legacyBuildDir, ".bundle", "software-map");
  let manifestValue: JsonObject | undefined;

  try {
    manifestValue = jsonObject(
      parseJsonText(await readFile(path.join(mapDir, "manifest.json"), "utf8")),
    );
  } catch (error) {
    if (isMissingFileError(error)) {
      try {
        await readdir(mapDir);
      } catch (directoryError) {
        if (isMissingFileError(directoryError)) return null;
        throw directoryError;
      }

      throw new Error("The presented software map has no manifest.");
    }

    throw error;
  }

  const headCommit = jsonString(manifestValue?.headCommit);
  const baseCommit = jsonString(manifestValue?.baseCommit);

  if (
    manifestValue?.version !== 1 ||
    !headCommit ||
    !baseCommit ||
    !/^[0-9a-f]{40}$/i.test(headCommit) ||
    !/^[0-9a-f]{40}$/i.test(baseCommit)
  ) {
    throw new Error(
      "The presented software-map manifest is invalid or unsupported.",
    );
  }

  const load = async (
    file: string,
  ): Promise<NormalizedSoftwareModel | null> => {
    const url = pathToFileURL(path.join(mapDir, file));
    url.searchParams.set("t", `${Date.now()}-${Math.random()}`);

    try {
      // SAFETY: an imported legacy map module has no static TypeScript shape;
      // isNormalizedSoftwareModel validates its default export before use.
      const module = (await import(url.href)) as { default?: unknown };

      return isNormalizedSoftwareModel(module.default) ? module.default : null;
    } catch {
      return null;
    }
  };

  const [head, base] = await Promise.all([
    load("head-map.js"),
    load("base-map.js"),
  ]);

  if (!head || !base)
    throw new Error(
      "The presented software map could not be converted; its sealed head or base bundle is invalid.",
    );

  return bundleReviewSoftwareMap({ head, base, headCommit, baseCommit });
}
