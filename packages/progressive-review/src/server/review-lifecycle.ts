import {
  changeIdentityForRevision,
  resolveRevision,
} from "@dev.fast/local-vcs";
import type { ReviewView } from "@dev.fast/review-protocol";
import type { z } from "zod";

import {
  type SessionRef,
  authoringSessionKey,
  resolveAuthoringSessionRef,
} from "../authoring-session";
import { reviewArtifactHash } from "../review-artifact-store";
import { findScopedReview, touchReviewAgentSession } from "../review-home";
import {
  type ReviewPublicationEvent,
  ReviewPublishRequestSchema,
} from "../review-lifecycle-contracts";
import type { MapPublishReporter } from "../review-map-publish";
import {
  type PreparedDocumentCandidate,
  type PreparedSoftwareMapCandidate,
  prepareReviewSoftwareMapCandidate,
} from "../review-publication-candidate";
import {
  ReviewPublicationValidationError,
  prepareReviewSoftwareMapBundle,
} from "../review-publication-preparation";
import { parsePublicationRecord } from "../review-publication-record";
import {
  prepareReviewDocumentCandidate,
  stageReviewDocumentPublication,
} from "../review-publication-staging";
import type { PublishReporter } from "../review-publish";
import type { ReviewRebindJsonOutput, runReviewRebind } from "../review-rebind";
import { prepareReviewRepair } from "../review-repair-preparation";
import type {
  ReviewRepairReadyRequest,
  ReviewRepairReadyResponse,
} from "../review-repair-state";
import { repinReview } from "../review-scaffold";
import { readPublication } from "../review-state-db";
import { resolveReviewRoot } from "../runtime";
import {
  type ReviewSoftwareMapBundle,
  softwareMapArtifactBytes,
} from "../software-map-bundle";
import { span } from "../startup-trace";
import {
  prepareReviewPublish,
  resolvePublishReview,
} from "./publish-preparation";

// Caller identity is data, not an environment override or a storage location.
export function agentEnvironment(
  agent: SessionRef | undefined,
): NodeJS.ProcessEnv {
  return {
    DEV_FAST_AGENT_SESSION: agent ? authoringSessionKey(agent) : undefined,
  };
}

export async function repairReview(
  request: { cwd: string; reviewUuid: string },
  complete: (
    request: ReviewRepairReadyRequest,
  ) => Promise<ReviewRepairReadyResponse>,
) {
  const review = await findScopedReview(request.reviewUuid, {
    worktreePath: request.cwd,
    includeTerminal: true,
    includeLegacySchema: true,
  });
  if (!review)
    throw new Error(`Review not found in this checkout: ${request.reviewUuid}`);
  const warnings: string[] = [];
  const prepared = await prepareReviewRepair({
    reviewDir: review.dir,
    warning: (message) => warnings.push(message),
  });
  if (prepared.kind === "noop")
    return {
      ok: true as const,
      noop: true,
      reviewUuid: request.reviewUuid,
      warnings,
      status: prepared.review.status,
      oldDocumentRevision: prepared.review.presentedDocumentRevision,
      newDocumentRevision: prepared.review.presentedDocumentRevision,
      oldMapRevision: prepared.review.presentedSoftwareMapRevision,
      newMapRevision: prepared.review.presentedSoftwareMapRevision,
    };
  try {
    return {
      ...(await complete(prepared.request)),
      noop: false,
      reviewUuid: request.reviewUuid,
      warnings,
      sourceFallback: prepared.request.sourceFallback,
    };
  } finally {
    await prepared.cleanup();
  }
}

/** What the desktop reports once a document candidate is mounted and its
 * publication is committed. */
export interface MountedDocumentPublication {
  publicationId: string;
  mapPublicationId: string | null;
  sessionId: string;
  focusWarning?: string;
  mirrorWarning?: string;
}

export type CompleteDocumentPublication = (
  candidate: PreparedDocumentCandidate,
  options: { view?: ReviewView; agent?: SessionRef },
) => Promise<MountedDocumentPublication>;

export interface MountedSoftwareMapPublication {
  publicationId: string;
}

export type CompleteSoftwareMapPublication = (
  candidate: PreparedSoftwareMapCandidate,
  options: { agent?: SessionRef },
) => Promise<MountedSoftwareMapPublication>;

