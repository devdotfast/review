import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  type JsonValue,
  type ReviewDesktopGlobalEvent,
  type ReviewSessionDescriptor,
  type ReviewVerbResponse,
  parseJsonText,
} from "@dev.fast/review-protocol";

import { promoteLegacyThreadDatabase } from "../review-artifact-promotion";
import {
  readReviewDocumentArtifact,
  readReviewSoftwareMapArtifact,
} from "../review-artifact-store";
import type { ReviewDocumentBundle } from "../review-bundle";
import {
  type StoredReview,
  type StoredReviewRecord,
  allowsAbsentSoftwareMap,
  parseAnyStoredReviewRecord,
  reviewDescriptor,
} from "../review-home";
import { stableJson, withReviewMutationLock } from "../review-mutation-lock";
import {
  type ActivationCandidate,
  type ReviewActivationCommit,
  buildActivationCandidateRows,
  commitReviewActivation,
} from "../review-publication-activation";
import {
  type DocumentPublicationRecord,
  type MapPublicationRecord,
  type ReviewPublicationRecord,
  type SourceContext,
  parsePublicationRecord,
  publicationSourceContext,
  reviewWithPublicationContext,
} from "../review-publication-record";
import type { ReviewRepairCandidate } from "../review-repair-preparation";
import {
  type ReviewRepairReadyResponse,
  assertNoActiveReviewAgentWrites,
  fingerprintReviewRepairInputs,
} from "../review-repair-state";
import {
  importLegacyReview,
  readPublication,
  readReviewRecord,
  reviewHomeForDir,
  upsertLegacyArtifactImportInTransaction,
} from "../review-state-db";
import {
  checkReviewThreadDbVersion,
  readReviewThreadDatabaseFingerprint,
} from "../review-thread-store-backend";
import type { ReviewSoftwareMapBundle } from "../software-map-bundle";
import { ReviewServerError } from "./http-json";
import type {
  ReviewSessionArtifactInput,
  ReviewSessionArtifactMap,
} from "./review-session-artifact";

export async function assertReviewRepairInputsUnchanged(
  dir: string,
  candidate: ReviewRepairCandidate,
): Promise<void> {
  if (
    stableJson(readReviewRecord(dir)) !==
      stableJson(parseJsonText(candidate.expectedRecordJson)) ||
    (await fingerprintReviewRepairInputs(dir)) !==
      candidate.expectedAuthoringFingerprint
  )
    throw new Error(
      "Review changed while preparing repair; retry without changing its pinned commits or review status.",
    );
  assertNoActiveReviewAgentWrites(dir);
  if (
    candidate.expectedThreadDbFingerprint &&
    readReviewThreadDatabaseFingerprint(path.join(dir, "review.mdx")) !==
      candidate.expectedThreadDbFingerprint
  )
    throw new Error("Review threads changed while preparing repair; retry.");
}

/** The publication record a repaired presentation is built from, whether it is
 * already a row or a row the pending legacy import will insert. */
function repairPublicationRecord(
  reviewDir: string,
  candidate: ReviewRepairCandidate,
  publicationId: string,
  kind: "document" | "map",
): ReviewPublicationRecord | null {
  const planned = candidate.legacyImport?.publications.find(
    (row) => row.publicationId === publicationId && row.kind === kind,
  );
  if (planned) return planned.record;
  const row = readPublication(reviewDir, publicationId, kind);
  return row ? parsePublicationRecord(row.record) : null;
}

function requireDocumentRecord(
  reviewDir: string,
  candidate: ReviewRepairCandidate,
  publicationId: string,
): DocumentPublicationRecord {
  const record = repairPublicationRecord(
    reviewDir,
    candidate,
    publicationId,
    "document",
  );
  if (record?.kind !== "document")
    throw new ReviewServerError(
      `Publication ${publicationId} is not a Review document.`,
      422,
      "repair_document_invalid",
    );
  return record;
}

/** The pinned code context the repaired document presents. */
function repairedDocumentContext(
  reviewDir: string,
  candidate: ReviewRepairCandidate,
): SourceContext {
  return candidate.document.kind === "replace"
    ? candidate.document.candidate.context
    : publicationSourceContext(
        requireDocumentRecord(
          reviewDir,
          candidate,
          candidate.document.publicationId,
        ),
      );
}

/** The record `next` may differ from the stored one only in its presentation
 * pointers and its schema version (invariant 7). */
function assertPreservedMetadata(
  previous: StoredReviewRecord,
  next: StoredReviewRecord,
): void {
  const comparable = (record: StoredReviewRecord) => ({
    ...record,
    schemaVersion: 0,
    presentedDocumentRevision: null,
    presentedSoftwareMapRevision: null,
  });
  if (!isDeepStrictEqual(comparable(previous), comparable(next)))
    throw new Error(
      "Prepared repair must preserve review status, pins, title, timestamps and attention metadata.",
    );
}

