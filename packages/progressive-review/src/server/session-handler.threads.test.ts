import path from "node:path";

import {
  type CreateReviewCommentInput,
  type ReviewThreadsCommit,
} from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readReviewComments } from "../review-state-store";
import { cleanupTempDirs, tempDir } from "../review-test-utils";
import { ReviewThreadsService } from "../review-threads-service";
import { createReviewSessionHandler } from "./session-handler";
import { unusedAgentServices } from "./session-handler-test-utils";

afterEach(cleanupTempDirs);

describe("createReviewSessionHandler", () => {
  it("shares external commits with every open session and unsubscribes closed sessions", async () => {
    const rootPath = await tempDir("review-shared-comments-");
    const reviewPath = path.join(rootPath, "review.mdx");

    const service = new ReviewThreadsService({
      reviewPath,
      author: "Reviewer",
    });

    const changes = [
      vi.fn<(commit: ReviewThreadsCommit) => void>(),
      vi.fn<(commit: ReviewThreadsCommit) => void>(),
    ];

    const handlers = await Promise.all(
      changes.map((onReviewThreadsCommit) =>
        createReviewSessionHandler({
          ...unusedAgentServices,
          rootPath,
          toolingRoot: rootPath,
          reviewPath,
          routePath: "/",
          token: "secret",
          session: {
            rootPath,
            baseRef: "HEAD",
            reviewPath,
            appUrl: "http://localhost",
            startedAt: Date.now(),
          },
          threadsService: () => service,
          onReviewThreadsCommit,
        }),
      ),
    );

    try {
      for (const handler of handlers) {
        const response = await handler.handle(
          new Request("http://localhost/__progressive-review/comments", {
            headers: { "x-review-token": "secret" },
          }),
        );

        expect(response.status).toBe(200);
      }

      const first = service.dispatch({
        command: "comment.create",
        mutationId: "external-create",
        input: {
          threadId: "shared",
          messageId: "question",
          target: { kind: "document" },
          body: "Shared question",
        },
      });

      for (const changed of changes)
        expect(changed).toHaveBeenCalledExactlyOnceWith(first);
      await handlers[0]!.close();

      const second = service.dispatch({
        command: "comment.update",
        mutationId: "external-resolve",
        threadId: "shared",
        update: { status: "resolved" },
      });

      expect(changes[0]).toHaveBeenCalledTimes(1);
      expect(changes[1]).toHaveBeenLastCalledWith(second);

      const snapshot = await handlers[1]!.handle(
        new Request("http://localhost/__progressive-review/comments", {
          headers: { "x-review-token": "secret" },
        }),
      );

      expect(await snapshot.json()).toMatchObject({
        ok: true,
        snapshot: {
          revision: second!.revision,
          comments: { shared: { status: "resolved" } },
        },
      });
    } finally {
      await Promise.all(handlers.map((handler) => handler.close()));
    }
  });
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
