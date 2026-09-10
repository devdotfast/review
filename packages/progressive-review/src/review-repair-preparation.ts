import { existsSync } from "node:fs";
import { cp, lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readNote, remoteNotesRef } from "@dev.fast/local-vcs";
import {
  REVIEW_SCHEMA_VERSION,
  jsonObject,
  jsonString,
  parseJsonText,
} from "@dev.fast/review-protocol";

import { errorMessage as message } from "./error-message";
import {
  evaluateSealedReviewDocument,
  legacySoftwareMapBundle,
  readSealedMapManifestPins,
} from "./legacy-sealed-artifacts";
import { isMissingFileError } from "./native-agent/transcript-json";
import { REVIEW_ARTIFACTS_DIR } from "./review-artifact-store";
import {
  bundleReviewDocument,
  readReviewDocumentBundle,
  writeReviewDocumentBundle,
} from "./review-bundle";
import { createLegacyCodeRecordMigrator } from "./review-code-target-migration";
import { isDerivedReviewPath } from "./review-derived-paths";
import {
  type StoredReviewRecord,
  allowsAbsentSoftwareMap,
  materializeReviewRevision,
  parseAnyStoredReviewRecord,
  sealReviewCandidate,
} from "./review-home";
import { stableJson, withReviewMutationLock } from "./review-mutation-lock";
import { prepareReviewDocumentBundle } from "./review-publication-preparation";
import {
  type ReviewRepairReadyRequest,
  assertNoActiveReviewAgentWrites,
  fingerprintReviewRepairInputs,
} from "./review-repair-state";
import { readReviewRecord } from "./review-state-db";
import { SOFTWARE_MAP_NOTES_REF } from "./review-storage";
import {
  type ReviewThreadDbMigrationOptions,
  copyReviewThreadDatabaseSnapshot,
  legacyReviewThreadDbPath,
  migrateReviewThreadDb,
  readReviewThreadDatabaseFingerprint,
  reviewThreadDbPath,
} from "./review-thread-store-backend";
import { writePrivateJsonAtomic } from "./server/desktop-paths";
import {
  bundleReviewSoftwareMap,
  readReviewSoftwareMapBundle,
  writeReviewSoftwareMapBundle,
} from "./software-map-bundle";
import { checkSoftwareMapSource } from "./software-map-health";

export type PreparedReviewRepair =
  | { kind: "noop"; review: StoredReviewRecord }
  | {
      kind: "prepared";
      request: ReviewRepairReadyRequest;
      review: StoredReviewRecord;
      cleanup: () => Promise<void>;
    };

interface ReviewRepairSnapshot {
  review: StoredReviewRecord;
  documentRevision: string;
  expectedRecord: string;
  expectedFingerprint: string;
  schemaVersion: number;
  threadDbFingerprint?: string;
}

interface RepairedDocument {
  changed: boolean;
  usedEditableSources: boolean;
  /** The record sealed alongside the presented document. */
  presentedRecord: StoredReviewRecord;
}

interface MapPins {
  baseCommit: string;
  headCommit: string | null;
}

interface RepairedMap {
  changed: boolean;
  usedEditableSources: boolean;
  /** Null only when a legacy schema legitimately drops an absent map. */
  revision: string | null;
  presentedRecord: StoredReviewRecord;
  pins: MapPins;
}

/** Only the isolated snapshot is writable. Promotion belongs to the repair
 * completer. */
