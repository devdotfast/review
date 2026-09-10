import crypto from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  type JsonObject,
  type JsonValue,
  REVIEW_SCHEMA_VERSION,
  jsonObject,
  jsonString,
  parseJsonText,
} from "@dev.fast/review-protocol";

import { errorMessage } from "./error-message";
import {
  evaluateSealedReviewDocument,
  legacySoftwareMapBundle,
  prepareSavedMapNotes,
  readSealedMapManifestPins,
} from "./legacy-sealed-artifacts";
import { isMissingFileError } from "./native-agent/transcript-json";
import { installReviewArtifact } from "./review-artifact-store";
import {
  bundleReviewDocument,
  readReviewDocumentBundle,
} from "./review-bundle";
import {
  type StoredReviewRecord,
  allowsAbsentSoftwareMap,
  parseAnyStoredReviewRecord,
} from "./review-home";
import { stableJson, withReviewMutationLock } from "./review-mutation-lock";
import { commitReviewActivation } from "./review-publication-activation";
import {
  type DocumentPublicationRecord,
  type MapPublicationRecord,
  PUBLICATION_RECORD_VERSION,
  type ReviewPublicationArtifact,
  type ReviewPublicationLegacyImport,
  type ReviewPublicationRecord,
  parsePublicationRecord,
  publicationIdFor,
} from "./review-publication-record";
import { stageReviewDocumentPublication } from "./review-publication-staging";
import { assertNoActiveReviewAgentWrites } from "./review-repair-state";
import {
  type ReviewPublicationKind,
  ensureReviewRegistration,
  importLegacyReview,
  readLegacyArtifactImport,
  readPublication,
  readReviewRecord,
  reviewHomeForDir,
  reviewIdForDir,
  upsertLegacyArtifactImportInTransaction,
} from "./review-state-db";
import { type ReviewVcsLogEntry, reviewVcs } from "./review-vcs";
import {
  type ReviewSoftwareMapBundle,
  bundleReviewSoftwareMap,
  readReviewSoftwareMapBundle,
  softwareMapArtifactBytes,
} from "./software-map-bundle";
import type { NormalizedSoftwareModel } from "./software-map-model";

/** The message every Git-era `review publish` sealed its candidate with. */
export const LEGACY_PUBLISH_CANDIDATE_MESSAGE = "Review publish candidate";
const LEGACY_MAP_PUBLISH_MESSAGE = "Publish Review software map";
const LEGACY_TUTORIAL_MESSAGE = "Materialize bundled tutorial Review";

/** The sealed shape a publication row was converted from. */
export type LegacyArtifactLayout = ReviewPublicationLegacyImport["layout"];

/** A Git-era review whose history cannot be replayed faithfully. Importing it
 * would either lose or invent history, so nothing is written at all. */
export class LegacyImportBlocker extends Error {
  override readonly name = "LegacyImportBlocker";
  readonly code = "legacy_import_blocked";
  readonly statusCode = 422;
}

/** Which presentations were rebuilt from editable sources instead of the
 * sealed bytes, so a caller can warn that the import is not byte-faithful. */
export interface LegacyImportSourceFallback {
  document: boolean;
  map: boolean;
}

export interface PlannedPublication {
  publicationId: string;
  kind: ReviewPublicationKind;
  record: ReviewPublicationRecord;
  seq: number;
  artifactHash: string | null;
  previousPublicationId: string | null;
  legacyCommit: string;
}

export interface LegacyImportPlan {
  reviewId: string;
  /** The private history's head at plan time; null when nothing was read. */
  sourceHead: string | null;
  /** The record text the commit guards against, key-order independently. */
  expectedRecordJson: string;
  /** Rows to insert, oldest first; rows already committed are dropped. */
  publications: PlannedPublication[];
  activeDocumentId: string | null;
  activeMapId: string | null;
  /** Document versions the private history offered. */
  versions: number;
  /** Rows whose sealed bytes could not be converted. */
  unavailable: number;
  warnings: string[];
  sourceFallback: LegacyImportSourceFallback;
  next: StoredReviewRecord;
}

/** The review already carries an artifact-import marker: nothing to plan. */
export interface LegacyImportAlreadyDone {
  imported: true;
}

export type LegacyDocumentFallback = "none" | "editable-source";
export type LegacyMapFallback = "none" | "saved-map-notes";

export interface PlanLegacyReviewArtifactImportInput {
  reviewDir: string;
  /** The stored record, upgraded to the current schema. */
  record: StoredReviewRecord;
  /** The same record exactly as stored, for its original schema version. */
  original: JsonObject;
  home?: string;
  warn?: (message: string) => void;
  activeDocumentFallback?: LegacyDocumentFallback;
  activeMapFallback?: LegacyMapFallback;
  /**
   * Whether to fold a still-legacy per-review thread database into the shared
   * home database before planning. Defaults to true. `review repair` sets it
   * false: it upgrades that database in isolation and imports it only when
   * the repair is promoted, so planning must not touch it.
   */
  importThreads?: boolean;
}

