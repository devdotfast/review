import path from "node:path";

import { type JsonValue, parseJsonText } from "@dev.fast/review-protocol";

import {
  type ReviewArtifactKind,
  readReviewArtifactBytes,
} from "./review-artifact-store";
import {
  type StoredReviewRecord,
  parseStoredReviewRecord,
  refreshReviewMirror,
} from "./review-home";
import {
  type GuardedReviewField,
  ReviewChangedError,
  assertGuardedRecordUnchanged,
  stableJson,
  withReviewMutationLock,
} from "./review-mutation-lock";
import {
  type DocumentPublicationRecord,
  type MapPublicationRecord,
  PUBLICATION_RECORD_VERSION,
  type ReviewPublicationLegacyImport,
  type ReviewPublicationRecord,
  type SourceContext,
  newPublicationNonce,
  parsePublicationRecord,
  publicationIdFor,
} from "./review-publication-record";
import {
  type ReviewPublicationKind,
  type ReviewPublicationRow,
  type ReviewStateTransaction,
  insertPublicationInTransaction,
  putReviewRecordInTransaction,
  readPublicationInTransaction,
  readReviewRecordInTransaction,
  reviewHomeForDir,
  withReviewStateTransaction,
} from "./review-state-db";

/** An artifact a publication would reference is not in the store, so nothing
 * may point at it (invariant 3). */
export class ReviewArtifactUnavailableError extends Error {
  override readonly name = "ReviewArtifactUnavailableError";
  readonly code = "artifact_unavailable";
  readonly statusCode = 422;

  constructor(kind: ReviewArtifactKind, hash: string, reviewDir: string) {
    super(
      `Cannot activate a publication: no ${kind} artifact ${hash} under ` +
        `${reviewDir}.`,
    );
  }
}

/** The record changed between preparing a publication and committing it, so
 * the prepared bytes no longer describe the Review they were built from. */
export class ReviewActivationConflictError extends Error {
  override readonly name = "ReviewActivationConflictError";
  readonly code = "review_publication_conflict";
  readonly statusCode = 409;

  constructor() {
    super(
      "Review changed while preparing publication; rerun the publish command.",
    );
  }
}

/** A presentation pointer names no publication row of its kind. Every reader
 * resolves presentations through rows, so chaining a new publication onto a
 * pointer that answers nothing would bury the inconsistency in the history. */
export class ReviewPublicationMissingError extends Error {
  override readonly name = "ReviewPublicationMissingError";
  readonly code = "publication_missing";
  readonly statusCode = 422;
  readonly kind: ReviewPublicationKind;
  readonly publicationId: string;

  constructor(
    kind: ReviewPublicationKind,
    publicationId: string,
    reviewDir: string,
  ) {
    super(
      `The presented ${kind} of ${reviewDir} is ${publicationId}, which no ` +
        `${kind} publication row answers; run \`review repair\` first.`,
    );
    this.kind = kind;
    this.publicationId = publicationId;
  }
}

/** A software map pins a diff the document it is checked against does not.
 * `documentPublicationId` is null when that document is the one being
 * published beside the map, which has no ID until it is built. */
export class ReviewMapPinsMismatchError extends Error {
  override readonly name = "ReviewMapPinsMismatchError";
  readonly code = "map_pins_mismatch";
  readonly statusCode = 422;
  readonly documentPublicationId: string | null;

  constructor(documentPublicationId: string | null) {
    super(
      documentPublicationId === null
        ? "Software map pins do not match the Review document published beside it."
        : `Software map pins do not match document publication ${documentPublicationId}; ` +
            "republish the Review document first.",
    );
    this.documentPublicationId = documentPublicationId;
  }
}

export interface DocumentActivationCandidate {
  kind: "document";
  artifactHash: string;
  title: string;
  titleSource: "override" | "document" | "stored";
  context: SourceContext;
  operation: "publish" | "repair" | "tutorial" | "migration";
  legacy?: ReviewPublicationLegacyImport;
}