/**
 * Proves a prepared repair may be committed: the record it would leave keeps
 * every field a repair must not touch, its replacement bytes are the ones the
 * artifact store holds, and its presentations still pin the same diff.
 */
export async function validateRepairCandidate(
  reviewDir: string,
  candidate: ReviewRepairCandidate,
): Promise<StoredReviewRecord> {
  const previous = parseAnyStoredReviewRecord(
    parseJsonText(candidate.expectedRecordJson),
  );
  if (previous.uuid !== candidate.reviewUuid)
    throw new Error("Repair review UUID does not match its record.");
  if (!previous.presentedDocumentRevision)
    throw new Error("A draft without a presentation must use review publish.");
  if (
    previous.presentedSoftwareMapRevision === null &&
    presentsSoftwareMap(candidate)
  )
    throw new Error("Repair cannot invent an absent software map.");
  if (
    previous.presentedSoftwareMapRevision !== null &&
    !presentsSoftwareMap(candidate) &&
    !allowsAbsentSoftwareMap({ schemaVersion: candidate.storedSchemaVersion })
  )
    throw new Error("Repair cannot discard a presented software map.");
  assertPreservedMetadata(previous, candidate.next);
  const context = repairedDocumentContext(reviewDir, candidate);
  if (candidate.document.kind === "replace") {
    const replacement = candidate.document.candidate;
    const stored = await readReviewDocumentArtifact(
      reviewDir,
      replacement.artifactHash,
    );
    if (!stored || stored.json !== candidate.document.bundle.json)
      throw new ReviewServerError(
        "Repaired document JSON is invalid.",
        422,
        "repair_document_invalid",
      );
    const record = requireDocumentRecord(
      reviewDir,
      candidate,
      previous.presentedDocumentRevision,
    );
    if (
      !isDeepStrictEqual(replacement.context, publicationSourceContext(record))
    )
      throw new ReviewServerError(
        "Repaired document must preserve its presentation's pinned commits.",
        422,
        "repair_document_pins",
      );
  }
  if (candidate.map.kind === "replace") {
    const replacement = candidate.map.candidate;
    const stored = await readReviewSoftwareMapArtifact(
      reviewDir,
      replacement.artifactHash,
    );
    if (
      !stored ||
      stored.headCommit !== candidate.map.bundle.headCommit ||
      stored.baseCommit !== candidate.map.bundle.baseCommit
    )
      throw new ReviewServerError(
        "Repaired software map JSON is invalid.",
        422,
        "repair_map_invalid",
      );
    if (
      replacement.headCommit !== candidate.map.bundle.headCommit ||
      replacement.baseCommit !== candidate.map.bundle.baseCommit ||
      replacement.headCommit !== context.sourceCommit ||
      replacement.baseCommit !== context.baseCommit
    )
      throw new ReviewServerError(
        "Repaired software map must preserve its presentation's pinned commits.",
        422,
        "repair_map_pins",
      );
  }
  return candidate.next;
}

/** Whether the repair leaves the Review presenting a software map at all. */
function presentsSoftwareMap(candidate: ReviewRepairCandidate): boolean {
  if (candidate.map.kind === "drop-absent") return false;
  if (candidate.map.kind === "replace") return true;
  return candidate.map.publicationId !== null;
}

/** The only repair writer. Mount validation precedes this transaction; every
 * live input is checked again after acquiring the shared mutation lock. */
