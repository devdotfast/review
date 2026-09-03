import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type JsonObject, isJsonObject } from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionRef } from "../authoring-session";
import { bindReviewAuthorSession, findReview } from "../review-home";
import type { ReviewSubmissionEvent } from "../types";
import { createGlobalReviewServer } from "./desktop-server";
import { materializePublishRevision } from "./publish-stage";
import type {
  ReviewSessionHandler,
  ReviewSessionHandlerInput,
} from "./session-handler";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const token = "tutorial-test-token";
type TutorialAuthoringFactory = NonNullable<
  Parameters<
    typeof createGlobalReviewServer
  >[0]["tutorialAuthoringSessionFactory"]
>;
type GlobalServerInput = Parameters<typeof createGlobalReviewServer>[0];
type TutorialServerOverrides = Partial<
  Pick<
    GlobalServerInput,
    | "publishRuntime"
    | "sessionHandlerFactory"
    | "tutorialAgentResolver"
    | "tutorialAuthorSessionBinder"
  >
>;

afterEach(() => vi.unstubAllEnvs());

describe("Review Desktop tutorial preparation", () => {
  it("prepares locally, starts one handoff on open, and reuses it after restart", async () => {
    const home = await mkdtemp(
      path.join(os.tmpdir(), "review-tutorial-server-"),
    );
    vi.stubEnv("DEV_REVIEW_HOME", home);
    const handlers: ReviewSessionHandlerInput[] = [];
    let release!: (session: SessionRef) => void;
    const handoff = new Promise<SessionRef>((resolve) => {
      release = resolve;
    });
    const authoringFactory = vi.fn<TutorialAuthoringFactory>(
      async () => handoff,
    );
    const first = tutorialServer(home, handlers, authoringFactory);

    try {
      await first.listen();
      const [preparedA, preparedB] = await Promise.all([
        tutorialRequest(first.url, "/tutorial/prepare", "POST"),
        tutorialRequest(first.url, "/tutorial/prepare", "POST"),
      ]);
      expect(preparedA.status).toBe(200);
      expect(preparedB.status).toBe(200);
      expect(authoringFactory).not.toHaveBeenCalled();

      const opened = await tutorialJson(first.url, "/tutorial/open", "POST");
      await vi.waitFor(() => expect(authoringFactory).toHaveBeenCalledOnce());
      expect(handlers).toHaveLength(1);
      const resolver = handlers[0]?.resolveQuestionSourceSession;
      expect(resolver).toBeTypeOf("function");
      const earlyAskA = resolver!();
      const earlyAskB = resolver!();
      expect(authoringFactory).toHaveBeenCalledOnce();

      release({ harness: "codex", sessionId: "tutorial-source" });
      await expect(Promise.all([earlyAskA, earlyAskB])).resolves.toEqual([
        { harness: "codex", sessionId: "tutorial-source" },
        { harness: "codex", sessionId: "tutorial-source" },
      ]);
      const stored = await findReview(String(opened.reviewUuid));
      expect(stored?.review).toMatchObject({
        sourceSession: "codex:tutorial-source",
        agentSessions: {
          "codex:tutorial-source": { roles: ["author"] },
        },
      });

      await first.close();
      handlers.length = 0;
      const restartedFactory = vi.fn<TutorialAuthoringFactory>(async () => {
        throw new Error("restart must reuse the durable source session");
      });
      const restarted = tutorialServer(home, handlers, restartedFactory);
      try {
        await restarted.listen();
        await tutorialRequest(restarted.url, "/tutorial/open", "POST");
        expect(restartedFactory).not.toHaveBeenCalled();
        expect(handlers[0]?.session.agent).toEqual({
          harness: "codex",
          sessionId: "tutorial-source",
        });
      } finally {
        await restarted.close();
      }
    } finally {
      await first.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("shares one successful Ask retry after a failed background handoff", async () => {
    const home = await mkdtemp(
      path.join(os.tmpdir(), "review-tutorial-server-"),
    );
    vi.stubEnv("DEV_REVIEW_HOME", home);
    const handlers: ReviewSessionHandlerInput[] = [];
    let attempt = 0;
    const authoringFactory = vi.fn<TutorialAuthoringFactory>(async () => {
      if (++attempt === 1) throw new Error("transient model failure");
      return { harness: "codex", sessionId: "tutorial-retry" };
    });
    const server = tutorialServer(home, handlers, authoringFactory);

    try {
      await server.listen();
      const opened = await tutorialJson(server.url, "/tutorial/open", "POST");
      await vi.waitFor(() => expect(authoringFactory).toHaveBeenCalledOnce());
      const resolver = handlers[0]?.resolveQuestionSourceSession;
      await expect(Promise.all([resolver!(), resolver!()])).resolves.toEqual([
        { harness: "codex", sessionId: "tutorial-retry" },
        { harness: "codex", sessionId: "tutorial-retry" },
      ]);
      expect(authoringFactory).toHaveBeenCalledTimes(2);
      await expect(
        findReview(String(opened.reviewUuid)),
      ).resolves.toMatchObject({
        review: { sourceSession: "codex:tutorial-retry" },
      });
    } finally {
      await server.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("stops retrying after the shared Ask retry fails", async () => {
    const home = await mkdtemp(
      path.join(os.tmpdir(), "review-tutorial-server-"),
    );
    vi.stubEnv("DEV_REVIEW_HOME", home);
    const handlers: ReviewSessionHandlerInput[] = [];
    const authoringFactory = vi.fn<TutorialAuthoringFactory>(async () => {
      throw new Error("model unavailable");
    });
    const server = tutorialServer(home, handlers, authoringFactory);

    try {
      await server.listen();
      const opened = await tutorialJson(server.url, "/tutorial/open", "POST");
      await vi.waitFor(() => expect(authoringFactory).toHaveBeenCalledOnce());
      const resolver = handlers[0]?.resolveQuestionSourceSession;
      await expect(Promise.all([resolver!(), resolver!()])).resolves.toEqual([
        undefined,
        undefined,
      ]);
      expect(authoringFactory).toHaveBeenCalledTimes(2);
      await expect(resolver?.()).resolves.toBeUndefined();
      expect(authoringFactory).toHaveBeenCalledTimes(2);

      const deleted = await tutorialRequest(server.url, "/tutorial", "DELETE");
      expect(deleted.status).toBe(200);
      await expect(findReview(String(opened.reviewUuid))).resolves.toBeNull();
    } finally {
      await server.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("cancels an in-flight handoff when the tutorial is deleted", async () => {
    const home = await mkdtemp(
      path.join(os.tmpdir(), "review-tutorial-server-"),
    );
    vi.stubEnv("DEV_REVIEW_HOME", home);
    let canceled = false;
    const authoringFactory = vi.fn<TutorialAuthoringFactory>(
      async (input) =>
        new Promise<SessionRef>((_resolve, reject) => {
          input.signal?.addEventListener(
            "abort",
            () => {
              canceled = true;
              reject(new Error("canceled"));
            },
            { once: true },
          );
        }),
    );
    const handlers: ReviewSessionHandlerInput[] = [];
    const server = tutorialServer(home, handlers, authoringFactory);

    try {
      await server.listen();
      const opened = await tutorialJson(server.url, "/tutorial/open", "POST");
      await vi.waitFor(() => expect(authoringFactory).toHaveBeenCalledOnce());
      const waitingAsk = handlers[0]?.resolveQuestionSourceSession?.();
      const deleted = await tutorialRequest(server.url, "/tutorial", "DELETE");
      expect(deleted.status).toBe(200);
      expect(canceled).toBe(true);
      await expect(waitingAsk).resolves.toBeUndefined();
      await Promise.resolve();
      expect(authoringFactory).toHaveBeenCalledOnce();
      await expect(findReview(String(opened.reviewUuid))).resolves.toBeNull();
    } finally {
      await server.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("repairs missing cached artifacts and self-heals after generic deletion", async () => {
    const home = await mkdtemp(
      path.join(os.tmpdir(), "review-tutorial-server-"),
    );
    vi.stubEnv("DEV_REVIEW_HOME", home);
    const handlers: ReviewSessionHandlerInput[] = [];
    let source = 0;
    const authoringFactory = vi.fn<TutorialAuthoringFactory>(async () => ({
      harness: "codex",
      sessionId: `tutorial-source-${++source}`,
    }));
    const close = vi.fn<ReviewSessionHandler["close"]>(async () => undefined);
    const server = tutorialServer(home, handlers, authoringFactory, {
      sessionHandlerFactory: async (input) => {
        handlers.push(input);
        return { ...stubSessionHandler(), close };
      },
    });

    try {
      await server.listen();
      const first = await tutorialJson(server.url, "/tutorial/open", "POST");
      await vi.waitFor(() => expect(authoringFactory).toHaveBeenCalledOnce());
      const firstHandler = handlers[0];
      expect(firstHandler).toBeDefined();
      await rm(firstHandler!.reviewPath, { force: true });

      const repaired = await tutorialRequest(
        server.url,
        "/tutorial/prepare",
        "POST",
      );
      expect(repaired.status).toBe(200);
      expect(existsSync(firstHandler!.reviewPath)).toBe(true);
      expect(close).toHaveBeenCalledOnce();

      await tutorialRequest(server.url, "/tutorial/open", "POST");
      expect(handlers).toHaveLength(2);
      const repairedHandler = handlers[1];
      expect(repairedHandler).toBeDefined();
      expect(repairedHandler).not.toBe(firstHandler);
      await rm(repairedHandler!.session.headRootPath!, {
        recursive: true,
        force: true,
      });
      const checkoutRepaired = await tutorialRequest(
        server.url,
        "/tutorial/prepare",
        "POST",
      );
      expect(checkoutRepaired.status).toBe(200);
      expect(existsSync(repairedHandler!.session.headRootPath!)).toBe(true);

      const deleted = await tutorialRequest(
        server.url,
        `/reviews/${String(first.reviewUuid)}`,
        "DELETE",
      );
      expect(deleted.status).toBe(200);
      await expect(findReview(String(first.reviewUuid))).resolves.toBeNull();

      const second = await tutorialJson(server.url, "/tutorial/open", "POST");
      expect(second.reviewUuid).not.toBe(first.reviewUuid);
      const secondHandler = handlers.at(-1);
      expect(secondHandler).toBeDefined();
      expect(existsSync(secondHandler!.reviewPath)).toBe(true);
      expect(existsSync(secondHandler!.session.baseRootPath!)).toBe(true);
      expect(existsSync(secondHandler!.session.headRootPath!)).toBe(true);
    } finally {
      await server.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("orders prepare, delete, and a following prepare without partial state", async () => {
    const home = await mkdtemp(
      path.join(os.tmpdir(), "review-tutorial-server-"),
    );
    vi.stubEnv("DEV_REVIEW_HOME", home);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let blockFirst = true;
    const server = tutorialServer(
      home,
      [],
      vi.fn<TutorialAuthoringFactory>(async () => ({
        harness: "codex",
        sessionId: "unused",
      })),
      {
        publishRuntime: {
          materializePublishRevision: async (input) => {
            if (blockFirst) {
              blockFirst = false;
              entered();
              await gate;
            }
            return materializePublishRevision(input);
          },
        },
      },
    );

    try {
      await server.listen();
      const unrelatedUuid = "22222222-2222-4222-8222-222222222222";
      await mkdir(path.join(home, "reviews", unrelatedUuid), {
        recursive: true,
      });
      const firstPrepare = tutorialRequest(
        server.url,
        "/tutorial/prepare",
        "POST",
      );
      await started;
      const unrelatedDeletion = tutorialRequest(
        server.url,
        `/reviews/${unrelatedUuid}`,
        "DELETE",
      );
      await expect(
        Promise.race([
          unrelatedDeletion,
          new Promise<never>((_resolve, reject) =>
            setTimeout(
              () => reject(new Error("unrelated delete was blocked")),
              500,
            ),
          ),
        ]),
      ).resolves.toMatchObject({ status: 200 });
      const deletion = tutorialRequest(server.url, "/tutorial", "DELETE");
      await new Promise((resolve) => setTimeout(resolve, 20));
      const secondPrepare = tutorialRequest(
        server.url,
        "/tutorial/prepare",
        "POST",
      );
      release();

      const first = await responseJson(firstPrepare);
      expect((await deletion).status).toBe(200);
      const second = await responseJson(secondPrepare);
      expect(second.reviewUuid).not.toBe(first.reviewUuid);
      await expect(findReview(String(first.reviewUuid))).resolves.toBeNull();
      await expect(
        findReview(String(second.reviewUuid)),
      ).resolves.not.toBeNull();
    } finally {
      release();
      await server.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rebuilds for a changed installed harness and rejects when none remains", async () => {
    const home = await mkdtemp(
      path.join(os.tmpdir(), "review-tutorial-server-"),
    );
    vi.stubEnv("DEV_REVIEW_HOME", home);
    let agent: "codex" | "pi" | undefined = "codex";
    const authoringFactory = vi.fn<TutorialAuthoringFactory>(async () => ({
      harness: "codex",
      sessionId: "unused",
    }));
    const server = tutorialServer(home, [], authoringFactory, {
      tutorialAgentResolver: async () => agent,
    });

    try {
      await server.listen();
      const first = await tutorialJson(server.url, "/tutorial/prepare", "POST");
      expect(
        (await findReview(String(first.reviewUuid)))?.review.sourceSession,
      ).toBe("fresh:codex");

      agent = "pi";
      const second = await tutorialJson(
        server.url,
        "/tutorial/prepare",
        "POST",
      );
      expect(second.reviewUuid).not.toBe(first.reviewUuid);
      await expect(findReview(String(first.reviewUuid))).resolves.toBeNull();
      expect(
        (await findReview(String(second.reviewUuid)))?.review.sourceSession,
      ).toBe("fresh:pi");

      agent = undefined;
      const unavailable = await tutorialRequest(
        server.url,
        "/tutorial/prepare",
        "POST",
      );
      expect(unavailable.status).toBe(409);
      expect(authoringFactory).not.toHaveBeenCalled();
    } finally {
      await server.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  it.each(["submit", "dismiss"] as const)(
    "serializes author binding with %s",
    async (action) => {
      const home = await mkdtemp(
        path.join(os.tmpdir(), "review-tutorial-server-"),
      );
      vi.stubEnv("DEV_REVIEW_HOME", home);
      const handlers: ReviewSessionHandlerInput[] = [];
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const binder = vi.fn<typeof bindReviewAuthorSession>(async (...args) => {
        entered();
        await gate;
        return bindReviewAuthorSession(...args);
      });
      const server = tutorialServer(
        home,
        handlers,
        vi.fn<TutorialAuthoringFactory>(async () => ({
          harness: "codex",
          sessionId: "tutorial-source",
        })),
        { tutorialAuthorSessionBinder: binder },
      );

      try {
        await server.listen();
        const opened = await tutorialJson(server.url, "/tutorial/open", "POST");
        await started;
        const handler = handlers[0];
        expect(handler).toBeDefined();
        const userAction =
          action === "submit"
            ? handler!.onSubmission!(submissionEvent())
            : handler!.onReviewDismiss!();
        let settled = false;
        void Promise.resolve(userAction).finally(() => {
          settled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(settled).toBe(false);

        release();
        await userAction;
        const stored = await findReview(String(opened.reviewUuid));
        expect(stored?.review.sourceSession).toBe("codex:tutorial-source");
        expect(stored?.review.status).toBe(
          action === "submit" ? "accepted" : "awaiting-review",
        );
        expect(stored?.review.dismissedAt !== undefined).toBe(
          action === "dismiss",
        );
      } finally {
        release();
        await server.close();
        await rm(home, { recursive: true, force: true });
      }
    },
  );
});

function tutorialServer(
  home: string,
  handlers: ReviewSessionHandlerInput[],
  tutorialAuthoringSessionFactory: TutorialAuthoringFactory,
  overrides: TutorialServerOverrides = {},
) {
  return createGlobalReviewServer({
    appPid: process.pid,
    packageRoot,
    toolingRoot: packageRoot,
    port: 0,
    token,
    discoveryPath: path.join(home, "desktop.json"),
    tutorialAgentResolver: async () => "codex",
    tutorialAuthoringSessionFactory,
    sessionHandlerFactory: async (input) => {
      handlers.push(input);
      return stubSessionHandler();
    },
    ...overrides,
  });
}

function stubSessionHandler(): ReviewSessionHandler {
  return {
    token,
    handle: async () => new Response("not found", { status: 404 }),
    close: async () => undefined,
  };
}

function tutorialRequest(
  serverUrl: string,
  route: string,
  method: "POST" | "DELETE",
): Promise<Response> {
  return fetch(`${serverUrl}${route}`, {
    method,
    headers: { "x-review-token": token },
  });
}

function tutorialJson(
  serverUrl: string,
  route: string,
  method: "POST",
): Promise<JsonObject> {
  return responseJson(tutorialRequest(serverUrl, route, method));
}

async function responseJson(response: Promise<Response>): Promise<JsonObject> {
  const resolved = await response;
  expect(resolved.status).toBe(200);
  const body = await resolved.json();
  if (!isJsonObject(body)) {
    throw new Error("Expected a JSON object response body.");
  }
  return body;
}

function submissionEvent(): ReviewSubmissionEvent {
  return {
    id: "tutorial-submission",
    decision: "approve",
    createdAt: "2026-08-26T20:00:00.000Z",
    rootPath: "/tutorial",
    reviewPath: "/tutorial/review.mdx",
    documentRoute: "/",
    comments: [],
    prompt: "Approve the tutorial Review.",
  };
}
