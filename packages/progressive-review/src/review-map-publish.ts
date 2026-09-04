import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  authoringSessionKey,
  resolveAuthoringSessionRef,
} from "./authoring-session";
import { emitJsonEvent } from "./cli-output";
import { readReviewDesktopDiscovery } from "./desktop-discovery";
import { parseStoredReviewRecord, sealReviewCandidate } from "./review-home";
import {
  ReviewPublicationValidationError,
  prepareReviewSoftwareMapBundle,
} from "./review-publication-preparation";
import { resolveReviewRoot } from "./runtime";
import { resolvePublishReview } from "./server/publish-preparation";
import { materializePublishRevision } from "./server/publish-stage";
import { reviewStateService } from "./server/review-state-service";
import {
  readReviewSoftwareMapBundle,
  sameReviewSoftwareMapBundle,
  writeReviewSoftwareMapBundle,
} from "./software-map-bundle";

export async function runReviewMapPublish(input: {
  cwd: string;
  reviewUuid?: string;
  json?: boolean;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  env?: NodeJS.ProcessEnv;
}): Promise<number> {
  const report = mapPublishReporter(input);
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
    const presentedDocument = parseStoredReviewRecord(
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
          await reviewStateService.touchAgentSession(
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
    await writeReviewSoftwareMapBundle(review.dir, bundle);
    const revision = await sealReviewCandidate(
      review.dir,
      "Publish Review software map",
    );
    report.stage("revision", "complete", { revision });

    const discovery = await readReviewDesktopDiscovery();
    if (!discovery) {
      throw new Error(
        "Review Desktop is not running. Run `review app launch`, then retry `review map publish`.",
      );
    }
    report.stage("load", "running");
    const response = await fetch(`${discovery.url}/map-publish-ready`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-review-token": discovery.token,
      },
      body: JSON.stringify({
        reviewUuid: review.review.uuid,
        revision,
        agent,
      }),
    });
    const result = (await response.json().catch(() => null)) as {
      ok?: boolean;
      error?: string;
    } | null;
    if (!response.ok || !result?.ok) {
      throw new Error(
        result?.error ??
          `Review Desktop returned ${response.status} for map-publish-ready.`,
      );
    }
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

interface MapPublishReporter {
  stage(
    name: string,
    status: "running" | "complete",
    details?: Record<string, unknown>,
  ): void;
  error(stage: string, diagnostics: string[]): void;
  published(
    revision: string,
    documentRevision: string,
    unchanged: boolean,
  ): void;
}

function mapPublishReporter(input: {
  json?: boolean;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}): MapPublishReporter {
  if (input.json) {
    const emit = (event: Record<string, unknown>) =>
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
        typeof details.revision === "string"
          ? ` ${details.revision.slice(0, 12)}`
          : "";
      input.stdout.write(
        `${name === "load" ? "Load map" : name}: ok${suffix}\n`,
      );
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
