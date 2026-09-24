import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { expect, it, vi } from "vitest";

import { openLocalReviewStore } from "../review-api/local-data";
import { ReviewStore, SCRATCHPAD_ID } from "../review-api/store";
import { ReviewTelemetry } from "../review-telemetry";
import {
  createGlobalReviewServer,
  sessionStartedSourceKind,
} from "./desktop-server";
import type { ReviewOpenContext } from "./review-open-watchdog";
import { clientOccurredAt } from "./ui-telemetry";

it("keeps a client's occurrence time only within the recent past", () => {
  const now = Date.parse("2026-09-23T12:00:00.000Z");

  expect(clientOccurredAt(now - 11, now)).toBe(now - 11);
  expect(clientOccurredAt(now + 60_000, now)).toBe(now);
  expect(clientOccurredAt(now - 24 * 60 * 60 * 1_000, now)).toBe(
    now - 5 * 60 * 1_000,
  );
  expect(clientOccurredAt("yesterday", now)).toBe(now);
  expect(clientOccurredAt(undefined, now)).toBe(now);
});

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
  const home = await mkdtemp(
    path.join(os.tmpdir(), "review-session-telemetry-"),
  );

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
      expect.any(Number),
    );
  } finally {
    await server.close();
    await local.data.close();
    await local.store.close();
    await rm(home, { recursive: true, force: true });
  }
});

it("never trusts a client-supplied source_kind or agent_kind on session_started", async () => {
  const home = await mkdtemp(
    path.join(os.tmpdir(), "review-session-telemetry-"),
  );

  const local = openLocalReviewStore(path.join(home, "review-api.db"));
  const token = "session-telemetry-test-token";

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

    // A review this store never had (a shared review, or one deleted between
    // open and the event arriving): sessionStartedSourceKind cannot resolve it.
    const context = {
      reviewUuid: randomUUID(),
      presentationSessionId: randomUUID(),
    };

    const response = await fetch(`${server.url}/telemetry/event`, {
      method: "POST",
      headers: { "x-review-token": token, "content-type": "application/json" },
      body: JSON.stringify({
        name: "session_started",
        properties: { source_kind: "commits", agent_kind: "claude" },
        context,
      }),
    });

    expect(response.status).toBe(200);
    expect(captureUiEvent).toHaveBeenCalledWith(
      "review_session_started",
      {},
      context,
      expect.any(Number),
    );
  } finally {
    await server.close();
    await local.data.close();
    await local.store.close();
    await rm(home, { recursive: true, force: true });
  }
});

it("reports a session that starts and never presents, and not one that does", async () => {
  const home = await mkdtemp(
    path.join(os.tmpdir(), "review-session-telemetry-"),
  );

  const local = openLocalReviewStore(path.join(home, "review-api.db"));
  const token = "session-telemetry-test-token";

  const telemetry = ReviewTelemetry.fromEnv({
    ...process.env,
    DEV_REVIEW_HOME: home,
  });

  const captureEvent = vi.spyOn(telemetry, "captureEvent");

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

  const send = (name: string, context: ReviewOpenContext) =>
    fetch(`${server.url}/telemetry/event`, {
      method: "POST",
      headers: { "x-review-token": token, "content-type": "application/json" },
      body: JSON.stringify({ name, properties: {}, context }),
    });

  try {
    await server.listen();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    const stuck = {
      reviewUuid: randomUUID(),
      presentationSessionId: randomUUID(),
    };

    const shown = {
      reviewUuid: randomUUID(),
      presentationSessionId: randomUUID(),
    };

    await send("session_started", stuck);
    await send("session_started", shown);
    await send("review_presented", shown);
    vi.advanceTimersByTime(30_000);

    const timeouts = captureEvent.mock.calls.filter(
      ([event]) => event === "review_open_timeout",
    );

    expect(timeouts).toEqual([
      ["review_open_timeout", { elapsed_ms: 30_000 }, stuck],
    ]);
  } finally {
    vi.useRealTimers();
    await server.close();
    await local.data.close();
    await local.store.close();
    await rm(home, { recursive: true, force: true });
  }
});