export async function applyPreparedReviewRepair(
  dir: string,
  candidate: ReviewRepairCandidate,
): Promise<StoredReviewRecord> {
  return withReviewMutationLock(dir, async () => {
    await assertReviewRepairInputsUnchanged(dir, candidate);
    const next = await validateRepairCandidate(dir, candidate);
    if (candidate.upgradedThreadDb)
      await promoteLegacyThreadDatabase({
        reviewDir: dir,
        candidateDir: candidate.upgradedThreadDb.dir,
      });
    checkReviewThreadDbVersion(path.join(dir, "review.mdx"));
    importLegacyReview(dir);
    const plan = candidate.legacyImport;
    const candidates = repairActivationCandidates(candidate);
    const commit: ReviewActivationCommit = {
      reviewDir: dir,
      home: reviewHomeForDir(dir),
      artifacts: [
        ...(plan?.publications ?? []).flatMap((row) =>
          row.artifactHash === null
            ? []
            : [{ kind: row.kind, hash: row.artifactHash }],
        ),
        ...candidates.map((entry) => ({
          kind: entry.kind,
          hash: entry.artifactHash,
        })),
      ],
      expected: { recordJson: candidate.expectedRecordJson },
      buildRows: (tx, latest) => [
        ...(plan?.publications ?? []).map((row) => ({
          publicationId: row.publicationId,
          record: row.record,
          artifactHash: row.artifactHash,
          previousPublicationId: row.previousPublicationId,
          legacyCommit: row.legacyCommit,
          seq: row.seq,
        })),
        ...buildActivationCandidateRows(tx, dir, latest, candidates),
      ],
      updateRecord: () => next,
    };
    if (plan) {
      // The stored record still carries its Git-era schema while an import is
      // pending; a Review already on rows is parsed strictly.
      commit.parseRecord = parseAnyStoredReviewRecord;
      // A legacy import owns both presentations — including the
      // editable-source rebuild it plans for one it could not convert — so it
      // never runs beside replacement candidates, and its replayed pointers
      // are the ones the record must end on.
      commit.presentedPointers = {
        document: plan.activeDocumentId,
        map: plan.activeMapId,
      };
      commit.inTransaction = (tx) =>
        upsertLegacyArtifactImportInTransaction(tx, dir, {
          importedAt: new Date().toISOString(),
          sourceHead: plan.sourceHead,
          versions: plan.versions,
          unavailable: plan.unavailable,
        });
    }
    const committed = await commitReviewActivation(commit);
    if (committed.mirrorWarning) console.warn(committed.mirrorWarning);
    return committed.review;
  });
}

/** The map is listed first so the document of the same activation pairs with
 * it. Empty for a repair whose rows all come from a pending legacy import. */
function repairActivationCandidates(
  candidate: ReviewRepairCandidate,
): ActivationCandidate[] {
  const candidates: ActivationCandidate[] = [];
  if (candidate.map.kind === "replace")
    candidates.push(candidate.map.candidate);
  if (candidate.document.kind === "replace")
    candidates.push(candidate.document.candidate);
  return candidates;
}

/** The subset of an active presentation session the promotion touches. */
export interface RepairPromotionSession {
  descriptor: { sessionId: string; sessionUrl: string };
  review: StoredReview;
  artifact: ReviewSessionArtifactInput;
  revision?: string;
  promoted: boolean;
  closing: boolean;
}

export interface RepairValidationRegistration {
  review: StoredReview;
  artifact: ReviewSessionArtifactInput;
  promoted: false;
  repairValidation: true;
  readOnlyThreadsPath?: string;
}

export interface PromoteReviewRepairInput<Session> {
  review: StoredReview;
  candidate: ReviewRepairCandidate;
  sessions: ReadonlyMap<string, Session>;
  registerSerialized: (
    registration: RepairValidationRegistration,
  ) => Promise<Session>;
  withReviewLock: <T>(
    reviewUuid: string,
    operation: () => Promise<T>,
  ) => Promise<T>;
  dispatch: (sessionId: string, verb: JsonValue) => Promise<ReviewVerbResponse>;
  startSessionTelemetry: (session: Session) => Promise<void>;
  closeSession: (
    session: Session,
    reason: "closed" | "replaced",
  ) => Promise<void>;
  broadcast: (event: ReviewDesktopGlobalEvent) => void;
  onPromoted?: () => void;
}

/** The CLI already validated and installed the repaired artifacts; the server
 * has the app mount them off-screen and activates them as publications only
 * when that mount is clean. */
export async function promoteReviewRepair<
  Session extends RepairPromotionSession & {
    descriptor: ReviewSessionDescriptor;
  },
