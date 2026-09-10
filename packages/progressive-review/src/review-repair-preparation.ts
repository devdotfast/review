import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  REVIEW_SCHEMA_VERSION,
  jsonNumber,
  jsonObject,
  parseJsonText,
} from "@dev.fast/review-protocol";

import { errorMessage as message } from "./error-message";
import {
  type LegacyImportPlan,
  type LegacyImportSourceFallback,
  type PlanLegacyReviewArtifactImportInput,
  planLegacyReviewArtifactImport,
} from "./legacy-review-import";
import {
  evaluateSealedReviewDocument,
  legacySoftwareMapBundle,
  materializeReviewRevision,
  prepareSavedMapNotes,
} from "./legacy-sealed-artifacts";
import { isMissingFileError } from "./native-agent/transcript-json";
import {
  installReviewArtifact,
  readReviewDocumentArtifact,
  readReviewSoftwareMapArtifact,
} from "./review-artifact-store";
import {
  type ReviewDocumentBundle,
  bundleReviewDocument,
  readReviewDocumentBundle,
} from "./review-bundle";
import { createLegacyCodeRecordMigrator } from "./review-code-target-migration";
import {
  type StoredReviewRecord,
  parseAnyStoredReviewRecord,
} from "./review-home";
import { stableJson, withReviewMutationLock } from "./review-mutation-lock";
import type {
  DocumentActivationCandidate,
  MapActivationCandidate,
} from "./review-publication-activation";
import {
  type DocumentPublicationRecord,
  type MapPublicationRecord,
  type ReviewPublicationRecord,
  type SourceContext,
  parsePublicationRecord,
  publicationSourceContext,
} from "./review-publication-record";
import { stageReviewDocumentPublication } from "./review-publication-staging";
import {
  assertNoActiveReviewAgentWrites,
  fingerprintReviewRepairInputs,
} from "./review-repair-state";
import { readPublication, readReviewRecord } from "./review-state-db";
import {
  type ReviewThreadDbMigrationOptions,
  copyReviewThreadDatabaseSnapshot,
  legacyReviewThreadDbPath,
  migrateReviewThreadDb,
  readReviewThreadDatabaseFingerprint,
  reviewThreadDbPath,
} from "./review-thread-store-backend";
import {
  type ReviewSoftwareMapBundle,
  readReviewSoftwareMapBundle,
  softwareMapArtifactBytes,
} from "./software-map-bundle";

/** The presented document already answers to a row whose stored artifact
 * reads back, or — for a legacy import — to a row the import plan carries. */
export interface ReviewRepairDocumentUnchanged {
  kind: "unchanged";
  publicationId: string;
}

/** Rebuilt document bytes and the row that will present them. */
export interface ReviewRepairDocumentReplacement {
  kind: "replace";
  candidate: DocumentActivationCandidate;
  bundle: ReviewDocumentBundle;
  usedEditableSources: boolean;
}

export type ReviewRepairDocument =
  | ReviewRepairDocumentUnchanged
  | ReviewRepairDocumentReplacement;

/** The presented map needs no new row; `null` when none is presented. */
export interface ReviewRepairMapUnchanged {
  kind: "unchanged";
  publicationId: string | null;
}

export interface ReviewRepairMapReplacement {
  kind: "replace";
  candidate: MapActivationCandidate;
  bundle: ReviewSoftwareMapBundle;
  usedEditableSources: boolean;
}

/** Only a schema that predates the required software map may end up with no
 * map at all after a repair. */
export interface ReviewRepairMapDropped {
  kind: "drop-absent";
}

export type ReviewRepairMap =
  | ReviewRepairMapUnchanged
  | ReviewRepairMapReplacement
  | ReviewRepairMapDropped;

/** A directory holding only the upgraded copy of a Review's own legacy
 * `review.db`; promotion swaps it in with a backup. */
export interface ReviewRepairThreadDatabase {
  dir: string;
}

/**
 * Everything a repair would commit, built without writing to the Review.
 *
 * Replacement artifacts are installed during preparation — the artifact store
 * is content-addressed and excluded from the authoring fingerprint, so a
 * refused repair leaves at most unreferenced bytes behind.
 */
