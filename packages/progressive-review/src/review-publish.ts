import type { Writable } from "node:stream";

import type { ReviewView } from "@dev.fast/review-protocol";

import { resolveAuthoringSessionRef } from "./authoring-session";
import { type CliJsonEvent, emitJsonEvent } from "./cli-output";
import type { ReviewDocumentDiagnostic } from "./document/diagnostics";
import { requestReviewLifecycle } from "./review-lifecycle-client";
import { ReviewPublicationResultSchema } from "./review-lifecycle-contracts";

interface PublishDiagnosticEvent extends CliJsonEvent {
  event: "error";
  file: string;
  line?: number;
  column?: number;
  message: string;
}

// The CLI formats the desktop-owned publication result.
export async function runReviewPublish(input: {
  cwd: string;
  reviewUuid?: string;
  view?: ReviewView;
  json?: boolean;
  toolingRoot?: string;
  stdout: Writable;
  stderr?: Writable;
  env?: NodeJS.ProcessEnv;
  onReviewBound?: (uuid: string) => void | Promise<void>;
}): Promise<number> {
  const reporter = createPublishReporter({
    json: input.json ?? false,
    stdout: input.stdout,
    stderr: input.stderr ?? process.stderr,
  });
  try {
    const result = ReviewPublicationResultSchema.parse(
      await requestReviewLifecycle("/lifecycle/publish", {
        cwd: input.cwd,
        reviewUuid: input.reviewUuid,
        view: input.view,
        agent: resolveAuthoringSessionRef(input.env ?? process.env),
      }),
    );
    for (const event of result.events) {
      switch (event.event) {
        case "review-bound":
          await input.onReviewBound?.(event.reviewUuid);
          break;
        case "stage":
          if (event.name !== "load")
            reporter.stage(event.name, event.status, event);
          break;
        case "warning":
          reporter.warning(event.stage, event.diagnostics);
          break;
        case "error":
          reporter.error(event.stage, event.diagnostics);
          break;
        case "diagnostics":
          reporter.validationErrors(event.diagnostics);
          break;
        case "document-published":
          reporter.published(
            event.revision,
            event.sessionId,
            event.softwareMapRevision,
          );
          break;
        case "map-published":
          throw new Error("Unexpected map publication result.");
      }
    }
    return result.ok ? 0 : 1;
  } catch (error) {
    reporter.error("publish", [
      error instanceof Error ? error.message : String(error),
    ]);
    return 1;
  }
}

type PublishStage = "validate" | "revision" | "mount";

interface PublishStageDetails {
  revision?: string;
  sessionId?: string;
  skipped?: boolean;
}

export interface PublishReporter {
  stage(
    name: PublishStage,
    status: "running" | "complete",
    details?: PublishStageDetails,
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

const STAGE_LABELS = {
  validate: "Validate document",
  revision: "Seal revision",
  mount: "Mount",
} satisfies Record<PublishStage, string>;

function createPublishReporter(input: {
  json: boolean;
  stdout: Writable;
  stderr: Writable;
}): PublishReporter {
  const emit = <T extends CliJsonEvent>(event: T) =>
    emitJsonEvent(input, event);
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
          const event: PublishDiagnosticEvent = {
            event: "error",
            file: diagnostic.filePath,
            message: diagnostic.message,
          };
          if (diagnostic.line) event.line = diagnostic.line;
          if (diagnostic.column) event.column = diagnostic.column;
          emit(event);
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
      const label = STAGE_LABELS[name];
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