export async function prepareReviewRepair(input: {
  reviewDir: string;
  warning?: (message: string) => void;
}): Promise<PreparedReviewRepair> {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "review-repair-"));
  const stagingDir = path.join(temporaryRoot, "candidate");
  const cleanup = () => rm(temporaryRoot, { recursive: true, force: true });
  try {
    const snapshot = await snapshotReviewForRepair(input.reviewDir, stagingDir);
    const { review } = snapshot;
    const threadDbMigration: ReviewThreadDbMigrationOptions = {
      preserveLegacyQuestions: true,
    };
    if (review.sourceCommit)
      threadDbMigration.migrateLegacyCodeRecord =
        createLegacyCodeRecordMigrator({
          rootPath: review.worktreePath,
          baseCommit: review.baseCommit,
          headCommit: review.sourceCommit,
        });
    const threadDbUpgraded =
      snapshot.threadDbFingerprint !== undefined &&
      (await migrateReviewThreadDb(
        path.join(stagingDir, "review.mdx"),
        threadDbMigration,
      )) === "upgraded";
    const document = await repairPresentedDocument({
      reviewDir: input.reviewDir,
      stagingDir,
      temporaryRoot,
      review,
      revision: snapshot.documentRevision,
      warning: input.warning,
    });
    const presentedMapRevision = review.presentedSoftwareMapRevision;
    const map: RepairedMap = presentedMapRevision
      ? await repairPresentedMap({
          stagingDir,
          temporaryRoot,
          review,
          revision: presentedMapRevision,
          documentRecord: document.presentedRecord,
          allowAbsentMap: allowsAbsentSoftwareMap(snapshot),
          warning: input.warning,
        })
      : unchangedPresentedMap(document);
    if (
      snapshot.threadDbFingerprint !== undefined &&
      readReviewThreadDatabaseFingerprint(
        path.join(input.reviewDir, "review.mdx"),
      ) !== snapshot.threadDbFingerprint
    )
      throw new Error(
        "Review threads changed while preparing repair; retry after active writes finish.",
      );
    if (
      !document.changed &&
      !map.changed &&
      !threadDbUpgraded &&
      map.revision === presentedMapRevision &&
      snapshot.schemaVersion === REVIEW_SCHEMA_VERSION
    ) {
      await cleanup();
      return { kind: "noop", review };
    }
    const { documentRevision, mapRevision } = await sealRepairedPresentations({
      stagingDir,
      review,
      documentRevision: snapshot.documentRevision,
      presentedMapRevision,
      document,
      map,
    });
    const request: ReviewRepairReadyRequest = {
      reviewUuid: review.uuid,
      stagingDir,
      expectedRecord: snapshot.expectedRecord,
      expectedFingerprint: snapshot.expectedFingerprint,
      newDocumentRevision: documentRevision,
      newMapRevision: mapRevision,
      sourceFallback: {
        document: document.usedEditableSources,
        map: map.usedEditableSources,
      },
    };
    if (threadDbUpgraded)
      request.expectedThreadDbFingerprint = snapshot.threadDbFingerprint;
    return { kind: "prepared", review, cleanup, request };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

function unchangedPresentedMap(document: RepairedDocument): RepairedMap {
  return {
    changed: false,
    usedEditableSources: false,
    revision: null,
    presentedRecord: document.presentedRecord,
    pins: {
      baseCommit: document.presentedRecord.baseCommit,
      headCommit: document.presentedRecord.sourceCommit,
    },
  };
}

/** Seals map first, document second, then leaves the final candidate record. */
async function sealRepairedPresentations(input: {
  stagingDir: string;
  review: StoredReviewRecord;
  documentRevision: string;
  presentedMapRevision: string | null;
  document: RepairedDocument;
  map: RepairedMap;
}): Promise<{ documentRevision: string; mapRevision: string | null }> {
  let mapRevision = input.map.revision;
  if (input.map.changed) {
    await writePrivateJsonAtomic(path.join(input.stagingDir, "review.json"), {
      ...input.review,
      ...sealedPins(input.map.presentedRecord),
      baseCommit: input.map.pins.baseCommit,
      sourceCommit: input.map.pins.headCommit,
      presentedSoftwareMapRevision: input.presentedMapRevision,
    });
    mapRevision = await sealReviewCandidate(
      input.stagingDir,
      "Repair current Review software map",
    );
  }
  let documentRevision = input.documentRevision;
  if (input.document.changed) {
    await writePrivateJsonAtomic(path.join(input.stagingDir, "review.json"), {
      ...input.review,
      ...sealedPins(input.document.presentedRecord),
      presentedSoftwareMapRevision: mapRevision,
    });
    documentRevision = await sealReviewCandidate(
      input.stagingDir,
      "Repair current Review document",
    );
  }
  await writePrivateJsonAtomic(path.join(input.stagingDir, "review.json"), {
    ...input.review,
    presentedDocumentRevision: documentRevision,
    presentedSoftwareMapRevision: mapRevision,
  });
  return { documentRevision, mapRevision };
}

/** Copies the review into an isolated candidate under the mutation lock and
 * proves nothing moved while the copy ran. Only the copy is writable. */
async function snapshotReviewForRepair(
  reviewDir: string,
  stagingDir: string,
): Promise<ReviewRepairSnapshot> {
  return withReviewMutationLock(reviewDir, async () => {
    await assertIsolatedRepairInternals(reviewDir);
    await assertNoActiveReviewAgentWrites(reviewDir);
    const expectedValue = readReviewRecord(reviewDir);
    if (expectedValue === null)
      throw new Error(`No Review record found for ${reviewDir}.`);
    const expectedRecord = stableJson(expectedValue);
    const review = parseAnyStoredReviewRecord(expectedValue);
    if (review.uuid !== path.basename(reviewDir))
      throw new Error("Review UUID does not match its storage directory.");
    const documentRevision = review.presentedDocumentRevision;
    if (!documentRevision)
      throw new Error(
        "This Review has no current presentation. Run review publish instead.",
      );
    const expectedFingerprint = await fingerprintReviewRepairInputs(reviewDir);
    await cp(reviewDir, stagingDir, {
      recursive: true,
      filter: (source) => {
        const top = path.relative(reviewDir, source).split(path.sep)[0] ?? "";
        return top !== REVIEW_ARTIFACTS_DIR && !isDerivedReviewPath(top);
      },
    });
    await assertIsolatedRepairInternals(stagingDir);
    if (
      (await fingerprintReviewRepairInputs(reviewDir)) !== expectedFingerprint
    )
      throw new Error(
        "Review authoring changed while preparing repair. Retry after active writes finish.",
      );
    const reviewMdxPath = path.join(reviewDir, "review.mdx");
    const copied = existsSync(reviewThreadDbPath(reviewMdxPath))
      ? copyReviewThreadDatabaseSnapshot(
          reviewMdxPath,
          path.join(stagingDir, "review.mdx"),
        )
      : undefined;
    // The guard covers the isolated upgrade of a Review's own legacy thread
    // database. Once its threads live in the shared home database, that
    // database's bytes move for reasons unrelated to this Review, so
    // fingerprinting it would refuse repairs at random.
    const threadDbFingerprint =
      reviewThreadDbPath(reviewMdxPath) ===
      legacyReviewThreadDbPath(reviewMdxPath)
        ? copied
        : undefined;
    return {
      review,
      documentRevision,
      expectedRecord,
      expectedFingerprint,
      schemaVersion: Number(jsonObject(expectedValue)?.schemaVersion),
      threadDbFingerprint,
    };
  });
}

/** Sealed document metadata retains the presentation's pinned source, even
 * when editable record pins have moved since its publication. */
function sealedPins(record: StoredReviewRecord) {
  return {
    baseRef: record.baseRef,
    baseCommit: record.baseCommit,
    sourceCommit: record.sourceCommit,
    sourceIdentity: record.sourceIdentity,
  };
}

/** Writes the repaired document bundle into the candidate. Falls back to the
 * editable review.mdx/data.ts only when the sealed bundle cannot be read. */
async function repairPresentedDocument(input: {
  reviewDir: string;
  stagingDir: string;
  temporaryRoot: string;
  review: StoredReviewRecord;
  revision: string;
  warning?: (message: string) => void;
}): Promise<RepairedDocument> {
  const documentDir = path.join(input.temporaryRoot, "document");
  let presentedRecord = input.review;
  try {
    await materializeReviewRevision(
      input.stagingDir,
      input.revision,
      documentDir,
    );
    presentedRecord = parseAnyStoredReviewRecord(
      parseJsonText(
        await readFile(path.join(documentDir, "review.json"), "utf8"),
      ),
    );
    const candidateBundle = await readReviewDocumentBundle(documentDir, "/");
    if (candidateBundle) {
      await writeReviewDocumentBundle(input.stagingDir, candidateBundle);
      return { changed: false, usedEditableSources: false, presentedRecord };
    }
    const evaluated = await evaluateSealedReviewDocument(
      documentDir,
      input.warning,
    );
    await writeReviewDocumentBundle(
      input.stagingDir,
      bundleReviewDocument(evaluated.document),
    );
    return { changed: true, usedEditableSources: false, presentedRecord };
  } catch (error) {
    input.warning?.(
      `Sealed document conversion failed: ${message(error)}. Using editable review.mdx/data.ts; reconcile unpublished edits without changing the Review's meaning. Validation does not prove semantic equivalence.`,
    );
    try {
      await readFile(path.join(input.stagingDir, "review.mdx"), "utf8").catch(
        (cause) => {
          if (isMissingFileError(cause)) {
            throw new Error(
              `Missing editable Review input: ${path.join(input.reviewDir, "review.mdx")}. Restore that source file before retrying repair.`,
            );
          }
          throw cause;
        },
      );
      const sourceReview = {
        ...input.review,
        ...sealedPins(presentedRecord),
      };
      await writePrivateJsonAtomic(
        path.join(input.stagingDir, "review.json"),
        sourceReview,
      );
      const prepared = await prepareReviewDocumentBundle({
        review: {
          dir: input.stagingDir,
          review: sourceReview,
        },
      });
      await writeReviewDocumentBundle(input.stagingDir, prepared.bundle);
      for (const warning of prepared.warnings) input.warning?.(warning);
    } catch (fallbackError) {
      throw new Error(
        `Document repair failed. Sealed input: ${message(error)}. Editable input: ${message(fallbackError).replaceAll(input.stagingDir, input.reviewDir)}`,
      );
    }
    return { changed: true, usedEditableSources: true, presentedRecord };
  }
}

/** Writes the repaired software-map bundle into the candidate. Falls back to
 * validated saved map notes only when the sealed map cannot be converted. */
async function repairPresentedMap(input: {
  stagingDir: string;
  temporaryRoot: string;
  review: StoredReviewRecord;
  revision: string;
  documentRecord: StoredReviewRecord;
  allowAbsentMap: boolean;
  warning?: (message: string) => void;
}): Promise<RepairedMap> {
  const mapDir = path.join(input.temporaryRoot, "map");
  let presentedRecord = input.documentRecord;
  let pins: MapPins = {
    baseCommit: presentedRecord.baseCommit,
    headCommit: presentedRecord.sourceCommit,
  };
  let sealedError: unknown;
  let materialized = false;
  try {
    await materializeReviewRevision(input.stagingDir, input.revision, mapDir);
    presentedRecord = parseAnyStoredReviewRecord(
      parseJsonText(await readFile(path.join(mapDir, "review.json"), "utf8")),
    );
    pins = {
      baseCommit: presentedRecord.baseCommit,
      headCommit: presentedRecord.sourceCommit,
    };
    materialized = true;
  } catch (error) {
    sealedError = error;
  }
  if (materialized) {
    const manifestPins = await readSealedMapManifestPins(mapDir);
    if (manifestPins) {
      if (
        manifestPins.baseCommit !== pins.baseCommit ||
        manifestPins.headCommit !== pins.headCommit
      ) {
        throw new Error(
          "Presented software-map manifest pins contradict its sealed Review record; reconcile this presentation before repair.",
        );
      }
      pins = manifestPins;
    }
    try {
      const candidateBundle = await readReviewSoftwareMapBundle(mapDir);
      if (candidateBundle) {
        await writeReviewSoftwareMapBundle(input.stagingDir, candidateBundle);
        return {
          changed: false,
          usedEditableSources: false,
          revision: input.revision,
          presentedRecord,
          pins,
        };
      }
      const legacyBundle = await legacySoftwareMapBundle(mapDir);
      if (legacyBundle) {
        await writeReviewSoftwareMapBundle(input.stagingDir, legacyBundle);
        return {
          changed: true,
          usedEditableSources: false,
          revision: input.revision,
          presentedRecord,
          pins,
        };
      }
      if (input.allowAbsentMap) {
        return {
          changed: false,
          usedEditableSources: false,
          revision: null,
          presentedRecord,
          pins,
        };
      }
      throw new Error("The presented software map is missing.");
    } catch (error) {
      sealedError = error;
    }
  }
  input.warning?.(
    `Sealed software map conversion failed: ${message(sealedError)}. Validating saved map notes at the current presentation's pinned commits.`,
  );
  try {
    const headCommit = pins.headCommit;
    if (!headCommit)
      throw new Error(
        "The current map presentation has no pinned head commit.",
      );
    const bundle = await prepareSavedMapNotes({
      rootPath: input.review.worktreePath,
      baseCommit: pins.baseCommit,
      headCommit,
    });
    await writeReviewSoftwareMapBundle(input.stagingDir, bundle);
  } catch (fallbackError) {
    throw new Error(
      `Software map repair failed. Sealed input: ${message(sealedError)}. Saved map notes: ${message(fallbackError)}`,
    );
  }
  return {
    changed: true,
    usedEditableSources: true,
    revision: input.revision,
    presentedRecord,
    pins,
  };
}

/** Only internal writable trees are restricted; authored import symlinks are valid. */
async function assertIsolatedRepairInternals(dir: string): Promise<void> {
  const inspect = async (relative: string): Promise<void> => {
    const metadata = await lstat(path.join(dir, relative)).catch((error) => {
      if (isMissingFileError(error)) return null;
      throw error;
    });
    if (!metadata) return;
    if (
      metadata.isSymbolicLink() ||
      (!metadata.isDirectory() && !metadata.isFile())
    ) {
      throw new Error(
        `Repair internal path ${relative} is a symbolic link or special file. Restore ordinary artifact and private Git files before retrying repair.`,
      );
    }
    if (metadata.isDirectory()) {
      for (const entry of await readdir(path.join(dir, relative)))
        await inspect(path.join(relative, entry));
    }
  };
  await inspect(".bundle");
  await inspect(".git");
}

export async function prepareSavedMapNotes(input: {
  rootPath: string;
  baseCommit: string;
  headCommit: string;
}) {
  const load = async (commit: string, role: "base" | "head") => {
    const source =
      (await readNote({
        rootPath: input.rootPath,
        ref: SOFTWARE_MAP_NOTES_REF,
        commit,
      })) ??
      (await readNote({
        rootPath: input.rootPath,
        ref: remoteNotesRef(SOFTWARE_MAP_NOTES_REF),
        commit,
      }));
    if (source === null)
      throw new Error(
        `No saved software map note at ${role} commit ${commit}; author and validate that pinned map before retrying repair.`,
      );
    const checked = await checkSoftwareMapSource({
      repoRootPath: input.rootPath,
      commit,
      source,
      sourceName: `repair-${role}-map.ts`,
    });
    if (!checked.model || checked.errors.length)
      throw new Error(
        checked.errors.join("; ") || `Invalid saved ${role} map.`,
      );
    return checked.model;
  };
  const base = await load(input.baseCommit, "base");
  const head = await load(input.headCommit, "head");
  return bundleReviewSoftwareMap({
    base,
    head,
    baseCommit: input.baseCommit,
    headCommit: input.headCommit,
  });
}