export interface ReviewRepairCandidate {
  reviewUuid: string;
  /** The stored record text the activation guards against. */
  expectedRecordJson: string;
  expectedAuthoringFingerprint: string;
  /** Armed only when this repair owns an isolated legacy thread upgrade. */
  expectedThreadDbFingerprint?: string;
  upgradedThreadDb?: ReviewRepairThreadDatabase;
  storedSchemaVersion: number;
  /** Present when the repair replays a Git-era history into rows first. */
  legacyImport?: LegacyImportPlan;
  document: ReviewRepairDocument;
  map: ReviewRepairMap;
  next: StoredReviewRecord;
  cleanup: () => Promise<void>;
}

export type PreparedReviewRepair =
  | { kind: "noop"; review: StoredReviewRecord }
  | {
      kind: "prepared";
      review: StoredReviewRecord;
      candidate: ReviewRepairCandidate;
    };

/** Which presentations were rebuilt from editable sources rather than the
 * bytes the publication recorded. */
export function repairSourceFallback(
  candidate: ReviewRepairCandidate,
): LegacyImportSourceFallback {
  const legacy = candidate.legacyImport?.sourceFallback;
  return {
    document:
      candidate.document.kind === "replace"
        ? candidate.document.usedEditableSources
        : (legacy?.document ?? false),
    map:
      candidate.map.kind === "replace"
        ? candidate.map.usedEditableSources
        : (legacy?.map ?? false),
  };
}

interface ReviewRepairSnapshot {
  review: StoredReviewRecord;
  documentRevision: string;
  expectedRecordJson: string;
  expectedAuthoringFingerprint: string;
  storedSchemaVersion: number;
  /** Set only while the Review still owns an isolated legacy thread database. */
  threadDbFingerprint?: string;
}

/** Nothing under the Review directory is written except content-addressed
 * artifacts; promotion is the only writer of rows, pointers and files. */
