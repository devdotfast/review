import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, it, vi } from "vitest";

import { openLocalReviewStore } from "../review-api/local-data";
import { SCRATCHPAD_ID, ReviewStore } from "../review-api/store";
import { ReviewTelemetry } from "../review-telemetry";
import { createGlobalReviewServer, sessionStartedSourceKind } from "./desktop-server";

it("derives source_kind from the review's stored target, or the scratchpad kind", async () => {
  const store = new ReviewStore(":memory:", {
    validatePins: async () => {},
    validateSource: async () => {},
    validateResource: async () => {},
  });

  try {
    const repository = store.registerRepository(process.cwd());
    const reviewId = randomUUID();

    await store.importVersion({
      reviewId,
      pins: { repositoryId: repository.id, base: "base", head: "head" },
      title: "Pinned",
      document: [{ type: "markdown", markdown: "Prose" }],
      createdAt: "2026-01-01T00:00:00Z",
    });

    expect(sessionStartedSourceKind(store, reviewId)).toBe("commits");
    await store.ensureScratchpad();
    expect(sessionStartedSourceKind(store, SCRATCHPAD_ID)).toBe("scratchpad");
    expect(sessionStartedSourceKind(store, randomUUID())).toBeUndefined();
    expect(sessionStartedSourceKind(store, undefined)).toBeUndefined();
  } finally {
    await store.close();
  }
});

it("enriches session_started with source_kind on the global /telemetry/event route", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "review-session-telemetry-"));
  const local = openLocalReviewStore(path.join(home, "review-api.db"));
  const token = "session-telemetry-test-token";

  await local.store.ensureScratchpad();
  const telemetry = ReviewTelemetry.fromEnv({
    ...process.env,
    DEV_REVIEW_HOME: home,
  });
  const captureUiEvent = vi.spyOn(telemetry, "captureUiEvent");

  const server = createGlobalReviewServer({
    reviewStore: local.store,
    reviewData: local.data,
    appPid: process.pid,
    packageRoot: home,
    toolingRoot: home,
    port: 0,
    token,
    discoveryPath: path.join(home, "review-desktop", "server.json"),
    telemetry,
  });

  try {
    await server.listen();

    const context = {
      reviewUuid: SCRATCHPAD_ID,
      presentationSessionId: randomUUID(),
    };

    const response = await fetch(`${server.url}/telemetry/event`, {
      method: "POST",
      headers: { "x-review-token": token, "content-type": "application/json" },
      body: JSON.stringify({
        name: "session_started",
        properties: {},
        context,
      }),
    });

    expect(response.status).toBe(200);
    expect(captureUiEvent).toHaveBeenCalledWith(
      "review_session_started",
      { source_kind: "scratchpad" },
      context,
    );
  } finally {
    await server.close();
    await local.data.close();
    await local.store.close();
    await rm(home, { recursive: true, force: true });
  }
});
