import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";

import type { JsonValue } from "@dev.fast/review-protocol";
import { afterEach, expect, it, vi } from "vitest";

import { ReviewStore } from "../review-api/store";
import type { ReviewTelemetry } from "../telemetry";
import { type BugReportPayload, submitReviewBugReport } from "./bug-report";
import { createJsonReviewReporting } from "./json-review-reporting";

let store: ReviewStore;

afterEach(async () => store?.close());

it("routes sanitized telemetry and uploads only opted-in JSON context from the displayed version", async () => {
  store = new ReviewStore(":memory:", {
    validatePins: async () => {},
    validateSource: async () => {},
    validateResource: async () => {},
  });
  const repository = store.registerRepository(process.cwd());
  const reviewId = randomUUID();
  const pins = { repositoryId: repository.id, base: "base", head: "head" };
  const mapId = randomUUID();
  store.putResource(
    mapId,
    repository.id,
    "map",
    "application/json",
    Buffer.from(JSON.stringify({ model: { title: "Original map" } })),
  );
  await store.importVersion({
    reviewId,
    pins,
    title: "Original",
    document: [
      { type: "markdown", markdown: "Original prose" },
      { type: "software_map", mapVersionId: mapId },
    ],
    createdAt: "2026-01-01T00:00:00Z",
  });
  await store.importVersion({
    reviewId,
    pins: { ...pins, head: "new-head" },
    title: "Newer",
    document: [{ type: "markdown", markdown: "Newer prose" }],
    createdAt: "2026-01-02T00:00:00Z",
  });

  const telemetry = {
    captureUiEvent: vi.fn<ReviewTelemetry["captureUiEvent"]>(),
    captureTabViewed: vi.fn<ReviewTelemetry["captureTabViewed"]>(),
    envelope: vi.fn<ReviewTelemetry["envelope"]>(async () => ({
      channel: "stable",
      environment: "e2e",
      surface: "desktop",
      ci: false,
      internal: false,
    })),
  };

  const payloads: BugReportPayload[] = [];

  const fetchImpl: typeof fetch = async (_url, init) => {
    if (!(init?.body instanceof FormData))
      throw new Error("Expected multipart report");
    const part = init.body.get("payload");

    if (!(part instanceof Blob)) throw new Error("Expected payload attachment");
    payloads.push(
      JSON.parse(gunzipSync(Buffer.from(await part.arrayBuffer())).toString()),
    );

    return Response.json({
      ok: true,
      report_id: randomUUID(),
      short_id: "123456789012",
    });
  };

  const app = createJsonReviewReporting(store, telemetry, {
    submit: (input) => submitReviewBugReport({ ...input, fetchImpl }),
  });

  const post = (
    route: string,
    body: JsonValue,
    contentType = "application/json",
  ) =>
    app.request(`/${reviewId}/telemetry/${route}`, {
      method: "POST",
      headers: { "content-type": contentType },
      body: JSON.stringify(body),
    });

  const sessionId = randomUUID();
  expect(
    (
      await post("event", {
        name: "app_opened",
        properties: { app_session_id: sessionId, secret: "drop-me" },
      })
    ).status,
  ).toBe(200);
  expect(telemetry.captureUiEvent).toHaveBeenCalledWith(
    "review_app_opened",
    { app_session_id: sessionId },
    { reviewUuid: reviewId },
  );
  expect(
    (
      await post("event", {
        name: "review_presented",
        properties: { load_ms: 240 },
        context: {
          presentationSessionId: "0f98956f-ec90-45b5-ae21-19acbcd8b6ef",
        },
      })
    ).status,
  ).toBe(200);
  expect(telemetry.captureUiEvent).toHaveBeenLastCalledWith(
    "review_review_presented",
    { load_ms: 240 },
    {
      reviewUuid: reviewId,
      presentationSessionId: "0f98956f-ec90-45b5-ae21-19acbcd8b6ef",
    },
  );
  expect(
    (
      await post(
        "tab",
        {
          tab: "review",
          reason: "pagehide",
          duration_ms: 500,
          app_session_id: sessionId,
        },
        "text/plain",
      )
    ).status,
  ).toBe(200);
  expect(telemetry.captureTabViewed).toHaveBeenCalledWith({
    tab: "review",
    reason: "pagehide",
    durationMs: 500,
    appSessionId: sessionId,
  });

  const report = {
    description: "Broken alignment",
    include_review: true,
    include_map: true,
    include_diff: false,
    include_trace: false,
    app_session_id: sessionId,
    app_version: "1.0.0",
  };

  expect((await post("bug-report?version=0", report)).status).toBe(200);
  expect(payloads[0].review?.["review.json"]).toContain("Original prose");
  expect(payloads[0].review?.["review.json"]).not.toContain("Newer prose");
  expect(payloads[0].map).toContain("Original map");
  expect(payloads[0].diagnostics.telemetry).toEqual({
    channel: "stable",
    environment: "e2e",
    surface: "desktop",
    ci: false,
    internal: false,
  });
  expect(
    (
      await post("bug-report?version=0", {
        ...report,
        include_review: false,
        include_map: false,
      })
    ).status,
  ).toBe(200);
  expect(payloads[1].review).toBeUndefined();
  expect(payloads[1].map).toBeUndefined();
  expect(payloads[1].diff).toBeUndefined();
  expect(payloads[1].trace).toBeUndefined();
  expect((await post("bug-report?version=999", report)).status).not.toBe(200);
  expect(payloads).toHaveLength(2);
});

it("rejects shared telemetry when the shared store is unavailable", async () => {
  store = new ReviewStore(":memory:", {
    validatePins: async () => {},
    validateSource: async () => {},
    validateResource: async () => {},
  });
  const captureUiEvent = vi.fn<ReviewTelemetry["captureUiEvent"]>();

  const app = createJsonReviewReporting(store, {
    captureUiEvent,
    captureTabViewed: vi.fn<ReviewTelemetry["captureTabViewed"]>(),
    envelope: vi.fn<ReviewTelemetry["envelope"]>(async () => ({})),
  });

  const response = await app.request(
    `/shared-${"a".repeat(64)}/telemetry/event`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "canvas_opened" }),
    },
  );

  expect(response.status).toBe(404);
  expect(captureUiEvent).not.toHaveBeenCalled();
});