export async function publishReview(
  request: z.infer<typeof ReviewPublishRequestSchema>,
  complete: CompleteDocumentPublication,
) {
  const events: ReviewPublicationEvent[] = [];
  const reporter: PublishReporter = {
    stage: (name, status, details) =>
      events.push({ event: "stage", name, status, ...details }),
    warning: (stage, diagnostics) =>
      events.push({ event: "warning", stage, diagnostics }),
    error: (stage, diagnostics) =>
      events.push({ event: "error", stage, diagnostics }),
    validationErrors: (diagnostics) =>
      events.push({ event: "diagnostics", diagnostics }),
    published: (revision, sessionId, softwareMapRevision) =>
      events.push({
        event: "document-published",
        revision,
        sessionId,
        softwareMapRevision,
      }),
  };
  try {
    const code = await publishReviewDocument(
      {
        ...request,
        env: agentEnvironment(request.agent),
        onReviewBound: (reviewUuid) => {
          events.push({ event: "review-bound", reviewUuid });
        },
      },
      reporter,
      complete,
    );
    return { ok: code === 0, events };
  } catch (error) {
    reporter.error("publish", [
      error instanceof Error ? error.message : String(error),
    ]);
    return { ok: false, events };
  }
}

export async function publishReviewSoftwareMap(
  request: z.infer<typeof ReviewPublishRequestSchema>,
  complete: CompleteSoftwareMapPublication,
) {
  const events: ReviewPublicationEvent[] = [];
  const code = await publishReviewMap(
    { ...request, env: agentEnvironment(request.agent) },
    {
      stage: (name, status, details) =>
        events.push({ event: "stage", name, status, ...details }),
      error: (stage, diagnostics) =>
        events.push({ event: "error", stage, diagnostics }),
      published: (revision, documentRevision, unchanged) =>
        events.push({
          event: "map-published",
          revision,
          documentRevision,
          unchanged,
        }),
    },
    complete,
  );
  return { ok: code === 0, events };
}

export async function publishReviewDocument(
  input: {
    cwd: string;
    reviewUuid?: string;
    view?: ReviewView;
    toolingRoot?: string;
    env?: NodeJS.ProcessEnv;
    onReviewBound?: (uuid: string) => void | Promise<void>;
  },
  reporter: PublishReporter,
  complete: CompleteDocumentPublication,
): Promise<number> {
  const reviewRoot = await resolveReviewRoot(input.cwd);
  const prepared = await span("publish: prepare", () =>
    prepareReviewPublish({
      cwd: reviewRoot,
      reviewUuid: input.reviewUuid,
      onReviewBound: input.onReviewBound,
    }),
  );
  const review = prepared.review;
  if (prepared.warnings?.length) {
    reporter.warning("prepare", prepared.warnings);
  }

  reporter.stage("validate", "running");
  let candidate: PreparedDocumentCandidate;
  try {
    const document = await span("publish: validate document", () =>
      stageReviewDocumentPublication({ review }),
    );
    if (document.warnings.length > 0)
      reporter.warning("validate", document.warnings);
    reporter.stage("validate", "complete");
    reporter.stage("revision", "running");
    candidate = await span("publish: install document artifact", () =>
      prepareReviewDocumentCandidate({ review, document }),
    );
  } catch (error) {
    if (error instanceof ReviewPublicationValidationError) {
      if (error.warnings.length > 0) {
        reporter.warning("validate", error.warnings);
      }
      if (error.diagnostics) {
        reporter.validationErrors(error.diagnostics);
      } else {
        reporter.error("validate", error.errors);
      }
    } else {
      reporter.error("validate", [
        error instanceof Error ? error.message : String(error),
      ]);
    }
    return 1;
  }
  // The candidate's artifact is stored but unreferenced; its publication ID
  // only exists once the activation commits it.
  reporter.stage("revision", "complete");

  reporter.stage("mount", "running");
  const result = await complete(candidate, {
    view: input.view,
    agent: resolveAuthoringSessionRef(input.env ?? process.env),
  });
  reporter.published(
    result.publicationId,
    result.sessionId,
    result.mapPublicationId,
  );
  // The publication is committed and on screen by now: neither a stale
  // review.json mirror nor a focus failure can fail the publish, so both
  // report as warnings with exit 0.
  if (result.mirrorWarning) {
    reporter.warning("mount", [result.mirrorWarning]);
  }
  if (result.focusWarning) {
    reporter.warning("mount", [result.focusWarning]);
  }
  reporter.stage("mount", "complete", { sessionId: result.sessionId });
  return 0;
}

