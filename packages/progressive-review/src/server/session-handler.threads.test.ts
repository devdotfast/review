import path from "node:path";

import {
  type CreateReviewCommentInput,
  type ReviewThreadsCommit,
} from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readReviewComments } from "../review-state-store";
import { cleanupTempDirs, tempDir } from "../review-test-utils";
import { createReviewSessionHandler } from "./session-handler";
import { unusedAgentServices } from "./session-handler-test-utils";

afterEach(cleanupTempDirs);

describe("createReviewSessionHandler", () => {
  it("returns committed state and announces only applied changes", async () => {
    const rootPath = await tempDir("review-session-handler-");
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
    ) => {
      const headers = new Headers({ "x-review-token": token });
      const init: RequestInit = { method, headers };
      if (body) {
        headers.set("content-type", "application/json");
        init.body = JSON.stringify(body);
      }
      return handler.handle(
        new Request(new URL(`/__progressive-review${path}`, sessionUrl), init),
      );
    };

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
    const rootPath = await tempDir("review-session-handler-");
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
});
