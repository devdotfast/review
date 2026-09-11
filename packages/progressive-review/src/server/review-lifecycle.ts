import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  changeIdentityForRevision,
  resolveRevision,
} from "@dev.fast/local-vcs";
import type {
  ReviewPublishReadyRequest,
  ReviewView,
} from "@dev.fast/review-protocol";
import type { z } from "zod";

import {
  type SessionRef,
  authoringSessionKey,
  resolveAuthoringSessionRef,
} from "../authoring-session";
import {
  type StoredReview,
  findScopedReview,
  parseAnyStoredReviewRecord,
  sealReviewCandidate,
  touchReviewAgentSession,
} from "../review-home";
import {
  type ReviewPublicationEvent,
  ReviewPublishRequestSchema,
} from "../review-lifecycle-contracts";
import type { MapPublishReporter } from "../review-map-publish";
import {
  assertReviewUnchanged,
  withReviewMutationLock,
} from "../review-mutation-lock";
import {
  ReviewPublicationValidationError,
  prepareReviewSoftwareMapBundle,
} from "../review-publication-preparation";
import {
  sealReviewDocumentPublication,
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
import { resolveReviewRoot } from "../runtime";
import {
  type ReviewSoftwareMapBundle,
  readReviewSoftwareMapBundle,
  sameReviewSoftwareMapBundle,
  writeReviewSoftwareMapBundle,
} from "../software-map-bundle";
import { span } from "../startup-trace";
import {
  prepareReviewPublish,
  resolvePublishReview,
} from "./publish-preparation";
import { materializePublishRevision } from "./publish-stage";

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
    worktreePath: await resolveReviewRoot(request.cwd),
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

export async function publishReview(
  request: z.infer<typeof ReviewPublishRequestSchema>,
  complete: (
    request: ReviewPublishReadyRequest,
  ) => Promise<{ sessionId: string; focusWarning?: string }>,
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
  complete: (request: ReviewPublishReadyRequest) => Promise<void>,
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
  complete: (
    request: ReviewPublishReadyRequest,
  ) => Promise<{ sessionId: string; focusWarning?: string }>,
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
  let revision: string;

  try {
    const document = await span("publish: validate document", () =>
      stageReviewDocumentPublication({ review }),
    );

    if (document.warnings.length > 0)
      reporter.warning("validate", document.warnings);
    reporter.stage("validate", "complete");
    reporter.stage("revision", "running");
    revision = await span("publish: seal revision", () =>
      sealReviewDocumentPublication({ review, document }),
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

  reporter.stage("revision", "complete", { revision });

  reporter.stage("mount", "running");

  const result = await complete({
    reviewUuid: prepared.uuid,
    revision,
    view: input.view,
    agent: resolveAuthoringSessionRef(input.env ?? process.env),
  });

  reporter.published(
    revision,
    result.sessionId,
    review.review.presentedSoftwareMapRevision,
  );

  // The revision is promoted and on screen by now: a focus failure cannot
  // make the publish a failure, so it reports as a warning with exit 0.
  if (result.focusWarning) {
    reporter.warning("mount", [result.focusWarning]);
  }

  reporter.stage("mount", "complete", { sessionId: result.sessionId });

  return 0;
}

export async function publishReviewMap(
  input: { cwd: string; reviewUuid?: string; env?: NodeJS.ProcessEnv },
  report: MapPublishReporter,
  complete: (request: ReviewPublishReadyRequest) => Promise<void>,
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

    const documentBuildDir = await materializePublishRevision({
      review,
      revision: documentRevision,
    });

    const presentedDocument = parseAnyStoredReviewRecord(
      JSON.parse(
        await readFile(path.join(documentBuildDir, "review.json"), "utf8"),
      ),
    );

    if (!presentedDocument.sourceCommit) {
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

    if (existingRevision) {
      const existingDir = await materializePublishRevision({
        review,
        revision: existingRevision,
      });

      const existing = await readReviewSoftwareMapBundle(existingDir);

      if (existing && sameReviewSoftwareMapBundle(existing, bundle)) {
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
    }

    report.stage("revision", "running");

    const revision = await sealReviewSoftwareMapPublication({
      review,
      bundle,
    });

    report.stage("revision", "complete", { revision });

    report.stage("load", "running");
    await complete({ reviewUuid: review.review.uuid, revision, agent });
    report.stage("load", "complete");
    report.published(revision, documentRevision, false);

    return 0;
  } catch (error) {
    report.error("publish", [
      error instanceof Error ? error.message : String(error),
    ]);

    return 1;
  }
}

export async function sealReviewSoftwareMapPublication(input: {
  review: StoredReview;
  bundle: ReviewSoftwareMapBundle;
}): Promise<string> {
  return withReviewMutationLock(input.review.dir, async () => {
    await assertReviewUnchanged(input.review.dir, input.review.review);
    await writeReviewSoftwareMapBundle(input.review.dir, input.bundle);

    return sealReviewCandidate(input.review.dir, "Publish Review software map");
  });
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
