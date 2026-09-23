import { isJsonObject } from "@dev.fast/whiteboard-protocol";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { SessionInputError, resourceReferences } from "../session-api/document";
import { readQuerySchemas } from "../session-api/read-schemas";
import { SessionStore, type Snapshot } from "../session-api/store";
import type { SharedSessionStore } from "../sharing/import.js";
import type { WhiteboardTelemetry } from "../telemetry";
import { resolveWhiteboardDiffFiles } from "../whiteboard-diff-files";
import {
  type BugReportSource,
  BugReportUpstreamError,
  submitWhiteboardBugReport,
} from "./bug-report";
import { readBoundedRequestJson } from "./hono-http";
import {
  captureSanitizedUiTelemetry,
  clientErrorsForSession,
  recordClientError,
} from "./ui-telemetry";
import {
  parseWhiteboardBugReportInput,
  parseWhiteboardTabTelemetryInput,
  requestJsonErrorStatus,
} from "./whiteboard-api-parsers";

export function jsonWhiteboardBugReportSource(
  store: SessionStore,
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

      return resolveWhiteboardDiffFiles({
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
export function createJsonWhiteboardReporting(
  store: SessionStore,
  telemetry: Pick<WhiteboardTelemetry, "captureUiEvent" | "captureTabViewed">,
  options: {
    submit?: typeof submitWhiteboardBugReport;
    shared?: SharedSessionStore;
  } = {},
) {
  const { submit = submitWhiteboardBugReport, shared } = options;
  const app = new Hono();
  app.onError((error, context) =>
    context.json(
      { ok: false, error: error.message },
      // SAFETY: the report uploader returns HTTP error statuses; parser failures are 4xx.
      (error instanceof BugReportUpstreamError
        ? error.status
        : error instanceof SessionInputError
          ? error.status
          : requestJsonErrorStatus(error)) as ContentfulStatusCode,
    ),
  );
  app.use("/:id/telemetry/*", async (context, next) => {
    const id = context.req.param("id")!;

    if (id.startsWith("shared-")) {
      if (!shared)
        throw new SessionInputError("Shared review is not available.", 404);
      shared.get(id);
    } else store.assertExists(id);
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

    await telemetry.captureTabViewed(parseWhiteboardTabTelemetryInput(input));

    return context.json({ ok: true });
  });
  app.post("/:id/telemetry/bug-report", async (context) => {
    const query = readQuerySchemas.get.parse({
      version: context.req.query("version"),
    });

    const id = context.req.param("id");
    const imported = id.startsWith("shared-") ? shared?.get(id) : undefined;
    const snapshot = imported?.snapshot ?? store.read(id, query.version);

    const report = parseWhiteboardBugReportInput(
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
              diff: () => jsonWhiteboardBugReportSource(store, snapshot).diff(),
              trace: async () => null,
            }
          : jsonWhiteboardBugReportSource(store, snapshot),
        clientErrorNames: clientErrorsForSession(report.app_session_id),
      }),
    );
  });

  return app;
}
