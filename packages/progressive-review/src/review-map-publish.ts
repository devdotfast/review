import type { Writable } from "node:stream";

import { resolveAuthoringSessionRef } from "./authoring-session";
import { type CliJsonEvent, emitJsonEvent } from "./cli-output";
import { requestReviewLifecycle } from "./review-lifecycle-client";
import { ReviewPublicationResultSchema } from "./review-lifecycle-contracts";

export async function runReviewMapPublish(input: {
  cwd: string;
  reviewUuid?: string;
  json?: boolean;
  stdout: Writable;
  stderr: Writable;
  env?: NodeJS.ProcessEnv;
}): Promise<number> {
  const report = mapPublishReporter(input);
  try {
    const result = ReviewPublicationResultSchema.parse(
      await requestReviewLifecycle("/lifecycle/map/publish", {
        cwd: input.cwd,
        reviewUuid: input.reviewUuid,
        agent: resolveAuthoringSessionRef(input.env ?? process.env),
      }),
    );
    for (const event of result.events) {
      switch (event.event) {
        case "stage":
          report.stage(event.name, event.status, event);
          break;
        case "warning":
          report.warning(event.stage, event.diagnostics);
          break;
        case "error":
          report.error(event.stage, event.diagnostics);
          break;
        case "map-published":
          report.published(
            event.revision,
            event.documentRevision,
            event.unchanged,
          );
          break;
        default:
          throw new Error("Unexpected document publication result.");
      }
    }
    return result.ok ? 0 : 1;
  } catch (error) {
    report.error("publish", [
      error instanceof Error ? error.message : String(error),
    ]);
    return 1;
  }
}

interface MapPublishStageDetails {
  revision?: string;
}

export interface MapPublishReporter {
  stage(
    name: "validate" | "revision" | "mount" | "load",
    status: "running" | "complete",
    details?: MapPublishStageDetails,
  ): void;
  warning(stage: string, diagnostics: string[]): void;
  error(stage: string, diagnostics: string[]): void;
  published(
    revision: string,
    documentRevision: string,
    unchanged: boolean,
  ): void;
}

function mapPublishReporter(input: {
  json?: boolean;
  stdout: Writable;
  stderr: Writable;
}): MapPublishReporter {
  if (input.json) {
    const emit = <T extends CliJsonEvent>(event: T) =>
      emitJsonEvent(input, event);
    return {
      stage: (name, status, details = {}) =>
        emit({
          event: "stage",
          artifact: "software-map",
          name,
          status,
          ...details,
        }),
      warning: (stage, diagnostics) =>
        emit({
          event: "warning",
          artifact: "software-map",
          stage,
          diagnostics,
        }),
      error: (stage, diagnostics) =>
        emit({ event: "error", artifact: "software-map", stage, diagnostics }),
      published: (revision, documentRevision, unchanged) =>
        emit({
          event: "published",
          artifact: "software-map",
          revision,
          presentedDocumentRevision: documentRevision,
          unchanged,
        }),
    };
  }
  return {
    stage(name, status, details = {}) {
      if (status !== "complete") return;
      const suffix =
        details.revision === undefined
          ? ""
          : ` ${details.revision.slice(0, 12)}`;
      input.stdout.write(
        `${name === "load" ? "Load map" : name}: ok${suffix}\n`,
      );
    },
    warning(_stage, diagnostics) {
      for (const diagnostic of diagnostics) {
        input.stderr.write(`warning: ${diagnostic}\n`);
      }
    },
    error(_stage, diagnostics) {
      for (const diagnostic of diagnostics) {
        input.stderr.write(`error: ${diagnostic}\n`);
      }
    },
    published(revision, documentRevision, unchanged) {
      input.stdout.write(`Software map published: ${revision}\n`);
      input.stdout.write(`Review document remains: ${documentRevision}\n`);
      if (unchanged) input.stdout.write("Software map bytes are unchanged.\n");
    },
  };
}