export interface MapActivationCandidate {
  kind: "map";
  artifactHash: string;
  /** The map's own diff pins, not the review's `SourceContext` pins. */
  headCommit: string;
  baseCommit: string;
  context: SourceContext;
  operation: "map-publish" | "repair" | "tutorial" | "migration";
  legacy?: ReviewPublicationLegacyImport;
}

export type ActivationCandidate =
  | DocumentActivationCandidate
  | MapActivationCandidate;

/** Synchronous observation points, in call order. Anything thrown from a hook
 * up to and including `beforeCommit` rolls the whole activation back. */
export interface ReviewActivationHooks {
  afterArtifactVerify?: () => void;
  afterPublicationInsert?: () => void;
  afterPointerUpdate?: () => void;
  beforeCommit?: () => void;
  afterCommit?: () => void;
  beforeMirror?: () => void;
}

/** The guarded fields the caller prepared against. */
export interface GuardedFieldsActivationGuard {
  guarded: Pick<StoredReviewRecord, GuardedReviewField>;
}

/** The exact record text the caller prepared against, compared key-order
 * independently; migration and import need the whole record, not the pins. */
export interface RecordTextActivationGuard {
  recordJson: string;
}

export type ActivationGuard =
  | GuardedFieldsActivationGuard
  | RecordTextActivationGuard;

export interface ActivatedPublication {
  publicationId: string;
  record: ReviewPublicationRecord;
  seq: number;
}

export interface ActivationResult {
  review: StoredReviewRecord;
  published: ActivatedPublication[];
  mirrorWarning?: string;
}

export type ActivationGate = (latest: StoredReviewRecord) => void;

export type ActivationRecordUpdate = (
  latest: StoredReviewRecord,
  published: ActivatedPublication[],
) => StoredReviewRecord;

export type ActivationTransactionWrite = (
  tx: ReviewStateTransaction,
  published: ActivatedPublication[],
) => void;

export interface ActivationInput {
  reviewDir: string;
  home?: string;
  expected: ActivationGuard;
  /** One or two candidates, at most one per kind. The map is activated first
   * so the document of the same call can pair with it. */
  candidates: readonly ActivationCandidate[];
  /** Runs under the mutation lock, before the transaction. */
  precheck?: () => Promise<void>;
  /** Run in order against the record read inside the transaction. */
  gates?: readonly ActivationGate[];
  /** Pure; the presentation pointers it sets are overwritten by the activated
   * publication IDs. */
  updateRecord: ActivationRecordUpdate;
  inTransaction?: ActivationTransactionWrite;
  hooks?: ReviewActivationHooks;
}

/** A publication row whose ID is already derived from its record. */
export interface PreparedPublicationRow {
  publicationId: string;
  record: ReviewPublicationRecord;
  artifactHash: string | null;
  previousPublicationId: string | null;
  legacyCommit: string | null;
}

export interface ReviewArtifactRef {
  kind: ReviewArtifactKind;
  hash: string;
}

/** The presentation pointers an activation leaves behind. A publish derives
 * them from the rows it just committed; an import replays a history whose
 * presented rows are not simply the last of each kind, so it states them. */
export interface ActivatedPointers {
  document: string | null;
  map: string | null;
}

/** How the record read inside the transaction is parsed. Publishing demands
 * the current schema; only an import may activate against an older one. */
export type ActivationRecordParser = (value: JsonValue) => StoredReviewRecord;

export type ActivationRowBuilder = (
  tx: ReviewStateTransaction,
  latest: StoredReviewRecord,
) => readonly PreparedPublicationRow[];

export interface ReviewActivationCommit {
  reviewDir: string;
  home: string;
  artifacts: readonly ReviewArtifactRef[];
  expected: ActivationGuard;
  gates?: readonly ActivationGate[];
  buildRows: ActivationRowBuilder;
  updateRecord: ActivationRecordUpdate;
  /** Overrides the pointers derived from the committed rows. */
  presentedPointers?: ActivatedPointers;
  /** Defaults to `parseStoredReviewRecord`: the record must be current. */
  parseRecord?: ActivationRecordParser;
  inTransaction?: ActivationTransactionWrite;
  hooks?: ReviewActivationHooks;
}

