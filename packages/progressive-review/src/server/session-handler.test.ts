import { writeFile } from "node:fs/promises";
import path from "node:path";

import {
  type JsonObject,
  REVIEW_SCHEMA_VERSION,
  type ReviewRecord,
} from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it } from "vitest";

import type { PostHogCaptureInput } from "../posthog-capture-client";
import {
  ProgressiveReviewTelemetry,
  type ProgressiveReviewTelemetryCaptureClient,
} from "../progressive-review-telemetry";
import { cleanupTempDirs, tempDir } from "../review-test-utils";
import {
  bundleReviewSoftwareMap,
  writeReviewSoftwareMapBundle,
} from "../software-map-bundle";
import { defineSoftwareMap } from "../software-map-model";
import type { ReviewSessionMode } from "./review-session-mode";
import { createReviewSessionHandler } from "./session-handler";
import { unusedAgentServices } from "./session-handler-test-utils";

const readOnlyRecord: ReviewRecord = {
  schemaVersion: REVIEW_SCHEMA_VERSION,
  uuid: "11111111-1111-4111-8111-111111111111",
  repoKey: "repo",
  worktreePath: "/repo",
  baseRef: "main",
  baseCommit: "b".repeat(40),
  sourceCommit: "a".repeat(40),
  sourceIdentity: null,
  title: "Review",
  sourceSession: "disabled:review",
  status: "awaiting-review",
  presentedDocumentRevision: "c".repeat(40),
  presentedSoftwareMapRevision: null,
  createdAt: "2024-01-01T00:00:00.000Z",
  lastPublishedAt: null,
};

afterEach(cleanupTempDirs);