export interface ImportLegacyReviewArtifactsInput {
  reviewDir: string;
  home?: string;
  warn?: (message: string) => void;
  activeDocumentFallback?: LegacyDocumentFallback;
  activeMapFallback?: LegacyMapFallback;
}

export interface LegacyReviewArtifactImportResult {
  record: StoredReviewRecord;
  /** False when the review was already imported and nothing was written. */
  imported: boolean;
  versions: number;
  unavailable: number;
  warnings: string[];
}

export function hasLegacyArtifactImport(
  reviewDir: string,
  home = reviewHomeForDir(reviewDir),
): boolean {
  return readLegacyArtifactImport(reviewDir, home) !== null;
}

/**
 * The publication ID a legacy map commit takes when the same commit is also a
 * document publication (tutorial materializations, and every schema-2 record
 * whose single `presentedRevision` presents both).
 */
export function legacyCompanionMapPublicationId(
  reviewId: string,
  commit: string,
): string {
  return crypto
    .createHash("sha256")
    .update("dev.fast/review-publication/legacy-map\0")
    .update(`${reviewId}\0${commit}`)
    .digest("hex")
    .slice(0, 40);
}

/**
 * Reads a Git-era review's private history and plans the rows and artifacts
 * that replay it. Nothing in the database changes here; converted bytes are
 * installed in the artifact store, which is immutable and content-addressed,
 * so a failed plan leaves only unreferenced artifacts behind.
 */