/**
 * The single commit path for publication rows: every artifact exists before
 * anything references it, then one short synchronous transaction guards the
 * record, runs the gates, inserts the rows, moves the pointers and lets the
 * caller write alongside. The mirror refresh is best effort and never fails
 * the activation. Callers hold the review's mutation lock.
 */
export async function commitReviewActivation(
  input: ReviewActivationCommit,
): Promise<ActivationResult> {
  for (const artifact of input.artifacts) {
    const bytes = await readReviewArtifactBytes(
      input.reviewDir,
      artifact.kind,
      artifact.hash,
    );
    if (bytes === null)
      throw new ReviewArtifactUnavailableError(
        artifact.kind,
        artifact.hash,
        input.reviewDir,
      );
  }
  input.hooks?.afterArtifactVerify?.();
  const committed = withReviewStateTransaction(
    input.home,
    (tx) => applyActivation(tx, input),
    { beforeCommit: input.hooks?.beforeCommit },
  );
  input.hooks?.afterCommit?.();
  input.hooks?.beforeMirror?.();
  const mirrorWarning = await refreshReviewMirror(
    input.reviewDir,
    committed.review,
  );
  const result: ActivationResult = {
    review: committed.review,
    published: committed.published,
  };
  if (mirrorWarning !== undefined) result.mirrorWarning = mirrorWarning;
  return result;
}

/**
 * Activates prepared document and map candidates: their artifacts become the
 * Review's presented publications, or nothing changes at all.
 */
export async function activateReviewPublication(
  input: ActivationInput,
): Promise<ActivationResult> {
  const reviewDir = path.resolve(input.reviewDir);
  if (input.candidates.length === 0)
    throw new Error("An activation needs at least one candidate.");
  const candidates = orderedCandidates(input.candidates);
  const home = input.home ?? reviewHomeForDir(reviewDir);
  return withReviewMutationLock(reviewDir, async () => {
    await input.precheck?.();
    return commitReviewActivation({
      reviewDir,
      home,
      artifacts: candidates.map((candidate) => ({
        kind: candidate.kind,
        hash: candidate.artifactHash,
      })),
      expected: input.expected,
      gates: input.gates,
      buildRows: (tx, latest) =>
        candidateRows(tx, reviewDir, latest, candidates),
      updateRecord: input.updateRecord,
      inTransaction: input.inTransaction,
      hooks: input.hooks,
    });
  });
}

interface ActivationCommitted {
  review: StoredReviewRecord;
  published: ActivatedPublication[];
}

function applyActivation(
  tx: ReviewStateTransaction,
  input: ReviewActivationCommit,
): ActivationCommitted {
  const latestJson = readReviewRecordInTransaction(tx, input.reviewDir);
  if (latestJson === null)
    throw new Error(`No Review record in the database for ${input.reviewDir}.`);
  const latest = (input.parseRecord ?? parseStoredReviewRecord)(latestJson);
  assertActivationGuard(latestJson, input.expected);
  for (const gate of input.gates ?? []) gate(latest);

  const published: ActivatedPublication[] = [];
  for (const row of input.buildRows(tx, latest)) {
    const outcome = insertPublicationInTransaction(tx, input.reviewDir, {
      publicationId: row.publicationId,
      kind: row.record.kind,
      record: row.record,
      createdAt: row.record.createdAt,
      operation: row.record.operation,
      artifactHash: row.artifactHash,
      previousPublicationId: row.previousPublicationId,
      legacyCommit: row.legacyCommit,
    });
    published.push({
      publicationId: row.publicationId,
      record: row.record,
      seq: outcome.seq,
    });
  }
  input.hooks?.afterPublicationInsert?.();

  const next: StoredReviewRecord = { ...input.updateRecord(latest, published) };
  if (input.presentedPointers) {
    next.presentedDocumentRevision = input.presentedPointers.document;
    next.presentedSoftwareMapRevision = input.presentedPointers.map;
  } else {
    for (const entry of published) {
      if (entry.record.kind === "document")
        next.presentedDocumentRevision = entry.publicationId;
      else next.presentedSoftwareMapRevision = entry.publicationId;
    }
  }
  const review = parseStoredReviewRecord(next);
  putReviewRecordInTransaction(tx, input.reviewDir, review);
  input.hooks?.afterPointerUpdate?.();
  input.inTransaction?.(tx, published);
  return { review, published };
}