describe("createReviewSessionHandler", () => {
  it("offers current repair metadata when a sealed artifact is missing", async () => {
    const rootPath = await tempDir("review-missing-repair-");
    const reviewPath = path.join(rootPath, "review.mdx");
    const reviewUuid = "11111111-1111-4111-8111-111111111111";
    const handler = await createReviewSessionHandler({
      ...unusedAgentServices,
      rootPath,
      toolingRoot: rootPath,
      reviewPath,
      routePath: "/",
      token: "secret",
      reviewUuid,
      artifacts: {
        document: "Document revision is missing.",
        map: "Map revision is missing.",
      },
      session: {
        rootPath,
        baseRef: "HEAD",
        appUrl: "http://127.0.0.1:5570",
        reviewPath,
        startedAt: Date.now(),
      },
    });
    try {
      for (const artifact of ["document", "software-map"]) {
        const response = await handler.handle(
          new Request(
            `http://127.0.0.1:5570/__progressive-review/${artifact}`,
            { headers: { "x-review-token": "secret" } },
          ),
        );
        expect(response.status).toBe(409);
        const payload = await response.json();
        expect(payload).toMatchObject({
          detail: { code: "needs_republish", reviewUuid },
        });
        expect(payload).not.toHaveProperty("recovery");
      }
    } finally {
      await handler.close();
    }
  });

  it("keeps repair validation and historical artifact states independent and read-only", async () => {
    const rootPath = await tempDir("review-recovery-handler-");
    const reviewPath = path.join(rootPath, "review.mdx");
    await writeFile(reviewPath, "# Review");
    await writeReviewSoftwareMapBundle(
      rootPath,
      bundleReviewSoftwareMap({
        head: defineSoftwareMap({ systems: {} }),
        base: defineSoftwareMap({ systems: {} }),
        headCommit: "a".repeat(40),
        baseCommit: "b".repeat(40),
      }),
    );
    for (const mode of [
      {
        kind: "repairValidation",
        record: readOnlyRecord,
        isPromoted: () => false,
      },
      { kind: "historical", revision: "c".repeat(40), record: readOnlyRecord },
    ] satisfies ReviewSessionMode[]) {
      const handler = await createReviewSessionHandler({
        ...unusedAgentServices,
        rootPath,
        toolingRoot: rootPath,
        reviewPath,
        softwareMapRootPath: rootPath,
        routePath: "/",
        token: "secret",
        mode,
        reviewUuid: "11111111-1111-4111-8111-111111111111",
        session: {
          rootPath,
          baseRef: "HEAD",
          appUrl: "http://127.0.0.1:5570",
          reviewPath,
          startedAt: Date.now(),
        },
      });
      const request = (route: string, method = "GET") =>
        handler.handle(
          new Request(`http://127.0.0.1:5570/__progressive-review/${route}`, {
            method,
            headers: { "x-review-token": "secret" },
          }),
        );
      try {
        const doc = await request("document");
        expect(doc.status).toBe(409);
        expect(await doc.json()).toMatchObject(
          mode.kind === "historical"
            ? {
                error:
                  "This older revision is unavailable in this version of Review",
                detail: {
                  code: "historical_revision_unavailable",
                  reviewUuid: "11111111-1111-4111-8111-111111111111",
                },
              }
            : { detail: { code: "needs_republish", mapStale: false } },
        );
        expect((await request("software-map")).status).toBe(200);
        const dismissed = await request("dismiss", "POST");
        expect(dismissed.status).toBe(409);
        expect(await dismissed.json()).toMatchObject({
          code:
            mode.kind === "historical"
              ? "historical_revision"
              : "review_read_only",
        });
      } finally {
        await handler.close();
      }
    }
  });
  it("scopes routed UI telemetry and presents a session only once", async () => {
    const rootPath = await tempDir("review-session-handler-");
    const reviewPath = path.join(rootPath, "review.mdx");
    const sessionId = "0f98956f-ec90-45b5-ae21-19acbcd8b6ef";
    const reviewUuid = "86df96ed-65ef-46de-9348-c94811e3bb46";
    const sessionUrl = `http://127.0.0.1:5570/sessions/${sessionId}`;
    const token = "session-secret";
    const events: PostHogCaptureInput[] = [];
    const captureClient: ProgressiveReviewTelemetryCaptureClient = {
      enabled: true,
      capture: async (event) => {
        events.push(event);
      },
    };
    const telemetry = new ProgressiveReviewTelemetry({
      captureClient,
      env: {},
      installConfigPath: path.join(rootPath, "telemetry.json"),
      idFactory: () => "install-123",
    });
    const handler = await createReviewSessionHandler({
      ...unusedAgentServices,
      rootPath,
      toolingRoot: rootPath,
      reviewPath,
      routePath: "/",
      token,
      sessionId,
      reviewUuid,
      telemetry,
      session: {
        rootPath,
        baseRef: "HEAD",
        appUrl: sessionUrl,
        reviewPath,
        startedAt: Date.now(),
      },
    });
    const capture = (name: string, properties?: JsonObject) =>
      handler.handle(
        new Request(
          new URL("/__progressive-review/telemetry/event", sessionUrl),
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-review-token": token,
              "x-review-app-session-id": "app-session-12345678",
            },
            body: JSON.stringify({ name, properties }),
          },
        ),
      );

    try {
      await expect(capture("review_presented")).resolves.toHaveProperty(
        "status",
        200,
      );
      await expect(capture("review_presented")).resolves.toHaveProperty(
        "status",
        200,
      );
      await expect(
        capture("client_error", {
          error_source: "render",
          error_process: "canvas",
          error_name: "TypeError",
        }),
      ).resolves.toHaveProperty("status", 200);

      expect(events.map((event) => event.event)).toEqual([
        "review_review_presented",
        "review_client_error",
      ]);
      expect(events[0].properties).toMatchObject({
        source: "review_app",
        app_session_id: "app-session-12345678",
        review_id: expect.stringMatching(/^rv_/),
        presentation_id: expect.stringMatching(/^pr_/),
      });
      expect(events[1].properties).toMatchObject({
        review_id: events[0].properties?.review_id,
        presentation_id: events[0].properties?.presentation_id,
      });
      expect(JSON.stringify(events)).not.toContain(reviewUuid);
      expect(JSON.stringify(events)).not.toContain(sessionId);
    } finally {
      await handler.close();
    }
  });

  it("rejects writes against a historical session with 409", async () => {
    const rootPath = await tempDir("review-session-handler-");
    const reviewPath = path.join(rootPath, "review.mdx");
    const sessionUrl = "http://127.0.0.1:5570/sessions/test-session";
    const token = "session-secret";
    const handler = await createReviewSessionHandler({
      ...unusedAgentServices,
      rootPath,
      toolingRoot: rootPath,
      reviewPath,
      routePath: "/",
      token,
      mode: {
        kind: "historical",
        revision: "a".repeat(40),
        record: readOnlyRecord,
      },
      session: {
        rootPath,
        baseRef: "HEAD",
        appUrl: sessionUrl,
        reviewPath,
        startedAt: Date.now(),
      },
    });
    try {
      const write = await handler.handle(
        new Request(
          new URL("/__progressive-review/comments/thread-1", sessionUrl),
          {
            method: "POST",
            headers: {
              "x-review-token": token,
              "content-type": "application/json",
            },
            body: JSON.stringify({}),
          },
        ),
      );
      expect(write.status).toBe(409);
      await expect(write.json()).resolves.toMatchObject({
        ok: false,
        code: "historical_revision",
      });
      const read = await handler.handle(
        new Request(new URL("/__progressive-review/comments", sessionUrl), {
          headers: { "x-review-token": token },
        }),
      );
      expect(read.status).toBe(400);
      expect(await read.json()).toMatchObject({
        error: "The review thread database is unavailable.",
      });
    } finally {
      await handler.close();
    }
  });

  it("returns the current review status", async () => {
    const rootPath = await tempDir("review-session-handler-");
    const reviewPath = path.join(rootPath, "review.mdx");
    const sessionUrl = "http://127.0.0.1:5570/sessions/test-session";
    const token = "session-secret";
    let reviewStatus: "awaiting-review" | "accepted" = "awaiting-review";
    const handler = await createReviewSessionHandler(
      {
        ...unusedAgentServices,
        rootPath,
        toolingRoot: rootPath,
        reviewPath,
        routePath: "/",
        token,
        getReviewStatus: () => reviewStatus,
        session: {
          rootPath,
          baseRef: "HEAD",
          appUrl: sessionUrl,
          reviewPath,
          startedAt: Date.now(),
        },
      },
      { resolveReviewSessionBaseCommit: async () => null },
    );

    const request = () =>
      handler.handle(
        new Request(new URL("/__progressive-review/session", sessionUrl), {
          headers: { "x-review-token": token },
        }),
      );

    try {
      await expect(request()).resolves.toHaveProperty("status", 200);
      await expect((await request()).json()).resolves.toMatchObject({
        session: { reviewStatus: "awaiting-review" },
      });
      reviewStatus = "accepted";
      await expect((await request()).json()).resolves.toMatchObject({
        session: { reviewStatus: "accepted" },
      });
    } finally {
      await handler.close();
    }
  });

  it("acknowledges a submission before the submit hook exits", async () => {
    const rootPath = await tempDir("review-session-handler-");
    const reviewPath = path.join(rootPath, "review.mdx");
    const sessionUrl = "http://127.0.0.1:5570/sessions/test-session";
    const token = "session-secret";
    await writeFile(reviewPath, "# Test review\n");
    const handler = await createReviewSessionHandler({
      ...unusedAgentServices,
      rootPath,
      toolingRoot: rootPath,
      reviewPath,
      routePath: "/",
      token,
      submitHook: "sleep 1",
      session: {
        rootPath,
        baseRef: "HEAD",
        appUrl: sessionUrl,
        reviewPath,
        startedAt: Date.now(),
      },
    });

    try {
      const response = await Promise.race([
        handler.handle(
          new Request(
            new URL("/__progressive-review/submissions", sessionUrl),
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-review-token": token,
              },
              body: JSON.stringify({
                submissionId: "submission-1",
                decision: "approve",
                comments: [],
              }),
            },
          ),
        ),
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error("Submission response waited for its hook.")),
            250,
          );
        }),
      ]);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        hook: { configured: true },
      });
    } finally {
      await handler.close();
    }
  });
});
