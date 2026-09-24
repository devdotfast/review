import { isJsonObject } from "@dev.fast/review-protocol";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { ReviewInputError, resourceReferences } from "../review-api/document";
import { readQuerySchemas } from "../review-api/read-schemas";
import { ReviewStore, type Snapshot } from "../review-api/store";
import { resolveReviewDiffFiles } from "../review-diff-files";
import type { SharedReviewStore } from "../sharing/import.js";
import type { ReviewTelemetry } from "../telemetry";
import {
  type BugReportSource,
  BugReportUpstreamError,
  submitReviewBugReport,
} from "./bug-report";
import { readBoundedRequestJson } from "./hono-http";
import {
  parseReviewBugReportInput,
  parseReviewTabTelemetryInput,
  requestJsonErrorStatus,
} from "./review-api-parsers";
import {
  captureSanitizedUiTelemetry,
  clientErrorsForSession,
  recordClientError,
} from "./ui-telemetry";

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
      if (!snapshot.pins) return { files: [] };

      return resolveReviewDiffFiles({
        rootPath: store.repositoryPath(snapshot.pins.repositoryId),
        baseRef: snapshot.pins.base,
        headRef: snapshot.pins.head,
        includePatch: true,
      });
    },
    async trace() {
      return null;
    },
  };
}

/** Telemetry and report uploads for a pinned native review. */
export function createJsonReviewReporting(
  store: ReviewStore,
  telemetry: Pick<
    ReviewTelemetry,
    "captureUiEvent" | "captureTabViewed" | "envelope"
  >,
  options: {
    submit?: typeof submitReviewBugReport;
    shared?: SharedReviewStore;
  } = {},
) {
  const { submit = submitReviewBugReport, shared } = options;
  const app = new Hono();
  app.onError((error, context) =>
    context.json(
      { ok: false, error: error.message },
      // SAFETY: the report uploader returns HTTP error statuses; parser failures are 4xx.
      (error instanceof BugReportUpstreamError
        ? error.status
        : error instanceof ReviewInputError
          ? error.status
          : requestJsonErrorStatus(error)) as ContentfulStatusCode,
    ),
  );
  app.use("/:id/telemetry/*", async (context, next) => {
    const id = context.req.param("id")!;

    if (id.startsWith("shared-")) {
      if (!shared)
        throw new ReviewInputError("Shared review is not available.", 404);
      shared.get(id);
    } else store.assertExists(id);
    await next();
  });
  app.post("/:id/telemetry/event", async (c) => {
    const body = await readBoundedRequestJson(c.req.raw, undefined, {});
    const payload = isJsonObject(body) ? body : {};
    const rawContext = isJsonObject(payload.context) ? payload.context : {};
    await captureSanitizedUiTelemetry(
      telemetry,
      c.req.raw,
      payload.name,
      payload.properties,
      recordClientError,
      payload.error,
      // The path id wins: the middleware above already asserted it exists,
      // so a payload trying to assert a different review id is overridden.
      { ...rawContext, reviewUuid: c.req.param("id") },
      payload.occurredAt,
    );

    return c.json({ ok: true });
  });
  app.post("/:id/telemetry/tab", async (context) => {
    const input = await readBoundedRequestJson(
      context.req.raw,
      undefined,
      {},
      { allowTextPlain: true },
    );

    await telemetry.captureTabViewed(parseReviewTabTelemetryInput(input), {
      reviewUuid: context.req.param("id"),
    });

    return context.json({ ok: true });
  });
  app.post("/:id/telemetry/bug-report", async (context) => {
    const query = readQuerySchemas.get.parse({
      version: context.req.query("version"),
    });

    const id = context.req.param("id");
    const imported = id.startsWith("shared-") ? shared?.get(id) : undefined;
    const snapshot = imported?.snapshot ?? store.read(id, query.version);

    const report = parseReviewBugReportInput(
      await readBoundedRequestJson(context.req.raw, 6 * 1024 * 1024, {}),
    );

    return context.json(
      await submit({
        report,
        source: imported
          ? {
              review: async () => ({
                files: { "review.json": JSON.stringify(snapshot) },
                omitted: [],
              }),
              map: async () => JSON.stringify(imported.presentation.maps),
              diff: () => jsonReviewBugReportSource(store, snapshot).diff(),
              trace: async () => null,
            }
          : jsonReviewBugReportSource(store, snapshot),
        clientErrorNames: clientErrorsForSession(report.app_session_id),
        // A locked telemetry config must not cost the user their report.
        telemetryEnvelope: await telemetry.envelope().catch(() => undefined),
      }),
    );
  });

  return app;
}