export async function prepareReviewRepair(input: {
  reviewDir: string;
  warning?: (message: string) => void;
}): Promise<PreparedReviewRepair> {
  const reviewDir = path.resolve(input.reviewDir);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "review-repair-"));
  const cleanup = () => rm(temporaryRoot, { recursive: true, force: true });
  try {
    const snapshot = await snapshotReviewForRepair(reviewDir);
    const upgradedThreadDb = await upgradeLegacyThreadDatabase({
      reviewDir,
      temporaryRoot,
      review: snapshot.review,
      armed: snapshot.threadDbFingerprint !== undefined,
    });
    const plan = await planLegacyImport(snapshot, reviewDir, input.warning);
    const parts = plan
      ? importedParts(plan, snapshot.review.presentedSoftwareMapRevision)
      : await rebuildPresentations({
          reviewDir,
          temporaryRoot,
          snapshot,
          warning: input.warning,
        });
    if (
      (await fingerprintReviewRepairInputs(reviewDir)) !==
      snapshot.expectedAuthoringFingerprint
    )
      throw new Error(
        "Review authoring changed while preparing repair. Retry after active writes finish.",
      );
    if (
      snapshot.threadDbFingerprint !== undefined &&
      readReviewThreadDatabaseFingerprint(
        path.join(reviewDir, "review.mdx"),
      ) !== snapshot.threadDbFingerprint
    )
      throw new Error(
        "Review threads changed while preparing repair; retry after active writes finish.",
      );
    if (
      plan === null &&
      upgradedThreadDb === undefined &&
      parts.document.kind === "unchanged" &&
      parts.map.kind === "unchanged" &&
      snapshot.storedSchemaVersion === REVIEW_SCHEMA_VERSION
    ) {
      await cleanup();
      return { kind: "noop", review: snapshot.review };
    }
    const candidate: ReviewRepairCandidate = {
      reviewUuid: snapshot.review.uuid,
      expectedRecordJson: snapshot.expectedRecordJson,
      expectedAuthoringFingerprint: snapshot.expectedAuthoringFingerprint,
      storedSchemaVersion: snapshot.storedSchemaVersion,
      document: parts.document,
      map: parts.map,
      next: plan ? plan.next : nextRecord(snapshot.review),
      cleanup,
    };
    if (plan) candidate.legacyImport = plan;
    if (upgradedThreadDb) {
      candidate.upgradedThreadDb = upgradedThreadDb;
      // The upgrade only runs when the snapshot armed the guard, so the
      // fingerprint it recorded is the one promotion must still see.
      candidate.expectedThreadDbFingerprint = snapshot.threadDbFingerprint;
    }
    return { kind: "prepared", review: snapshot.review, candidate };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/**
 * The record a repair on a Review already carried by rows leaves behind. Only
 * the schema version can move here: the activation overwrites the pointer of
 * every presentation it replaces, and a dropped map only ever comes from a
 * legacy import, whose own `next` already states both pointers.
 */
function nextRecord(review: StoredReviewRecord): StoredReviewRecord {
  return { ...review, schemaVersion: REVIEW_SCHEMA_VERSION };
}

interface RepairedPresentations {
  document: ReviewRepairDocument;
  map: ReviewRepairMap;
}

/** A legacy import owns every row it replays, including the editable-source
 * rebuild of a presentation it could not convert, so the repair adds no rows
 * of its own beside it. */
function importedParts(
  plan: LegacyImportPlan,
  presentedMapRevision: string | null,
): RepairedPresentations {
  if (plan.activeDocumentId === null)
    throw new Error(
      "This Review has no current presentation. Run review publish instead.",
    );
  return {
    document: { kind: "unchanged", publicationId: plan.activeDocumentId },
    map:
      plan.activeMapId === null && presentedMapRevision !== null
        ? { kind: "drop-absent" }
        : { kind: "unchanged", publicationId: plan.activeMapId },
  };
}

/**
 * State A: the presented document does not answer to a publication row, or the
 * record still carries a Git-era schema, so the repair replays the private
 * history into rows first. `null` once every publication is already a row —
 * the same test `readStoredReview` uses to decide a Review needs importing.
 */
async function planLegacyImport(
  snapshot: ReviewRepairSnapshot,
  reviewDir: string,
  warning?: (message: string) => void,
): Promise<LegacyImportPlan | null> {
  if (
    snapshot.storedSchemaVersion === REVIEW_SCHEMA_VERSION &&
    readPublication(reviewDir, snapshot.documentRevision, "document") !== null
  )
    return null;
  const input: PlanLegacyReviewArtifactImportInput = {
    reviewDir,
    record: snapshot.review,
    original: storedRecordObject(snapshot.expectedRecordJson),
    activeDocumentFallback: "editable-source",
    activeMapFallback: "saved-map-notes",
    // The isolated thread upgrade this repair may own must not be folded into
    // the shared database until the repair is promoted.
    importThreads: false,
  };
  if (warning) input.warn = warning;
  const plan = await planLegacyReviewArtifactImport(input);
  return "imported" in plan ? null : plan;
}

function storedRecordObject(recordJson: string) {
  const value = jsonObject(parseJsonText(recordJson));
  if (!value) throw new Error("The stored Review record is not an object.");
  return value;
}

/** Reads what a repair is built from under the mutation lock and proves the
 * authoring tree did not move while it read. */
async function snapshotReviewForRepair(
  reviewDir: string,
): Promise<ReviewRepairSnapshot> {
  return withReviewMutationLock(reviewDir, async () => {
    assertNoActiveReviewAgentWrites(reviewDir);
    const stored = readReviewRecord(reviewDir);
    if (stored === null)
      throw new Error(`No Review record found for ${reviewDir}.`);
    const expectedRecordJson = stableJson(stored);
    const review = parseAnyStoredReviewRecord(stored);
    if (review.uuid !== path.basename(reviewDir))
      throw new Error("Review UUID does not match its storage directory.");
    const documentRevision = review.presentedDocumentRevision;
    if (!documentRevision)
      throw new Error(
        "This Review has no current presentation. Run review publish instead.",
      );
    const expectedAuthoringFingerprint =
      await fingerprintReviewRepairInputs(reviewDir);
    const snapshot: ReviewRepairSnapshot = {
      review,
      documentRevision,
      expectedRecordJson,
      expectedAuthoringFingerprint,
      storedSchemaVersion:
        jsonNumber(jsonObject(stored)?.schemaVersion) ?? REVIEW_SCHEMA_VERSION,
    };
    // The guard covers the isolated upgrade of a Review's own legacy thread
    // database. Once its threads live in the shared home database, that
    // database's bytes move for reasons unrelated to this Review, so
    // fingerprinting it would refuse repairs at random.
    const reviewMdxPath = path.join(reviewDir, "review.mdx");
    if (
      reviewThreadDbPath(reviewMdxPath) ===
      legacyReviewThreadDbPath(reviewMdxPath)
    )
      snapshot.threadDbFingerprint =
        readReviewThreadDatabaseFingerprint(reviewMdxPath);
    return snapshot;
  });
}

/** Copies the Review's own legacy thread database into the scratch directory
 * and upgrades the copy. The live database is never opened for writing. */
async function upgradeLegacyThreadDatabase(input: {
  reviewDir: string;
  temporaryRoot: string;
  review: StoredReviewRecord;
  armed: boolean;
}): Promise<ReviewRepairThreadDatabase | undefined> {
  if (!input.armed) return undefined;
  const dir = path.join(input.temporaryRoot, "threads");
  await mkdir(dir, { recursive: true });
  copyReviewThreadDatabaseSnapshot(
    path.join(input.reviewDir, "review.mdx"),
    path.join(dir, "review.mdx"),
  );
  const options: ReviewThreadDbMigrationOptions = {
    preserveLegacyQuestions: true,
  };
  if (input.review.sourceCommit)
    options.migrateLegacyCodeRecord = createLegacyCodeRecordMigrator({
      rootPath: input.review.worktreePath,
      baseCommit: input.review.baseCommit,
      headCommit: input.review.sourceCommit,
    });
  const result = await migrateReviewThreadDb(
    path.join(dir, "review.mdx"),
    options,
  );
  return result === "upgraded" ? { dir } : undefined;
}

interface RebuildInput {
  reviewDir: string;
  temporaryRoot: string;
  snapshot: ReviewRepairSnapshot;
  warning?: (message: string) => void;
}

/** State B: every publication is a row, so a repair only has to replace the
 * presentations whose artifact bytes no longer read back. */
async function rebuildPresentations(
  input: RebuildInput,
): Promise<RepairedPresentations> {
  const document = await repairPresentedDocument(input);
  const context =
    document.kind === "replace"
      ? document.candidate.context
      : publicationSourceContext(
          documentRecordOf(input.reviewDir, input.snapshot.documentRevision),
        );
  const map = await repairPresentedMap(input, context);
  return { document, map };
}

function documentRecordOf(
  reviewDir: string,
  publicationId: string,
): DocumentPublicationRecord {
  const row = readPublication(reviewDir, publicationId, "document");
  const record = row ? parsePublicationRecord(row.record) : null;
  if (record?.kind !== "document")
    throw new Error(
      `Publication ${publicationId} is not a Review document; run review migrate apply first.`,
    );
  return record;
}

/** The bytes a Git-era publication sealed, when its commit is still on disk. */
async function sealedRevisionDir(
  reviewDir: string,
  temporaryRoot: string,
  record: ReviewPublicationRecord,
  role: string,
): Promise<string | null> {
  const commit = record.legacy?.commit;
  if (!commit || !existsSync(path.join(reviewDir, ".git"))) return null;
  const dir = path.join(temporaryRoot, `${role}-${commit}`);
  await materializeReviewRevision(reviewDir, commit, dir);
  return dir;
}

async function repairPresentedDocument(
  input: RebuildInput,
): Promise<ReviewRepairDocument> {
  const publicationId = input.snapshot.documentRevision;
  const record = documentRecordOf(input.reviewDir, publicationId);
  if (
    record.artifact.state === "stored" &&
    (await readReviewDocumentArtifact(input.reviewDir, record.artifact.hash))
  )
    return { kind: "unchanged", publicationId };
  let sealedFailure = `The published Review document artifact of ${publicationId} is unavailable.`;
  try {
    const dir = await sealedRevisionDir(
      input.reviewDir,
      input.temporaryRoot,
      record,
      "document",
    );
    if (dir) {
      const bundle =
        (await readReviewDocumentBundle(dir, "/")) ??
        bundleReviewDocument(
          (await evaluateSealedReviewDocument(dir, input.warning)).document,
        );
      return {
        kind: "replace",
        candidate: await documentCandidate(input.reviewDir, record, bundle, {
          title: record.title,
          titleSource: record.titleSource,
        }),
        bundle,
        usedEditableSources: false,
      };
    }
  } catch (error) {
    sealedFailure = message(error);
  }
  input.warning?.(
    `Sealed document conversion failed: ${sealedFailure}. Using editable review.mdx/data.ts; reconcile unpublished edits without changing the Review's meaning. Validation does not prove semantic equivalence.`,
  );
  try {
    await requireEditableDocumentSource(input.reviewDir);
    const staged = await stageReviewDocumentPublication({
      review: {
        dir: input.reviewDir,
        review: {
          ...input.snapshot.review,
          ...publicationSourceContext(record),
        },
      },
    });
    for (const warning of staged.warnings) input.warning?.(warning);
    return {
      kind: "replace",
      candidate: await documentCandidate(
        input.reviewDir,
        record,
        staged.bundle,
        staged.title === undefined
          ? { title: record.title, titleSource: record.titleSource }
          : { title: staged.title, titleSource: "document" },
      ),
      bundle: staged.bundle,
      usedEditableSources: true,
    };
  } catch (fallbackError) {
    throw new Error(
      `Document repair failed. Sealed input: ${sealedFailure}. Editable input: ${message(fallbackError)}`,
    );
  }
}

async function requireEditableDocumentSource(reviewDir: string): Promise<void> {
  await readFile(path.join(reviewDir, "review.mdx"), "utf8").catch((error) => {
    if (isMissingFileError(error))
      throw new Error(
        `Missing editable Review input: ${path.join(reviewDir, "review.mdx")}. Restore that source file before retrying repair.`,
      );
    throw error;
  });
}

interface RepairedDocumentTitle {
  title: string;
  titleSource: DocumentPublicationRecord["titleSource"];
}

/** A repaired document keeps its predecessor's pinned code context: repair
 * replaces bytes, never the diff a presentation was published against. */
async function documentCandidate(
  reviewDir: string,
  previous: DocumentPublicationRecord,
  bundle: ReviewDocumentBundle,
  title: RepairedDocumentTitle,
): Promise<DocumentActivationCandidate> {
  const installed = await installReviewArtifact(
    reviewDir,
    "document",
    bundle.json,
  );
  return {
    kind: "document",
    artifactHash: installed.hash,
    title: title.title,
    titleSource: title.titleSource,
    context: publicationSourceContext(previous),
    operation: "repair",
  };
}

async function repairPresentedMap(
  input: RebuildInput,
  context: SourceContext,
): Promise<ReviewRepairMap> {
  const publicationId = input.snapshot.review.presentedSoftwareMapRevision;
  if (publicationId === null) return { kind: "unchanged", publicationId: null };
  const row = readPublication(input.reviewDir, publicationId, "map");
  const parsed = row ? parsePublicationRecord(row.record) : null;
  const record = parsed?.kind === "map" ? parsed : null;
  if (
    record?.artifact.state === "stored" &&
    (await readReviewSoftwareMapArtifact(input.reviewDir, record.artifact.hash))
  )
    return { kind: "unchanged", publicationId };
  let sealedFailure = `The published software map ${publicationId} is unavailable.`;
  try {
    const bundle = record ? await sealedMapBundle(input, record) : null;
    if (bundle)
      return {
        kind: "replace",
        candidate: await mapCandidate(input.reviewDir, bundle, context),
        bundle,
        usedEditableSources: false,
      };
  } catch (error) {
    sealedFailure = message(error);
  }
  input.warning?.(
    `Sealed software map conversion failed: ${sealedFailure}. Validating saved map notes at the current presentation's pinned commits.`,
  );
  try {
    const headCommit = context.sourceCommit;
    if (!headCommit)
      throw new Error(
        "The current map presentation has no pinned head commit.",
      );
    const bundle = await prepareSavedMapNotes({
      rootPath: input.snapshot.review.worktreePath,
      baseCommit: context.baseCommit,
      headCommit,
    });
    return {
      kind: "replace",
      candidate: await mapCandidate(input.reviewDir, bundle, context),
      bundle,
      usedEditableSources: true,
    };
  } catch (fallbackError) {
    throw new Error(
      `Software map repair failed. Sealed input: ${sealedFailure}. Saved map notes: ${message(fallbackError)}`,
    );
  }
}

/** `null` when the sealed revision holds no software map at all. */
async function sealedMapBundle(
  input: RebuildInput,
  record: MapPublicationRecord,
): Promise<ReviewSoftwareMapBundle | null> {
  const dir = await sealedRevisionDir(
    input.reviewDir,
    input.temporaryRoot,
    record,
    "map",
  );
  if (!dir) return null;
  return (
    (await readReviewSoftwareMapBundle(dir)) ??
    (await legacySoftwareMapBundle(dir))
  );
}

async function mapCandidate(
  reviewDir: string,
  bundle: ReviewSoftwareMapBundle,
  context: SourceContext,
): Promise<MapActivationCandidate> {
  const installed = await installReviewArtifact(
    reviewDir,
    "map",
    softwareMapArtifactBytes(bundle),
  );
  return {
    kind: "map",
    artifactHash: installed.hash,
    headCommit: bundle.headCommit,
    baseCommit: bundle.baseCommit,
    context,
    operation: "repair",
  };
}