>(
  input: PromoteReviewRepairInput<Session>,
): Promise<ReviewRepairReadyResponse> {
  const { review, candidate } = input;
  await input.withReviewLock(candidate.reviewUuid, () =>
    assertReviewRepairInputsUnchanged(review.dir, candidate),
  );
  await validateRepairCandidate(review.dir, candidate);
  const context = repairedDocumentContext(review.dir, candidate);
  const presented = reviewWithPublicationContext(review, context);
  const document = await repairedDocumentBundle(review.dir, candidate);
  const map = await repairedMapArtifact(review.dir, candidate);
  const registration: RepairValidationRegistration = {
    review: presented,
    artifact: {
      reviewUuid: presented.review.uuid,
      origin: { kind: "candidate" },
      document: { bundle: document.bundle },
      title: document.title,
      sourcePath: path.join(review.dir, "review.mdx"),
    },
    promoted: false,
    repairValidation: true,
  };
  if (map.artifact) registration.artifact.map = map.artifact;
  if (candidate.upgradedThreadDb)
    registration.readOnlyThreadsPath = path.join(
      candidate.upgradedThreadDb.dir,
      "review.mdx",
    );
  let successor: Session | undefined;
  try {
    successor = await input.registerSerialized(registration);
    const validation = await input.dispatch(successor.descriptor.sessionId, {
      name: "validateCanvasMount",
      args: {},
    });
    if (!validation.ok)
      throw new ReviewServerError(
        `Repaired Review failed to mount: ${validation.error ?? "unknown error"}`,
        422,
        "repair_mount_failed",
      );
    const mounted = successor;
    let repaired!: StoredReviewRecord;
    await input.withReviewLock(candidate.reviewUuid, async () => {
      if (
        mounted.closing ||
        input.sessions.get(mounted.descriptor.sessionId) !== mounted
      )
        throw new Error("Repair validation session closed before promotion.");
      repaired = await applyPreparedReviewRepair(review.dir, candidate);
      mounted.review = { dir: review.dir, review: repaired };
      const publicationId = repaired.presentedDocumentRevision;
      if (publicationId) {
        mounted.revision = publicationId;
        mounted.artifact.origin = {
          kind: "publication",
          publicationId,
          mapPublicationId: repaired.presentedSoftwareMapRevision,
        };
      }
      mounted.promoted = true;
      input.onPromoted?.();
    });
    // Once promoted, UI refresh failures cannot turn a committed repair into a failed command.
    await input.startSessionTelemetry(mounted).catch(() => undefined);
    const descriptor = await reviewDescriptor(mounted.review, {
      threads: "read-only",
    }).catch(() => undefined);
    input.broadcast({
      event: "session-registered",
      session: mounted.descriptor,
      review: descriptor,
    });
    await Promise.all(
      [...input.sessions.values()]
        .filter(
          (session) =>
            session !== mounted &&
            session.promoted &&
            session.review.review.uuid === candidate.reviewUuid,
        )
        .map((session) =>
          input.closeSession(session, "replaced").catch(() => undefined),
        ),
    );
    void input.dispatch(mounted.descriptor.sessionId, {
      name: "focusCanvas",
      args: {},
    });
    return {
      ok: true,
      status: repaired.status,
      oldDocumentRevision: review.review.presentedDocumentRevision,
      oldMapRevision: review.review.presentedSoftwareMapRevision,
      // SAFETY: validateRepairCandidate refuses a repair without a document.
      newDocumentRevision: repaired.presentedDocumentRevision!,
      newMapRevision: repaired.presentedSoftwareMapRevision,
      sessionId: mounted.descriptor.sessionId,
      url: mounted.descriptor.sessionUrl,
    };
  } finally {
    if (successor && !successor.promoted)
      await input.closeSession(successor, "closed").catch(() => undefined);
  }
}

interface RepairedDocumentMount {
  bundle: ReviewDocumentBundle;
  title: string | undefined;
}

async function repairedDocumentBundle(
  reviewDir: string,
  candidate: ReviewRepairCandidate,
): Promise<RepairedDocumentMount> {
  if (candidate.document.kind === "replace")
    return {
      bundle: candidate.document.bundle,
      title: candidate.document.candidate.title,
    };
  const record = requireDocumentRecord(
    reviewDir,
    candidate,
    candidate.document.publicationId,
  );
  const bundle =
    record.artifact.state === "stored"
      ? await readReviewDocumentArtifact(reviewDir, record.artifact.hash)
      : null;
  if (!bundle)
    throw new ReviewServerError(
      "Repaired document JSON is invalid.",
      422,
      "repair_document_invalid",
    );
  return { bundle, title: record.title };
}

interface RepairedMapMount {
  artifact: ReviewSessionArtifactMap | undefined;
}

async function repairedMapArtifact(
  reviewDir: string,
  candidate: ReviewRepairCandidate,
): Promise<RepairedMapMount> {
  if (candidate.map.kind === "drop-absent") return { artifact: undefined };
  if (candidate.map.kind === "replace")
    return { artifact: { bundle: candidate.map.bundle } };
  if (candidate.map.publicationId === null) return { artifact: undefined };
  const record = repairPublicationRecord(
    reviewDir,
    candidate,
    candidate.map.publicationId,
    "map",
  );
  const bundle = await storedMapBundle(reviewDir, record);
  if (!bundle)
    throw new ReviewServerError(
      "Repaired software map JSON is invalid.",
      422,
      "repair_map_invalid",
    );
  return { artifact: { bundle } };
}

async function storedMapBundle(
  reviewDir: string,
  record: ReviewPublicationRecord | null,
): Promise<ReviewSoftwareMapBundle | null> {
  const map: MapPublicationRecord | null =
    record?.kind === "map" ? record : null;
  if (map?.artifact.state !== "stored") return null;
  return readReviewSoftwareMapArtifact(reviewDir, map.artifact.hash);
}