function assertActivationGuard(
  latestJson: JsonValue,
  expected: ActivationGuard,
): void {
  if ("recordJson" in expected) {
    if (
      stableJson(latestJson) !== stableJson(parseJsonText(expected.recordJson))
    )
      throw new ReviewActivationConflictError();
    return;
  }
  try {
    assertGuardedRecordUnchanged(latestJson, expected.guarded);
  } catch (error) {
    if (error instanceof ReviewChangedError)
      throw new ReviewActivationConflictError();
    throw error;
  }
}

/**
 * Builds the publication rows for prepared candidates: content-derived IDs,
 * per-kind chaining from the presented rows, and the map/document cross-pin
 * checks. Exported so `review repair` can commit them in the same transaction
 * as the rows a pending legacy import replays.
 */
export function buildActivationCandidateRows(
  tx: ReviewStateTransaction,
  reviewDir: string,
  latest: StoredReviewRecord,
  candidates: readonly ActivationCandidate[],
): PreparedPublicationRow[] {
  return candidateRows(tx, reviewDir, latest, orderedCandidates(candidates));
}

/** The map first, so the document of the same call can pair with it. */
const ACTIVATION_ORDER: readonly ReviewPublicationKind[] = ["map", "document"];

function orderedCandidates(
  candidates: readonly ActivationCandidate[],
): ActivationCandidate[] {
  const ordered: ActivationCandidate[] = [];
  for (const kind of ACTIVATION_ORDER) {
    const matching = candidates.filter((candidate) => candidate.kind === kind);
    if (matching.length > 1)
      throw new Error(`An activation takes at most one ${kind} candidate.`);
    ordered.push(...matching);
  }
  return ordered;
}

/** The stored record is authoritative for both pointers, and both must answer
 * to a row before anything chains onto them. A repair that commits only the
 * rows of a pending legacy import brings no candidates and reads no pointer:
 * that import states the pointers itself. */
function candidateRows(
  tx: ReviewStateTransaction,
  reviewDir: string,
  latest: StoredReviewRecord,
  candidates: readonly ActivationCandidate[],
): PreparedPublicationRow[] {
  if (candidates.length === 0) return [];
  const createdAt = new Date().toISOString();
  const activeDocument = activePublicationRow(
    tx,
    reviewDir,
    latest.presentedDocumentRevision,
    "document",
  );
  const activeMap = activePublicationRow(
    tx,
    reviewDir,
    latest.presentedSoftwareMapRevision,
    "map",
  );
  const sameCallDocument = documentCandidateOf(candidates);
  let pairedMapPublicationId = activeMap?.publicationId ?? null;
  const rows: PreparedPublicationRow[] = [];
  for (const candidate of candidates) {
    const draft =
      candidate.kind === "map"
        ? mapDraft(
            candidate,
            latest.uuid,
            createdAt,
            activeMap?.publicationId ?? null,
            validatingDocumentId(candidate, sameCallDocument, activeDocument),
          )
        : documentDraft(
            candidate,
            latest.uuid,
            createdAt,
            activeDocument?.publicationId ?? null,
            pairedMapPublicationId,
          );
    const record = parsePublicationRecord(draft);
    const publicationId = publicationIdFor(record);
    if (record.kind === "map") pairedMapPublicationId = publicationId;
    rows.push({
      publicationId,
      record,
      artifactHash: candidate.artifactHash,
      previousPublicationId: record.previousPublicationId,
      legacyCommit: candidate.legacy?.commit ?? null,
    });
  }
  return rows;
}

function activePublicationRow(
  tx: ReviewStateTransaction,
  reviewDir: string,
  publicationId: string | null,
  kind: ReviewPublicationKind,
): ReviewPublicationRow | null {
  if (publicationId === null) return null;
  const row = readPublicationInTransaction(tx, reviewDir, publicationId, kind);
  if (row === null)
    throw new ReviewPublicationMissingError(kind, publicationId, reviewDir);
  return row;
}

