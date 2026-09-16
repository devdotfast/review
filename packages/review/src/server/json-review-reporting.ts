import { isJsonObject } from "@dev.fast/review-protocol";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { resourceReferences } from "../review-api/document";
import { readQuerySchemas } from "../review-api/read-schemas";
import { ReviewStore, type Snapshot } from "../review-api/store";
import { resolveReviewDiffFiles } from "../review-diff-files";
import { listReviews } from "../review-home";
import type { ReviewTelemetry } from "../telemetry";
import {
  type BugReportSource,
  BugReportUpstreamError,
  submitReviewBugReport,
} from "./bug-report";
import { readAuthoringTraceAttachment } from "./bug-report-trace";
import { readBoundedRequestJson } from "./hono-http";
import {
  captureSanitizedUiTelemetry,
  clientErrorsForSession,
  recordClientError,
} from "./review-api";
import {
  parseReviewBugReportInput,
  parseReviewTabTelemetryInput,
  requestJsonErrorStatus,
} from "./review-api-parsers";

export function jsonReviewBugReportSource(
  store: ReviewStore,
  snapshot: Snapshot,
): BugReportSource {
  return {
    async review() {
      return {
        files: { "review.json": JSON.stringify(snapshot, null, 2) },
        omitted: [],
      };
    },
    async map() {
      const ids = [
        ...new Set(
          resourceReferences(snapshot.document).flatMap((block) =>
            block.type === "software_map" ? [block.mapVersionId] : [],
          ),
        ),
      ];

      return ids.length
        ? JSON.stringify(
            ids.map((id) =>
              JSON.parse(Buffer.from(store.resource(id).data).toString()),
            ),
          )
        : null;
    },
    async diff() {
      return resolveReviewDiffFiles({
        rootPath: store.repositoryPath(snapshot.pins.repositoryId),
        baseRef: snapshot.pins.base,
        headRef: snapshot.pins.head,
        includePatch: true,
      });
    },
    async trace() {
      // Retained quote resources are excerpts, not the complete authoring session.
      const legacy = (await listReviews()).reviews.find(
        (entry) => entry.review.uuid === snapshot.reviewId,
      );

      return legacy
        ? readAuthoringTraceAttachment({ reviewRootPath: legacy.dir })
        : null;
    },
  };
}

/** API-review telemetry shares the legacy sanitization and report upload policy. */
export function createJsonReviewReporting(
  store: ReviewStore,
  telemetry: Pick<ReviewTelemetry, "captureUiEvent" | "captureTabViewed">,
  submit = submitReviewBugReport,
) {
  const app = new Hono();
  app.onError((error, context) =>
    context.json(
      { ok: false, error: error.message },
      // SAFETY: the report uploader returns HTTP error statuses; parser failures are 4xx.
      (error instanceof BugReportUpstreamError
        ? error.status
        : requestJsonErrorStatus(error)) as ContentfulStatusCode,
    ),
  );
  app.use("/:id/telemetry/*", async (context, next) => {
    store.assertExists(context.req.param("id")!);
    await next();
  });
  app.post("/:id/telemetry/event", async (context) => {
    const body = await readBoundedRequestJson(context.req.raw, undefined, {});
    const payload = isJsonObject(body) ? body : {};
    await captureSanitizedUiTelemetry(
      telemetry,
      context.req.raw,
      payload.name,
      payload.properties,
      recordClientError,
      payload.error,
    );

    return context.json({ ok: true });
  });
  app.post("/:id/telemetry/tab", async (context) => {
    const input = await readBoundedRequestJson(
      context.req.raw,
      undefined,
      {},
      { allowTextPlain: true },
    );

    await telemetry.captureTabViewed(parseReviewTabTelemetryInput(input));

    return context.json({ ok: true });
  });
  app.post("/:id/telemetry/bug-report", async (context) => {
    const query = readQuerySchemas.get.parse({
      version: context.req.query("version"),
    });

    const snapshot = store.read(context.req.param("id"), query.version);

    const report = parseReviewBugReportInput(
      await readBoundedRequestJson(context.req.raw, 6 * 1024 * 1024, {}),
    );

    return context.json(
      await submit({
        report,
        source: jsonReviewBugReportSource(store, snapshot),
        clientErrorNames: clientErrorsForSession(report.app_session_id),
      }),
    );
  });

  return app;
}