export async function publishReviewMap(
  input: { cwd: string; reviewUuid?: string; env?: NodeJS.ProcessEnv },
  report: MapPublishReporter,
  complete: CompleteSoftwareMapPublication,
): Promise<number> {
  try {
    const reviewRoot = await resolveReviewRoot(input.cwd);
    const review = await resolvePublishReview(reviewRoot, input.reviewUuid);
    const agent = resolveAuthoringSessionRef(input.env ?? process.env);
    const documentRevision = review.review.presentedDocumentRevision;
    if (!documentRevision) {
      throw new Error(
        "The Review document is not published. Run `review publish` first.",
      );
    }
    // A map is only ever published against a document publication, so a
    // pointer no row answers is a Git-era document. Task 9's import makes
    // this unreachable.
    const documentRow = readPublication(
      review.dir,
      documentRevision,
      "document",
    );
    if (!documentRow) {
      throw new Error(
        "The presented Review document predates JSON publications. " +
          "Republish the Review document first.",
      );
    }
    const presentedDocument = parsePublicationRecord(documentRow.record);
    if (
      presentedDocument.kind !== "document" ||
      !presentedDocument.sourceCommit
    ) {
      throw new Error(
        "The published Review document has no pinned head commit.",
      );
    }

    report.stage("validate", "running");
    let bundle;
    try {
      bundle = await prepareReviewSoftwareMapBundle({
        review,
        baseCommit: presentedDocument.baseCommit,
        headCommit: presentedDocument.sourceCommit,
      });
    } catch (error) {
      if (error instanceof ReviewPublicationValidationError) {
        report.error("validate", error.errors);
        return 1;
      }
      throw error;
    }
    report.stage("validate", "complete");

    const existingRevision = review.review.presentedSoftwareMapRevision;
    if (
      existingRevision &&
      publishesSameMapArtifact(review.dir, existingRevision, bundle)
    ) {
      // Identical bytes are not a new publication, but the run still belongs
      // to this agent, so the session stamp the mount would have made happens
      // here instead.
      if (agent) {
        await touchReviewAgentSession(
          review,
          authoringSessionKey(agent),
          "publisher",
        );
      }
      report.published(existingRevision, documentRevision, true);
      return 0;
    }

    report.stage("revision", "running");
    const candidate = await prepareReviewSoftwareMapCandidate({
      review,
      bundle,
    });
    report.stage("revision", "complete");

    report.stage("load", "running");
    const mounted = await complete(candidate, { agent });
    report.stage("load", "complete");
    report.published(mounted.publicationId, documentRevision, false);
    return 0;
  } catch (error) {
    report.error("publish", [
      error instanceof Error ? error.message : String(error),
    ]);
    return 1;
  }
}

/** The presented map already holds exactly these bytes, so publishing again
 * would only add a duplicate row. */
function publishesSameMapArtifact(
  reviewDir: string,
  publicationId: string,
  bundle: ReviewSoftwareMapBundle,
): boolean {
  const row = readPublication(reviewDir, publicationId, "map");
  if (!row) return false;
  const record = parsePublicationRecord(row.record);
  return (
    record.artifact.state === "stored" &&
    record.artifact.hash ===
      reviewArtifactHash(softwareMapArtifactBytes(bundle))
  );
}

export async function rebindReview(
  input: Omit<Parameters<typeof runReviewRebind>[0], "stdout">,
): Promise<ReviewRebindJsonOutput> {
  const reviewRoot = await resolveReviewRoot(input.cwd);
  const review = await resolvePublishReview(reviewRoot, input.reviewUuid);
  const resolved = await resolveRevision(
    review.review.worktreePath,
    input.change,
  );
  if (!resolved) {
    throw new Error(
      `Change does not resolve in ${review.review.worktreePath}: ${input.change}`,
    );
  }
  const sourceIdentity = await changeIdentityForRevision(
    review.review.worktreePath,
    input.change,
  );
  if (!sourceIdentity) {
    throw new Error(`Change does not resolve to one identity: ${input.change}`);
  }
  const repinned = await repinReview(
    review,
    {
      cwd: reviewRoot,
      toolingRoot: input.toolingRoot,
      progress: input.progress,
      env: input.env,
      createSourceAgentSession: input.createSourceAgentSession,
    },
    sourceIdentity,
  );
  const output: ReviewRebindJsonOutput = {
    event: "rebound",
    uuid: review.review.uuid,
    change: input.change,
  };
  if (repinned.warnings) output.warnings = repinned.warnings;
  return output;
}