function documentCandidateOf(
  candidates: readonly ActivationCandidate[],
): DocumentActivationCandidate | null {
  for (const candidate of candidates)
    if (candidate.kind === "document") return candidate;
  return null;
}

/**
 * A map is only valid against a document that saw the same diff, so the pins
 * are checked against the document the map will be presented with: the one
 * published beside it when there is one, else the presented publication. A
 * Review that presents neither has no diff to pin the map to, so it refuses.
 *
 * A document of the same call cannot be *named*, only checked: it is built
 * after the map so it can pair with it, and two content-derived IDs cannot
 * reference each other. Its `pairedMapPublicationId` carries the link instead.
 */
function validatingDocumentId(
  candidate: MapActivationCandidate,
  sameCallDocument: DocumentActivationCandidate | null,
  activeDocument: ReviewPublicationRow | null,
): string | null {
  if (sameCallDocument !== null) {
    assertMapPins(
      candidate,
      sameCallDocument.context.sourceCommit,
      sameCallDocument.context.baseCommit,
      null,
    );
    return null;
  }
  // Nothing to check the pins against: the Review presents no document at
  // all, so this map would be presented beside nothing (invariant 6).
  if (activeDocument === null) throw new ReviewMapPinsMismatchError(null);
  const document = parsePublicationRecord(activeDocument.record);
  if (document.kind !== "document")
    throw new ReviewMapPinsMismatchError(activeDocument.publicationId);
  assertMapPins(
    candidate,
    document.sourceCommit,
    document.baseCommit,
    activeDocument.publicationId,
  );
  return activeDocument.publicationId;
}

function assertMapPins(
  candidate: MapActivationCandidate,
  sourceCommit: string | null,
  baseCommit: string,
  documentPublicationId: string | null,
): void {
  if (
    sourceCommit !== candidate.headCommit ||
    baseCommit !== candidate.baseCommit
  )
    throw new ReviewMapPinsMismatchError(documentPublicationId);
}

function documentDraft(
  candidate: DocumentActivationCandidate,
  reviewUuid: string,
  createdAt: string,
  previousPublicationId: string | null,
  pairedMapPublicationId: string | null,
): DocumentPublicationRecord {
  const draft: DocumentPublicationRecord = {
    kind: "document",
    version: PUBLICATION_RECORD_VERSION,
    reviewUuid,
    createdAt,
    nonce: newPublicationNonce(),
    operation: candidate.operation,
    previousPublicationId,
    baseRef: candidate.context.baseRef,
    baseCommit: candidate.context.baseCommit,
    sourceCommit: candidate.context.sourceCommit,
    sourceIdentity: candidate.context.sourceIdentity,
    artifact: { state: "stored", hash: candidate.artifactHash },
    title: candidate.title,
    titleSource: candidate.titleSource,
    pairedMapPublicationId,
  };
  if (candidate.legacy) draft.legacy = candidate.legacy;
  return draft;
}

/** `baseCommit` is the map's own base pin and deliberately replaces the
 * context's, matching `MapPublicationRecordSchema`. */
function mapDraft(
  candidate: MapActivationCandidate,
  reviewUuid: string,
  createdAt: string,
  previousPublicationId: string | null,
  validatedDocumentPublicationId: string | null,
): MapPublicationRecord {
  const draft: MapPublicationRecord = {
    kind: "map",
    version: PUBLICATION_RECORD_VERSION,
    reviewUuid,
    createdAt,
    nonce: newPublicationNonce(),
    operation: candidate.operation,
    previousPublicationId,
    baseRef: candidate.context.baseRef,
    baseCommit: candidate.baseCommit,
    sourceCommit: candidate.context.sourceCommit,
    sourceIdentity: candidate.context.sourceIdentity,
    artifact: { state: "stored", hash: candidate.artifactHash },
    headCommit: candidate.headCommit,
    validatedDocumentPublicationId,
  };
  if (candidate.legacy) draft.legacy = candidate.legacy;
  return draft;
}