export async function planLegacyReviewArtifactImport(
  input: PlanLegacyReviewArtifactImportInput,
): Promise<LegacyImportPlan | LegacyImportAlreadyDone> {
  const reviewDir = path.resolve(input.reviewDir);
  const home = input.home ?? reviewHomeForDir(reviewDir);
  ensureReviewRegistration(reviewDir, home);
  if (input.importThreads !== false) importLegacyReview(reviewDir, home);
  const active = input.record.presentedDocumentRevision;
  // A record whose pointer already answers to a row needs no history read.
  const activeIsPublication =
    active === null ||
    readPublication(reviewDir, active, "document", home) !== null;
  // The marker alone is not enough to stop: `review repair` moves the pointer
  // to a freshly sealed Git revision after an import, and that revision still
  // has to be replayed. Re-planning is cheap — every row this import already
  // committed is dropped again, so only what the pointer added is inserted.
  if (activeIsPublication && hasLegacyArtifactImport(reviewDir, home))
    return { imported: true };
  const context: PlanContext = {
    reviewDir,
    home,
    reviewId: reviewIdForDir(reviewDir),
    record: input.record,
    importedAt: new Date().toISOString(),
    warnings: [],
    sourceFallback: { document: false, map: false },
    documentFallback: input.activeDocumentFallback ?? "none",
    mapFallback: input.activeMapFallback ?? "none",
    activeLegacySoftwareMap: null,
  };
  if (input.warn) context.warn = input.warn;
  const expectedRecordJson = JSON.stringify(input.original);
  // Published by the current path before the schema bump: already all rows.
  if (activeIsPublication) return pointersOnlyPlan(context, expectedRecordJson);
  const scratch = await mkdtemp(
    path.join(os.tmpdir(), "review-legacy-import-"),
  );
  try {
    return await planFromPrivateHistory(
      context,
      scratch,
      active,
      expectedRecordJson,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Commits a plan: every referenced artifact is verified, the rows are inserted
 * with the sequence and IDs the plan replayed, the record moves to its
 * imported pointers, and the import marker lands in the same transaction.
 */
export async function commitLegacyReviewArtifactImport(
  reviewDir: string,
  plan: LegacyImportPlan,
  home?: string,
): Promise<StoredReviewRecord> {
  const dir = path.resolve(reviewDir);
  const resolvedHome = home ?? reviewHomeForDir(dir);
  return withReviewMutationLock(dir, async () => {
    assertNoActiveReviewAgentWrites(dir);
    const committed = await commitReviewActivation({
      reviewDir: dir,
      home: resolvedHome,
      artifacts: plan.publications.flatMap((row) =>
        row.artifactHash === null
          ? []
          : [{ kind: row.kind, hash: row.artifactHash }],
      ),
      expected: { recordJson: plan.expectedRecordJson },
      buildRows: () =>
        plan.publications.map((row) => ({
          publicationId: row.publicationId,
          record: row.record,
          artifactHash: row.artifactHash,
          previousPublicationId: row.previousPublicationId,
          legacyCommit: row.legacyCommit,
          seq: row.seq,
        })),
      updateRecord: () => plan.next,
      // The record still carries its Git-era schema until this commit lands.
      parseRecord: parseAnyStoredReviewRecord,
      presentedPointers: {
        document: plan.activeDocumentId,
        map: plan.activeMapId,
      },
      inTransaction: (tx) =>
        upsertLegacyArtifactImportInTransaction(tx, dir, {
          importedAt: new Date().toISOString(),
          sourceHead: plan.sourceHead,
          versions: plan.versions,
          unavailable: plan.unavailable,
        }),
    });
    return committed.review;
  });
}

/** Plans and commits in one call, reading the stored record from the database
 * (`review.json` is only a mirror and may be older than the row). */
export async function importLegacyReviewArtifacts(
  input: ImportLegacyReviewArtifactsInput,
): Promise<LegacyReviewArtifactImportResult> {
  const reviewDir = path.resolve(input.reviewDir);
  const home = input.home ?? reviewHomeForDir(reviewDir);
  ensureReviewRegistration(reviewDir, home);
  importLegacyReview(reviewDir, home);
  const stored = readReviewRecord(reviewDir, home);
  const original = jsonObject(stored);
  if (stored === null || !original)
    throw new LegacyImportBlocker(
      `No Review record to import for ${reviewDir}.`,
    );
  const record = parseAnyStoredReviewRecord(stored);
  const planInput: PlanLegacyReviewArtifactImportInput = {
    reviewDir,
    record,
    original,
    home,
    activeDocumentFallback: input.activeDocumentFallback ?? "none",
    activeMapFallback: input.activeMapFallback ?? "none",
  };
  if (input.warn) planInput.warn = input.warn;
  const plan = await planLegacyReviewArtifactImport(planInput);
  if ("imported" in plan)
    return {
      record,
      imported: false,
      versions: 0,
      unavailable: 0,
      warnings: [],
    };
  return {
    record: await commitLegacyReviewArtifactImport(reviewDir, plan, home),
    imported: true,
    versions: plan.versions,
    unavailable: plan.unavailable,
    warnings: plan.warnings,
  };
}

interface PlanContext {
  reviewDir: string;
  home: string;
  reviewId: string;
  record: StoredReviewRecord;
  importedAt: string;
  warnings: string[];
  warn?: (message: string) => void;
  sourceFallback: LegacyImportSourceFallback;
  documentFallback: LegacyDocumentFallback;
  mapFallback: LegacyMapFallback;
  /** The active document's embedded map, when it had to be evaluated. */
  activeLegacySoftwareMap: LegacySoftwareModels | null;
}

interface LegacySoftwareModels {
  head: NormalizedSoftwareModel;
  base: NormalizedSoftwareModel;
}

/** What a committed document row offers the map rows that follow it. */
interface EmittedDocumentPins {
  publicationId: string;
  baseCommit: string;
  sourceCommit: string | null;
}

/** A document rebuilt from the editable sources because its sealed bundle
 * could not be converted; it stands beside the unavailable row it replaces. */
interface LegacyDocumentReplacement {
  artifactHash: string;
  title: string;
  titleSource: "document" | "stored";
}

interface LegacyDocumentVersion {
  oid: string;
  message: string;
  createdAt: string;
  embedded: StoredReviewRecord;
  pairedMapCommit: string | null;
  layout: LegacyArtifactLayout;
  artifactHash: string | null;
  replacement: LegacyDocumentReplacement | null;
}

interface LegacyMapVersion {
  commit: string;
  message: string;
  createdAt: string;
  embedded: StoredReviewRecord;
  layout: LegacyArtifactLayout;
  artifactHash: string | null;
  headCommit: string;
  baseCommit: string;
}

function pointersOnlyPlan(
  context: PlanContext,
  expectedRecordJson: string,
): LegacyImportPlan {
  return {
    reviewId: context.reviewId,
    sourceHead: null,
    expectedRecordJson,
    publications: [],
    activeDocumentId: context.record.presentedDocumentRevision,
    activeMapId: context.record.presentedSoftwareMapRevision,
    versions: 0,
    unavailable: 0,
    warnings: context.warnings,
    sourceFallback: context.sourceFallback,
    next: { ...context.record, schemaVersion: REVIEW_SCHEMA_VERSION },
  };
}

async function planFromPrivateHistory(
  context: PlanContext,
  scratch: string,
  active: string,
  expectedRecordJson: string,
): Promise<LegacyImportPlan> {
  const log = await reviewVcs.log(context.reviewDir);
  try {
    await reviewVcs.resolve(context.reviewDir, active);
  } catch (error) {
    throw new LegacyImportBlocker(
      `Cannot import ${context.reviewDir}: its presented revision is not in ` +
        `the private history (${errorMessage(error)}).`,
    );
  }
  const entries = legacyDocumentVersionEntries(log, active);
  if (!entries.some((entry) => entry.oid === active))
    throw new LegacyImportBlocker(
      `Cannot import ${context.reviewDir}: its presented revision is not in ` +
        "the private history.",
    );
  const documents: LegacyDocumentVersion[] = [];
  for (const entry of entries)
    documents.push(
      await convertDocumentVersion(context, scratch, entry, active),
    );
  const activeDocument = documents[documents.length - 1];
  if (!activeDocument)
    throw new LegacyImportBlocker(
      `Cannot import ${context.reviewDir}: it has no document versions.`,
    );
  const activeMapCommit =
    context.record.presentedSoftwareMapRevision ??
    activeDocument.pairedMapCommit;
  const maps = await convertMapCommits(context, scratch, log, {
    documents,
    activeMapCommit,
    activeDocument,
  });
  return buildPlan(context, {
    expectedRecordJson,
    sourceHead: log[0]?.oid ?? null,
    documents,
    maps,
    activeMapCommit,
  });
}

/** Exactly `listLegacyReviewDocumentVersions`' filter, oldest first: the log
 * from the presented revision back, keeping publish candidates and the
 * presented revision itself. */
function legacyDocumentVersionEntries(
  log: readonly ReviewVcsLogEntry[],
  active: string,
): ReviewVcsLogEntry[] {
  const currentIndex = log.findIndex((entry) => entry.oid === active);
  const presented = currentIndex === -1 ? log : log.slice(currentIndex);
  return presented
    .filter(
      (entry) =>
        entry.message === LEGACY_PUBLISH_CANDIDATE_MESSAGE ||
        entry.oid === active,
    )
    .reverse();
}

async function convertDocumentVersion(
  context: PlanContext,
  scratch: string,
  entry: ReviewVcsLogEntry,
  active: string,
): Promise<LegacyDocumentVersion> {
  const dir = path.join(scratch, `document-${entry.oid}`);
  await reviewVcs.materialize(context.reviewDir, entry.oid, dir);
  const { raw, record } = await readEmbeddedRecord(dir, entry.oid);
  const version = {
    oid: entry.oid,
    message: entry.message,
    createdAt: commitTimeIso(entry),
    embedded: record,
    pairedMapCommit: embeddedPairedMapCommit(raw),
    replacement: null,
  };
  const bundle = await readReviewDocumentBundle(dir, "/");
  if (bundle) {
    const installed = await installReviewArtifact(
      context.reviewDir,
      "document",
      bundle.json,
    );
    return {
      ...version,
      layout: "document-v2-json",
      artifactHash: installed.hash,
    };
  }
  const layout = await legacyDocumentLayout(dir);
  // Only the presented document is worth evaluating: a historical JavaScript
  // bundle runs code whose pinned worktree is usually long gone. A version
  // this import already committed keeps the bytes it chose then, so a re-plan
  // after `review repair` never downgrades a row it already stored.
  if (entry.oid !== active)
    return {
      ...version,
      layout,
      artifactHash:
        readPublication(context.reviewDir, entry.oid, "document", context.home)
          ?.artifactHash ?? null,
    };
  try {
    const evaluated = await evaluateSealedReviewDocument(dir, (message) =>
      warn(context, message),
    );
    if (evaluated.legacySoftwareMap)
      context.activeLegacySoftwareMap = evaluated.legacySoftwareMap;
    const installed = await installReviewArtifact(
      context.reviewDir,
      "document",
      bundleReviewDocument(evaluated.document).json,
    );
    return { ...version, layout, artifactHash: installed.hash };
  } catch (error) {
    if (context.documentFallback !== "editable-source")
      throw new LegacyImportBlocker(
        `Cannot import ${context.reviewDir}: the document sealed at ` +
          `${entry.oid} could not be converted (${errorMessage(error)}).`,
        { cause: error },
      );
    warn(
      context,
      `Sealed document conversion failed: ${errorMessage(error)}. Using ` +
        "editable review.mdx/data.ts; reconcile unpublished edits without " +
        "changing the Review's meaning. Validation does not prove semantic " +
        "equivalence.",
    );
    const staged = await stageReviewDocumentPublication({
      review: {
        dir: context.reviewDir,
        review: { ...context.record, ...sealedPins(record) },
      },
    });
    for (const warning of staged.warnings) warn(context, warning);
    const installed = await installReviewArtifact(
      context.reviewDir,
      "document",
      staged.bundle.json,
    );
    context.sourceFallback.document = true;
    return {
      ...version,
      layout,
      artifactHash: null,
      replacement: {
        artifactHash: installed.hash,
        title: staged.title ?? record.title,
        titleSource: staged.title === undefined ? "stored" : "document",
      },
    };
  }
}

interface MapConversionInput {
  documents: readonly LegacyDocumentVersion[];
  activeMapCommit: string | null;
  activeDocument: LegacyDocumentVersion;
}

/** Every commit some version pairs with, plus the presented map, converted
 * once. A commit no presented version depends on keeps its row but not its
 * bytes: only the presented map is worth rebuilding from JavaScript. */
async function convertMapCommits(
  context: PlanContext,
  scratch: string,
  log: readonly ReviewVcsLogEntry[],
  input: MapConversionInput,
): Promise<Map<string, LegacyMapVersion>> {
  const commits = new Set<string>();
  for (const document of input.documents)
    if (document.pairedMapCommit) commits.add(document.pairedMapCommit);
  if (input.activeMapCommit) commits.add(input.activeMapCommit);
  const converted = new Map<string, LegacyMapVersion>();
  for (const commit of commits) {
    const entry = log.find((candidate) => candidate.oid === commit);
    if (!entry)
      throw new LegacyImportBlocker(
        `Cannot import ${context.reviewDir}: software map revision ${commit} ` +
          "is not in the private history.",
      );
    const map = await convertMapCommit(context, scratch, entry, {
      convertible:
        commit === input.activeMapCommit ||
        commit === input.activeDocument.pairedMapCommit,
    });
    if (map) converted.set(commit, map);
  }
  return converted;
}

/** `null` when the revision legitimately presents no software map. */
async function convertMapCommit(
  context: PlanContext,
  scratch: string,
  entry: ReviewVcsLogEntry,
  options: { convertible: boolean },
): Promise<LegacyMapVersion | null> {
  const dir = path.join(scratch, `map-${entry.oid}`);
  await reviewVcs.materialize(context.reviewDir, entry.oid, dir);
  const { raw, record } = await readEmbeddedRecord(dir, entry.oid);
  const manifestPins = await readSealedMapManifestPins(dir);
  if (
    manifestPins &&
    (manifestPins.baseCommit !== record.baseCommit ||
      manifestPins.headCommit !== record.sourceCommit)
  )
    throw new LegacyImportBlocker(
      `Cannot import ${context.reviewDir}: the software-map manifest of ` +
        `${entry.oid} contradicts its sealed Review record.`,
    );
  const version = {
    commit: entry.oid,
    message: entry.message,
    createdAt: commitTimeIso(entry),
    embedded: record,
  };
  const stored = await readReviewSoftwareMapBundle(dir);
  if (stored)
    return {
      ...version,
      layout: "map-v2-json",
      ...(await installMap(context, stored)),
    };
  if (!options.convertible) {
    const pins = manifestPins ?? sealedRecordPins(record);
    // A row needs both pins. A historical map that cannot supply them is
    // dropped from the history rather than blocking the whole import; the
    // documents that paired with it import with no paired map.
    if (!pins) {
      warn(
        context,
        `Software map revision ${entry.oid} has no commit pins to record; ` +
          "it is not imported and the documents presented beside it keep no " +
          "paired map.",
      );
      return null;
    }
    return {
      ...version,
      layout: await legacyMapLayout(dir),
      artifactHash: null,
      headCommit: pins.headCommit,
      baseCommit: pins.baseCommit,
    };
  }
  const legacy = await legacySoftwareMapBundle(dir);
  if (legacy)
    return {
      ...version,
      layout: "map-v1-js",
      ...(await installMap(context, legacy)),
    };
  const embedded = context.activeLegacySoftwareMap;
  const pins = manifestPins ?? sealedRecordPins(record);
  if (embedded && pins)
    return {
      ...version,
      layout: "map-embedded-in-document",
      ...(await installMap(
        context,
        bundleReviewSoftwareMap({
          ...embedded,
          baseCommit: pins.baseCommit,
          headCommit: pins.headCommit,
        }),
      )),
    };
  if (allowsAbsentSoftwareMap({ schemaVersion: Number(raw.schemaVersion) }))
    return null;
  if (context.mapFallback === "saved-map-notes" && pins) {
    warn(
      context,
      `Sealed software map conversion failed: the sealed software map of ` +
        `${entry.oid} could not be converted. Validating saved map notes at ` +
        "the current presentation's pinned commits.",
    );
    const notes = await prepareSavedMapNotes({
      rootPath: context.record.worktreePath,
      baseCommit: pins.baseCommit,
      headCommit: pins.headCommit,
    });
    context.sourceFallback.map = true;
    return {
      ...version,
      layout: "unknown",
      ...(await installMap(context, notes)),
    };
  }
  throw new LegacyImportBlocker(
    `Cannot import ${context.reviewDir}: the software map sealed at ` +
      `${entry.oid} is missing.`,
  );
}

async function installMap(
  context: PlanContext,
  bundle: ReviewSoftwareMapBundle,
): Promise<{ artifactHash: string; headCommit: string; baseCommit: string }> {
  const installed = await installReviewArtifact(
    context.reviewDir,
    "map",
    softwareMapArtifactBytes(bundle),
  );
  return {
    artifactHash: installed.hash,
    headCommit: bundle.headCommit,
    baseCommit: bundle.baseCommit,
  };
}

interface PlanAssemblyInput {
  expectedRecordJson: string;
  sourceHead: string | null;
  documents: readonly LegacyDocumentVersion[];
  maps: ReadonlyMap<string, LegacyMapVersion>;
  activeMapCommit: string | null;
}

/** Rows in replay order: a map precedes every document that pairs with it, so
 * a document row can name the map publication it was presented beside. */
function buildPlan(
  context: PlanContext,
  input: PlanAssemblyInput,
): LegacyImportPlan {
  const documentIds = new Set(input.documents.map((document) => document.oid));
  const rows: PlannedPublication[] = [];
  const mapIds = new Map<string, string>();
  const emittedDocuments: EmittedDocumentPins[] = [];
  let previousDocument: string | null = null;
  let previousMap: string | null = null;

  const emitMap = (map: LegacyMapVersion): string => {
    const publicationId =
      documentIds.has(map.commit) ||
      readPublication(context.reviewDir, map.commit, "document", context.home)
        ? legacyCompanionMapPublicationId(context.reviewId, map.commit)
        : map.commit;
    const validated = emittedDocuments.findLast(
      (document) =>
        document.baseCommit === map.baseCommit &&
        document.sourceCommit === map.headCommit,
    );
    const record = mapPublicationRecord(context, map, {
      previousPublicationId: previousMap,
      validatedDocumentPublicationId: validated?.publicationId ?? null,
    });
    rows.push({
      publicationId,
      kind: "map",
      record,
      seq: rows.length + 1,
      artifactHash: map.artifactHash,
      previousPublicationId: previousMap,
      legacyCommit: map.commit,
    });
    previousMap = publicationId;
    mapIds.set(map.commit, publicationId);
    return publicationId;
  };

  const emitDocument = (
    publicationId: string,
    record: DocumentPublicationRecord,
    document: LegacyDocumentVersion,
    artifactHash: string | null,
  ): void => {
    rows.push({
      publicationId,
      kind: "document",
      record,
      seq: rows.length + 1,
      artifactHash,
      previousPublicationId: record.previousPublicationId,
      legacyCommit: document.oid,
    });
    previousDocument = publicationId;
    emittedDocuments.push({
      publicationId,
      baseCommit: record.baseCommit,
      sourceCommit: record.sourceCommit,
    });
  };

  for (const [index, document] of input.documents.entries()) {
    // The presented version pairs with the presented map even when its own
    // sealed record could not name it: a tutorial commit and a schema-2
    // presentation both seal the map they present in the same revision.
    const presented = index === input.documents.length - 1;
    const pairedCommit =
      document.pairedMapCommit ?? (presented ? input.activeMapCommit : null);
    const paired = pairedCommit === null ? null : input.maps.get(pairedCommit);
    if (paired && !mapIds.has(paired.commit)) emitMap(paired);
    const pairedMapPublicationId =
      pairedCommit === null ? null : (mapIds.get(pairedCommit) ?? null);
    const record = documentPublicationRecord(context, document, {
      previousPublicationId: previousDocument,
      pairedMapPublicationId,
      artifactHash: document.artifactHash,
      operation: legacyOperation(document.message, "document"),
      titleSource: "stored",
      title: document.embedded.title,
    });
    emitDocument(document.oid, record, document, document.artifactHash);
    if (document.replacement) {
      const replacement = documentPublicationRecord(context, document, {
        previousPublicationId: document.oid,
        pairedMapPublicationId,
        artifactHash: document.replacement.artifactHash,
        operation: "repair",
        titleSource: document.replacement.titleSource,
        title: document.replacement.title,
      });
      emitDocument(
        importedPublicationId(replacement),
        replacement,
        document,
        document.replacement.artifactHash,
      );
    }
  }
  for (const map of input.maps.values())
    if (!mapIds.has(map.commit)) emitMap(map);

  const activeDocumentId = previousDocument;
  const activeMapId =
    input.activeMapCommit === null
      ? null
      : (mapIds.get(input.activeMapCommit) ?? null);
  const next: StoredReviewRecord = {
    ...context.record,
    schemaVersion: REVIEW_SCHEMA_VERSION,
    presentedDocumentRevision: activeDocumentId,
    presentedSoftwareMapRevision: activeMapId,
  };
  return {
    reviewId: context.reviewId,
    sourceHead: input.sourceHead,
    expectedRecordJson: input.expectedRecordJson,
    publications: retainUncommittedRows(context, rows),
    activeDocumentId,
    activeMapId,
    versions: input.documents.length,
    unavailable: rows.filter((row) => row.artifactHash === null).length,
    warnings: context.warnings,
    sourceFallback: context.sourceFallback,
    next,
  };
}

/** A rerun after a failed commit replays the same rows: an identical row is
 * already committed and is dropped, and a different one means this history no
 * longer describes what was imported. */
function retainUncommittedRows(
  context: PlanContext,
  rows: readonly PlannedPublication[],
): PlannedPublication[] {
  return rows.filter((row) => {
    const existing = readPublication(
      context.reviewDir,
      row.publicationId,
      row.kind,
      context.home,
    );
    if (existing === null) return true;
    if (!sameImportedRecord(existing.record, row.record))
      throw new LegacyImportBlocker(
        `Cannot import ${context.reviewDir}: publication ${row.publicationId} ` +
          "is already committed with a different record.",
      );
    return false;
  });
}

function sameImportedRecord(
  committed: JsonValue,
  planned: ReviewPublicationRecord,
): boolean {
  let record: ReviewPublicationRecord;
  try {
    record = parsePublicationRecord(committed);
  } catch {
    return false;
  }
  return comparableImportedRecord(record) === comparableImportedRecord(planned);
}

/** Import time is the one field a replay cannot reproduce, so it is the one
 * field neither a row's identity nor its comparison may depend on. */
function withoutImportTime(
  record: ReviewPublicationRecord,
): ReviewPublicationRecord {
  if (!record.legacy) return record;
  return { ...record, legacy: { ...record.legacy, importedAt: "" } };
}

function comparableImportedRecord(record: ReviewPublicationRecord): string {
  return stableJson(withoutImportTime(record));
}

/** The content-derived ID of a row an import mints itself, stable across
 * replans of the same history. */
function importedPublicationId(record: ReviewPublicationRecord): string {
  return publicationIdFor(withoutImportTime(record));
}

interface DocumentRecordInput {
  previousPublicationId: string | null;
  pairedMapPublicationId: string | null;
  artifactHash: string | null;
  operation: DocumentPublicationRecord["operation"];
  title: string;
  titleSource: DocumentPublicationRecord["titleSource"];
}

function documentPublicationRecord(
  context: PlanContext,
  document: LegacyDocumentVersion,
  input: DocumentRecordInput,
): DocumentPublicationRecord {
  const draft: DocumentPublicationRecord = {
    kind: "document",
    version: PUBLICATION_RECORD_VERSION,
    reviewUuid: context.record.uuid,
    createdAt: document.createdAt,
    nonce: legacyImportNonce(
      context.record.uuid,
      input.operation === "repair" ? "document-repair" : "document",
      document.oid,
    ),
    operation: input.operation,
    previousPublicationId: input.previousPublicationId,
    ...sealedPins(document.embedded),
    artifact: legacyArtifact(input.artifactHash),
    title: input.title,
    titleSource: input.titleSource,
    pairedMapPublicationId: input.pairedMapPublicationId,
    legacy: legacyImport(
      context,
      document.oid,
      document.message,
      document.layout,
    ),
  };
  return asDocumentRecord(draft, document.oid);
}

interface MapRecordInput {
  previousPublicationId: string | null;
  validatedDocumentPublicationId: string | null;
}

function mapPublicationRecord(
  context: PlanContext,
  map: LegacyMapVersion,
  input: MapRecordInput,
): MapPublicationRecord {
  const draft: MapPublicationRecord = {
    kind: "map",
    version: PUBLICATION_RECORD_VERSION,
    reviewUuid: context.record.uuid,
    createdAt: map.createdAt,
    nonce: legacyImportNonce(context.record.uuid, "map", map.commit),
    operation: legacyOperation(map.message, "map"),
    previousPublicationId: input.previousPublicationId,
    ...sealedPins(map.embedded),
    baseCommit: map.baseCommit,
    artifact: legacyArtifact(map.artifactHash),
    headCommit: map.headCommit,
    validatedDocumentPublicationId: input.validatedDocumentPublicationId,
    legacy: legacyImport(context, map.commit, map.message, map.layout),
  };
  return asMapRecord(draft, map.commit);
}

function asDocumentRecord(
  draft: DocumentPublicationRecord,
  commit: string,
): DocumentPublicationRecord {
  const record = parseImportedRecord(draft, commit);
  if (record.kind !== "document")
    throw new LegacyImportBlocker(
      `Revision ${commit} did not replay as a document publication.`,
    );
  return record;
}

function asMapRecord(
  draft: MapPublicationRecord,
  commit: string,
): MapPublicationRecord {
  const record = parseImportedRecord(draft, commit);
  if (record.kind !== "map")
    throw new LegacyImportBlocker(
      `Revision ${commit} did not replay as a map publication.`,
    );
  return record;
}

/** A draft this module built that the record schema still rejects describes a
 * revision that cannot be replayed, not a caller error. */
function parseImportedRecord(
  draft: ReviewPublicationRecord,
  commit: string,
): ReviewPublicationRecord {
  try {
    return parsePublicationRecord(draft);
  } catch (error) {
    throw new LegacyImportBlocker(
      `Revision ${commit} cannot be replayed as a publication: ` +
        `${errorMessage(error)}.`,
      { cause: error },
    );
  }
}

function legacyArtifact(hash: string | null): ReviewPublicationArtifact {
  return hash === null
    ? { state: "unavailable", reason: "legacy-v1-javascript" }
    : { state: "stored", hash };
}

function legacyImport(
  context: PlanContext,
  commit: string,
  message: string,
  layout: LegacyArtifactLayout,
): ReviewPublicationLegacyImport {
  return { commit, layout, message, importedAt: context.importedAt };
}

/** Import rows replay a fixed history, so their records must be reproducible:
 * a random nonce would make a replanned import conflict with its own rows. */
function legacyImportNonce(
  reviewUuid: string,
  role: string,
  commit: string,
): string {
  return crypto
    .createHash("sha256")
    .update("dev.fast/review-publication/legacy-nonce\0")
    .update(`${reviewUuid}\0${role}\0${commit}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * The operation a sealed commit message replays as, per row kind:
 *
 * | message                             | document    | map          |
 * | ----------------------------------- | ----------- | ------------ |
 * | `Review publish candidate`          | `publish`   | `map-publish`|
 * | `Publish Review software map`       | `migration` | `map-publish`|
 * | `Materialize bundled tutorial …`    | `tutorial`  | `tutorial`   |
 * | anything else (`Migrate …`, repair) | `migration` | `migration`  |
 *
 * A map row minted from a publish-candidate commit is the companion of a
 * document sealed in the same revision, and a map presented from a document
 * commit is still a map publication.
 */
function legacyOperation(
  message: string,
  kind: ReviewPublicationKind,
): ReviewPublicationRecord["operation"] {
  if (message === LEGACY_TUTORIAL_MESSAGE) return "tutorial";
  if (kind === "map")
    return message === LEGACY_MAP_PUBLISH_MESSAGE ||
      message === LEGACY_PUBLISH_CANDIDATE_MESSAGE
      ? "map-publish"
      : "migration";
  return message === LEGACY_PUBLISH_CANDIDATE_MESSAGE ? "publish" : "migration";
}

/** The pinned code context the revision was sealed against. */
function sealedPins(record: StoredReviewRecord) {
  return {
    baseRef: record.baseRef,
    baseCommit: record.baseCommit,
    sourceCommit: record.sourceCommit,
    sourceIdentity: record.sourceIdentity,
  };
}

/** Full 40-hex map pins from a sealed record, when it has both. */
function sealedRecordPins(
  record: StoredReviewRecord,
): { baseCommit: string; headCommit: string } | null {
  const { baseCommit, sourceCommit } = record;
  if (!isCommitSha(baseCommit) || !isCommitSha(sourceCommit)) return null;
  return { baseCommit, headCommit: sourceCommit };
}

function isCommitSha(value: string | null): value is string {
  return value !== null && /^[0-9a-f]{40}$/i.test(value);
}

async function readEmbeddedRecord(
  dir: string,
  commit: string,
): Promise<{ raw: JsonObject; record: StoredReviewRecord }> {
  let text: string;
  try {
    text = await readFile(path.join(dir, "review.json"), "utf8");
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
    throw new LegacyImportBlocker(
      `Revision ${commit} seals no Review record; its publication context ` +
        "cannot be recovered.",
    );
  }
  let value: JsonValue;
  try {
    value = parseJsonText(text);
  } catch (error) {
    throw new LegacyImportBlocker(
      `Revision ${commit} seals a Review record that is not JSON: ` +
        `${errorMessage(error)}.`,
      { cause: error },
    );
  }
  const raw = jsonObject(value);
  if (!raw)
    throw new LegacyImportBlocker(
      `Revision ${commit} seals a Review record that is not an object.`,
    );
  try {
    return { raw, record: parseAnyStoredReviewRecord(value) };
  } catch (error) {
    throw new LegacyImportBlocker(
      `Revision ${commit} seals a Review record this build cannot read: ` +
        `${errorMessage(error)}.`,
      { cause: error },
    );
  }
}

/** Schema 2 sealed one `presentedRevision` for both presentations. */
function embeddedPairedMapCommit(raw: JsonObject): string | null {
  return (
    jsonString(raw.presentedSoftwareMapRevision) ??
    jsonString(raw.presentedRevision) ??
    null
  );
}

async function legacyDocumentLayout(
  dir: string,
): Promise<LegacyArtifactLayout> {
  if (await isFile(path.join(dir, ".bundle/document/manifest.json")))
    return "document-v1-js";
  if (await isFile(path.join(dir, ".bundle/manifest.json")))
    return "document-v1-js-root";
  return "unknown";
}

async function legacyMapLayout(dir: string): Promise<LegacyArtifactLayout> {
  return (await isFile(path.join(dir, ".bundle/software-map/manifest.json")))
    ? "map-v1-js"
    : "unknown";
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

function commitTimeIso(entry: ReviewVcsLogEntry): string {
  return new Date(entry.timestamp * 1_000).toISOString();
}

function warn(context: PlanContext, message: string): void {
  context.warnings.push(message);
  context.warn?.(message);
}
