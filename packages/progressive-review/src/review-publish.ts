import { resolveAuthoringSessionRef } from "./authoring-session";
import { emitJsonEvent } from "./cli-output";
import type { ReviewDocumentDiagnostic } from "./compiler/review-document-compiler";
import { requireHealthyReviewDesktop } from "./desktop-discovery";
import { REVIEW_PUBLISH_CANDIDATE_MESSAGE } from "./review-document-versions";
import { sealReviewCandidate } from "./review-home";
import {
  ReviewPublicationValidationError,
  prepareReviewDocumentBundle,
} from "./review-publication-preparation";
import { resolveReviewRoot } from "./runtime";
import { prepareReviewPublish } from "./server/publish-preparation";

// The CLI owns the whole publish flow: it validates, bundles, resolves every
// code reference, and seals the revision. The desktop is only notified via
// /publish-ready and then serves the sealed bytes.
export async function runReviewPublish(input: {
  cwd: string;
  reviewUuid?: string;
  json?: boolean;
  toolingRoot?: string;
  stdout: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  env?: NodeJS.ProcessEnv;
}): Promise<number> {
  const reporter = createPublishReporter({
    json: input.json ?? false,
    stdout: input.stdout,
    stderr: input.stderr ?? process.stderr,
  });
  try {
    return await publish(input, reporter);
  } catch (error) {
    reporter.error("publish", [
      error instanceof Error ? error.message : String(error),
    ]);
    return 1;
  }
}

async function publish(
  input: {
    cwd: string;
    reviewUuid?: string;
    toolingRoot?: string;
    env?: NodeJS.ProcessEnv;
  },
  reporter: PublishReporter,
): Promise<number> {
  const reviewRoot = await resolveReviewRoot(input.cwd);
  const prepared = await prepareReviewPublish({
    cwd: reviewRoot,
    reviewUuid: input.reviewUuid,
  });
  const review = prepared.review;
  if (prepared.warnings?.length) {
    reporter.warning("prepare", prepared.warnings);
  }

  reporter.stage("validate", "running");
  let preparedDocument;
  try {
    preparedDocument = await prepareReviewDocumentBundle({ review });
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
  if (preparedDocument.warnings.length > 0) {
    reporter.warning("validate", preparedDocument.warnings);
  }
  reporter.stage("validate", "complete");

  reporter.stage("revision", "running");
  const revision = await sealReviewCandidate(
    review.dir,
    REVIEW_PUBLISH_CANDIDATE_MESSAGE,
  );
  reporter.stage("revision", "complete", { revision });

  const discovery = await requireHealthyReviewDesktop("review publish");
  reporter.stage("mount", "running");
  const response = await fetch(`${discovery.url}/publish-ready`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-review-token": discovery.token,
    },
    body: JSON.stringify({
      reviewUuid: prepared.uuid,
      revision,
      agent: resolveAuthoringSessionRef(input.env ?? process.env),
    }),
  });
  const result = (await response.json().catch(() => null)) as {
    ok?: boolean;
    sessionId?: string;
    url?: string;
    focusWarning?: string;
    error?: string;
  } | null;
  if (!response.ok || !result?.ok || !result.sessionId) {
    throw new Error(
      result?.error ??
        `Review Desktop returned ${response.status} for publish-ready.`,
    );
  }
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

interface PublishReporter {
  stage(
    name: string,
    status: "running" | "complete",
    details?: Record<string, unknown>,
  ): void;
  warning(stage: string, diagnostics: string[]): void;
  error(stage: string, diagnostics: string[]): void;
  validationErrors(diagnostics: ReviewDocumentDiagnostic[]): void;
  published(
    revision: string,
    sessionId: string,
    softwareMapRevision: string | null,
  ): void;
}

const STAGE_LABELS: Record<string, string> = {
  validate: "Validate document",
  revision: "Seal revision",
  mount: "Mount",
};

function createPublishReporter(input: {
  json: boolean;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}): PublishReporter {
  const emit = (event: Record<string, unknown>) => emitJsonEvent(input, event);
  if (input.json) {
    return {
      stage(name, status, details = {}) {
        emit({ event: "stage", name, status, ...details });
      },
      warning(stage, diagnostics) {
        emit({ event: "warning", stage, diagnostics });
      },
      error(stage, diagnostics) {
        emit({ event: "error", stage, diagnostics });
      },
      validationErrors(diagnostics) {
        for (const diagnostic of diagnostics) {
          emit({
            event: "error",
            file: diagnostic.filePath,
            ...(diagnostic.line ? { line: diagnostic.line } : {}),
            ...(diagnostic.column ? { column: diagnostic.column } : {}),
            message: diagnostic.message,
          });
        }
      },
      published(revision, sessionId, softwareMapRevision) {
        emit({
          event: "published",
          artifact: "document",
          revision,
          sessionId,
          presentedSoftwareMapRevision: softwareMapRevision,
        });
      },
    };
  }
  return {
    stage(name, status, details = {}) {
      if (status !== "complete") return;
      const label = STAGE_LABELS[name] ?? name;
      const suffix =
        "revision" in details
          ? ` ${String(details.revision).slice(0, 12)}`
          : details.skipped
            ? " (no code references)"
            : "";
      input.stdout.write(`${label}: ok${suffix}\n`);
    },
    warning(_stage, diagnostics) {
      for (const message of diagnostics) {
        input.stderr.write(`warning: ${message}\n`);
      }
    },
    error(_stage, diagnostics) {
      for (const message of diagnostics) {
        input.stderr.write(`error: ${message}\n`);
      }
    },
    validationErrors(diagnostics) {
      for (const diagnostic of diagnostics) {
        const location = [
          diagnostic.filePath,
          ...(diagnostic.line ? [diagnostic.line] : []),
          ...(diagnostic.line && diagnostic.column ? [diagnostic.column] : []),
        ].join(":");
        input.stderr.write(`error: ${location} ${diagnostic.message}\n`);
      }
    },
    published(revision, _sessionId, softwareMapRevision) {
      input.stdout.write(`Review document published: ${revision}\n`);
      if (softwareMapRevision) {
        input.stdout.write(`Software map remains: ${softwareMapRevision}\n`);
      } else {
        input.stdout.write("Software map: not published\n");
        input.stdout.write("Run `review map publish` when the map is ready.\n");
      }
    },
  };
}
