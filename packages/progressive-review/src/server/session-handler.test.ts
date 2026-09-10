import { writeFile } from "node:fs/promises";
import path from "node:path";

import {
  type JsonObject,
  REVIEW_SCHEMA_VERSION,
  ReviewDocumentResponseSchema,
  type ReviewRecord,
} from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it } from "vitest";

import type { PostHogCaptureInput } from "../posthog-capture-client";
import {
  ProgressiveReviewTelemetry,
  type ProgressiveReviewTelemetryCaptureClient,
} from "../progressive-review-telemetry";
import {
  bundleReviewDocument,
  writeReviewDocumentBundle,
} from "../review-bundle";
import { cleanupTempDirs, tempDir } from "../review-test-utils";
import {
  bundleReviewSoftwareMap,
  writeReviewSoftwareMapBundle,
} from "../software-map-bundle";
import { defineSoftwareMap } from "../software-map-model";
import { legacySessionArtifactFromBuildDir } from "./review-session-artifact";
import type { ReviewSessionMode } from "./review-session-mode";
import { createReviewSessionHandler } from "./session-handler";
import {
  reviewDocument,
  sessionArtifactFixture,
  unusedAgentServices,
} from "./session-handler-test-utils";

it("serves live previews without changing sealed bundles and keeps in-flight hash URLs valid", async () => {
  const rootPath = await tempDir("review-live-session-");
  const reviewPath = path.join(rootPath, "review.mdx");
  const bundle = (title: string) =>
    bundleReviewDocument({
      format: "review-document/1",
      title,
      routePath: "/",
      sourcePath: "review.mdx",
      body: [{ type: "text", value: title }],
      anchors: {},
      anchorContents: {},
      softwareModels: [],
    });
  const sealed = bundle("Sealed");
  await writeReviewDocumentBundle(rootPath, sealed);
  let live = bundle("First preview");
  const input = {
    ...unusedAgentServices,
    rootPath,
    toolingRoot: rootPath,
    artifact: await legacySessionArtifactFromBuildDir({
      reviewUuid: "11111111-1111-4111-8111-111111111111",
      revision: "c".repeat(40),
      buildDir: rootPath,
      routePath: "/",
      sourcePath: reviewPath,
    }),
    routePath: "/",
    token: "secret",
    session: {
      rootPath,
      baseRef: "HEAD",
      reviewPath,
      appUrl: "http://localhost",
      startedAt: Date.now(),
    },
  };
  const handler = await createReviewSessionHandler({
    ...input,
    getLiveBundle: async () => live,
  });
  const historical = await createReviewSessionHandler(input);
  const get = (target: typeof handler, pathname: string) =>
    target.handle(
      new Request(`http://localhost${pathname}`, {
        headers: { "x-review-token": "secret" },
      }),
    );
  try {
    const first = ReviewDocumentResponseSchema.parse(
      await (await get(handler, "/__progressive-review/document")).json(),
    );
    expect(first).toMatchObject({ ok: true, contentHash: live.contentHash });
    const firstHash = live.contentHash;
    live = bundle("Second preview");
    expect(
      await (await get(handler, "/__progressive-review/document")).json(),
    ).toMatchObject({ contentHash: live.contentHash });
    expect(
      await (
        await get(handler, `/__progressive-review/documents/${firstHash}.json`)
      ).text(),
    ).toBe(bundle("First preview").json);
    expect(
      await (await get(historical, "/__progressive-review/document")).json(),
    ).toMatchObject({ contentHash: sealed.contentHash });
  } finally {
    await handler.close();
    await historical.close();
  }
});

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
  it.each([
    { presentation: "candidate", origin: { kind: "candidate" } as const },
    {
      presentation: "historical",
      origin: {
        kind: "legacy" as const,
        revision: "c".repeat(40),
        buildDir: "/build",
      },
      mode: {
        kind: "historical" as const,
        revision: "c".repeat(40),
        record: readOnlyRecord,
      },
    },
  ])(
    "serves a $presentation session's own bytes and never a live preview",
    async ({ origin, mode }) => {
      const rootPath = await tempDir("review-sealed-session-");
      const reviewPath = path.join(rootPath, "review.mdx");
      const sealed = bundleReviewDocument({
        ...reviewDocument,
        title: "Sealed",
      });
      const live = bundleReviewDocument({
        ...reviewDocument,
        title: "Live preview",
      });
      let livePreviews = 0;
      const handler = await createReviewSessionHandler({
        ...unusedAgentServices,
        rootPath,
        toolingRoot: rootPath,
        artifact: sessionArtifactFixture({
          sourcePath: reviewPath,
          origin,
          document: { bundle: sealed },
        }),
        routePath: "/",
        token: "secret",
        mode,
        getLiveBundle: async () => {
          livePreviews += 1;
          return live;
        },
        session: {
          rootPath,
          baseRef: "HEAD",
          appUrl: "http://127.0.0.1:5570",
          reviewPath,
          startedAt: Date.now(),
        },
      });
      const get = (pathname: string) =>
        handler.handle(
          new Request(`http://127.0.0.1:5570${pathname}`, {
            headers: { "x-review-token": "secret" },
          }),
        );
      try {
        expect(
          await (await get("/__progressive-review/document")).json(),
        ).toMatchObject({ ok: true, contentHash: sealed.contentHash });
        expect(
          await (
            await get(
              `/__progressive-review/documents/${sealed.contentHash}.json`,
            )
          ).text(),
        ).toBe(sealed.json);
        expect(
          (
            await get(
              `/__progressive-review/documents/${live.contentHash}.json`,
            )
          ).status,
        ).toBe(404);
        expect(livePreviews).toBe(0);
      } finally {
        await handler.close();
      }
    },
  );

  it("offers current repair metadata when a sealed artifact is missing", async () => {
    const rootPath = await tempDir("review-missing-repair-");
    const reviewPath = path.join(rootPath, "review.mdx");
    const reviewUuid = "11111111-1111-4111-8111-111111111111";
    const handler = await createReviewSessionHandler({
      ...unusedAgentServices,
      rootPath,
      toolingRoot: rootPath,
      routePath: "/",
      token: "secret",
      reviewUuid,
      artifact: sessionArtifactFixture({
        sourcePath: reviewPath,
        reviewUuid,
        document: { unavailable: "Document revision is missing." },
        map: { unavailable: "Map revision is missing." },
      }),
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
        artifact: await legacySessionArtifactFromBuildDir({
          reviewUuid: readOnlyRecord.uuid,
          revision: "c".repeat(40),
          buildDir: rootPath,
          routePath: "/",
          softwareMapRootPath: rootPath,
          sourcePath: reviewPath,
          historical: mode.kind === "historical",
        }),
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
        const docPayload = await doc.json();
        expect(docPayload).toMatchObject(
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
        expect(
          mode.kind !== "historical" ||
            ReviewDocumentResponseSchema.safeParse(docPayload).success,
        ).toBe(true);
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

  it("emits a protocol-valid historical document error for a recorded missing artifact", async () => {
    const rootPath = await tempDir("review-historical-artifact-");
    const reviewPath = path.join(rootPath, "review.mdx");
    const reviewUuid = readOnlyRecord.uuid;
    const handler = await createReviewSessionHandler({
      ...unusedAgentServices,
      rootPath,
      toolingRoot: rootPath,
      artifact: sessionArtifactFixture({
        sourcePath: reviewPath,
        reviewUuid,
        document: { unavailable: "Document revision is missing." },
      }),
      routePath: "/",
      token: "secret",
      reviewUuid,
      mode: {
        kind: "historical",
        revision: "c".repeat(40),
        record: readOnlyRecord,
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
      const response = await handler.handle(
        new Request("http://127.0.0.1:5570/__progressive-review/document", {
          headers: { "x-review-token": "secret" },
        }),
      );
      const payload = await response.json();
      expect(response.status).toBe(409);
      expect(ReviewDocumentResponseSchema.parse(payload)).toEqual({
        ok: false,
        error: "Document revision is missing.",
        detail: { code: "historical_revision_unavailable", reviewUuid },
      });
    } finally {
      await handler.close();
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
      artifact: sessionArtifactFixture({ sourcePath: reviewPath }),
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
      artifact: sessionArtifactFixture({ sourcePath: reviewPath }),
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
        artifact: sessionArtifactFixture({ sourcePath: reviewPath }),
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
      artifact: sessionArtifactFixture({ sourcePath: reviewPath }),
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
