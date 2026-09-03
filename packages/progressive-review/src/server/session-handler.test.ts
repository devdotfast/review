import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  CreateReviewCommentInput,
  JsonObject,
  ReviewThreadsCommit,
} from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PostHogCaptureInput } from "../posthog-capture-client";
import {
  ProgressiveReviewTelemetry,
  type ProgressiveReviewTelemetryCaptureClient,
} from "../progressive-review-telemetry";
import { writeReviewDocumentBundle } from "../review-bundle";
import { readReviewComments } from "../review-state-store";
import {
  type ReviewSessionHandlerInput,
  createReviewSessionHandler,
} from "./session-handler";

const unusedAgentServices = {
  openNativeAgentTerminal: async () => {
    throw new Error("This test does not open a native agent terminal.");
  },
} satisfies Pick<ReviewSessionHandlerInput, "openNativeAgentTerminal">;

let rootPath: string | undefined;

afterEach(async () => {
  if (rootPath) {
    await rm(rootPath, { recursive: true, force: true });
  }
  rootPath = undefined;
});

describe("createReviewSessionHandler", () => {
  it("scopes routed UI telemetry and presents a session only once", async () => {
    rootPath = await mkdtemp(path.join(tmpdir(), "review-session-handler-"));
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
    rootPath = await mkdtemp(path.join(tmpdir(), "review-session-handler-"));
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
      historicalRevision: "a".repeat(40),
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
      expect(read.status).toBe(200);
    } finally {
      await handler.close();
    }
  });

  it("serves the version list from the host callback", async () => {
    rootPath = await mkdtemp(path.join(tmpdir(), "review-session-handler-"));
    const reviewPath = path.join(rootPath, "review.mdx");
    const sessionUrl = "http://127.0.0.1:5570/sessions/test-session";
    const token = "session-secret";
    const versions = [
      {
        revision: "b".repeat(40),
        sealedAt: 1_755_000_000_000,
        isCurrent: true,
      },
    ];
    const handler = await createReviewSessionHandler({
      ...unusedAgentServices,
      rootPath,
      toolingRoot: rootPath,
      reviewPath,
      routePath: "/",
      token,
      listDocumentVersions: async () => versions,
      session: {
        rootPath,
        baseRef: "HEAD",
        appUrl: sessionUrl,
        reviewPath,
        startedAt: Date.now(),
      },
    });
    try {
      const response = await handler.handle(
        new Request(new URL("/__progressive-review/revisions", sessionUrl), {
          headers: { "x-review-token": token },
        }),
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true, versions });
    } finally {
      await handler.close();
    }
  });

  it("serves the stored document bundle", async () => {
    rootPath = await mkdtemp(path.join(tmpdir(), "review-session-handler-"));
    const reviewPath = path.join(rootPath, "review.mdx");
    const sessionUrl = "http://127.0.0.1:5570/sessions/test-session";
    const token = "session-secret";
    await writeFile(reviewPath, "# Review\n", "utf8");
    await writeReviewDocumentBundle(rootPath, {
      code: "export const activeReviewDocument = {};",
      contentHash: "0123456789abcdef0123",
      routePath: "/",
      sourcePath: reviewPath,
    });
    const handler = await createReviewSessionHandler({
      ...unusedAgentServices,
      rootPath,
      toolingRoot: rootPath,
      reviewPath,
      routePath: "/",
      token,
      session: {
        rootPath,
        baseRef: "HEAD",
        appUrl: sessionUrl,
        reviewPath,
        startedAt: Date.now(),
      },
    });

    try {
      const response = await handler.handle(
        new Request(new URL("/__progressive-review/doc-module", sessionUrl), {
          headers: { "x-review-token": token },
        }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true });
    } finally {
      await handler.close();
    }
  });

  it("returns committed state and announces only applied changes", async () => {
    rootPath = await mkdtemp(path.join(tmpdir(), "review-session-handler-"));
    const reviewPath = path.join(rootPath, "review.mdx");
    const sessionUrl = "http://127.0.0.1:5570/sessions/test-session";
    const token = "session-secret";
    const onReviewThreadsCommit =
      vi.fn<(commit: ReviewThreadsCommit) => void>();
    const handler = await createReviewSessionHandler({
      ...unusedAgentServices,
      rootPath,
      toolingRoot: rootPath,
      reviewPath,
      routePath: "/",
      token,
      onReviewThreadsCommit,
      session: {
        rootPath,
        baseRef: "HEAD",
        appUrl: sessionUrl,
        reviewPath,
        startedAt: Date.now(),
      },
    });

    const request = (
      path: string,
      method: "POST" | "DELETE",
      body?: CreateReviewCommentInput,
    ) =>
      handler.handle(
        new Request(new URL(`/__progressive-review${path}`, sessionUrl), {
          method,
          headers: {
            "x-review-token": token,
            ...(body ? { "content-type": "application/json" } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );

    try {
      const comment = await request("/comments/thread-1", "POST", {
        threadId: "thread-1",
        messageId: "message-1",
        target: {
          kind: "text",
          surface: {
            type: "block",
            tag: "p",
            index: 0,
            blockHash: "12345678",
          },
          selection: {
            start: 2,
            length: 5,
            hash: "f55c314b",
            quote: "Hello",
          },
        },
        body: "A fresh external comment",
      });
      expect(comment.status).toBe(200);
      await expect(comment.json()).resolves.toMatchObject({
        ok: true,
        commit: {
          mutationId: "message-1",
          upsertedThreads: [{ threadId: "thread-1" }],
        },
      });
      expect(onReviewThreadsCommit).toHaveBeenCalledTimes(1);
    } finally {
      await handler.close();
    }
  });

  it("runs comment mutations through the publication lock seam", async () => {
    rootPath = await mkdtemp(path.join(tmpdir(), "review-session-handler-"));
    const reviewPath = path.join(rootPath, "review.mdx");
    const sessionUrl = "http://127.0.0.1:5570/sessions/test-session";
    const token = "session-secret";
    let enterMutation!: () => void;
    let releaseMutation!: () => void;
    const mutationEntered = new Promise<void>((resolve) => {
      enterMutation = resolve;
    });
    const mutationReleased = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const handler = await createReviewSessionHandler({
      ...unusedAgentServices,
      rootPath,
      toolingRoot: rootPath,
      reviewPath,
      routePath: "/",
      token,
      runReviewThreadMutation: async (operation) => {
        enterMutation();
        await mutationReleased;
        return operation();
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
      const pending = handler.handle(
        new Request(
          new URL("/__progressive-review/thread-commands", sessionUrl),
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-review-token": token,
            },
            body: JSON.stringify({
              command: "comment.create",
              mutationId: "message-1",
              input: {
                threadId: "thread-1",
                messageId: "message-1",
                target: {
                  kind: "text",
                  surface: {
                    type: "block",
                    tag: "p",
                    index: 0,
                    blockHash: "12345678",
                  },
                  selection: {
                    start: 2,
                    length: 5,
                    hash: "f55c314b",
                    quote: "Hello",
                  },
                },
                body: "A serialized comment",
              },
            }),
          },
        ),
      );
      await mutationEntered;
      expect(readReviewComments(reviewPath)).toEqual({});

      releaseMutation();
      await expect(pending).resolves.toHaveProperty("status", 200);
      expect(readReviewComments(reviewPath)).toHaveProperty("thread-1");
    } finally {
      releaseMutation();
      await handler.close();
    }
  });

  it("returns the current review status", async () => {
    rootPath = await mkdtemp(path.join(tmpdir(), "review-session-handler-"));
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
    rootPath = await mkdtemp(path.join(tmpdir(), "review-session-handler-"));
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
