import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  type HostCommandInputs,
  type HostCommandName,
  type HostQueryInputs,
  type HostQueryName,
  type HostQuestionRun,
  type JsonValue,
  hostCommandResponseSchema,
  hostQueryResponseSchema,
  isObjectValue,
} from "@dev.fast/review-protocol";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AsyncQueue } from "../native-agent/async-queue";
import {
  type AgentServer,
  type LaunchInput,
  type SessionUpdate,
} from "../native-agent/native-session";
import {
  type ReviewHonoEnv,
  createNodeRequestListener,
} from "../server/hono-http";
import { HostCredentials } from "./host-credentials";
import { createHostHttp } from "./host-http";
import { LocalQuestionExecutor } from "./local-question-executor";
import { ReviewHost } from "./review-host";
import { ReviewHostStore } from "./review-host-store";
import { ReviewQuestionRunner } from "./review-question-runner";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function simulatedAgent(
  options: {
    failLaunch?: boolean;
    instantAnswer?: string;
    launchGate?: Promise<void>;
  } = {},
) {
  const inputs: LaunchInput[] = [];
  const queues = new Map<string, AsyncQueue<SessionUpdate>>();
  const closed: string[] = [];
  const server: AgentServer = {
    harness: "codex",
    async launch(input) {
      inputs.push(input);
      await options.launchGate;
      if (options.failLaunch)
        throw new Error(
          `Internal launch error ${input.environment?.DEV_REVIEW_HOST_TOKEN}`,
        );
      const sessionId = randomUUID();
      const queue = new AsyncQueue<SessionUpdate>();
      queues.set(sessionId, queue);
      if (options.instantAnswer) {
        queue.push(answer(options.instantAnswer));
        queue.push({ type: "status.changed", status: "idle" });
      }
      return {
        sessionId,
        command: {
          cwd: input.cwd,
          executable: "codex",
          args: [],
          env: { ...input.environment },
        },
      };
    },
    async updates(sessionId) {
      const queue = queues.get(sessionId);
      if (!queue) throw new Error("Unknown test session");
      return {
        updates: queue,
        close: async () => {
          closed.push(sessionId);
          queue.close();
        },
      };
    },
    async interrupt() {
      throw new Error("No automatic external-session cancellation");
    },
    async close() {
      for (const queue of queues.values()) queue.close();
    },
  };
  return {
    server,
    inputs,
    queues,
    closed,
    finish(sessionId: string, body: string) {
      const queue = queues.get(sessionId)!;
      queue.push(answer(body));
      queue.push({ type: "status.changed", status: "idle" });
    },
  };
}

function answer(body: string): SessionUpdate {
  return {
    type: "message.updated",
    message: {
      id: randomUUID(),
      role: "assistant",
      body,
      createdAt: "2026-09-10T12:00:00Z",
    },
  };
}

async function fixture(
  agentOptions: Parameters<typeof simulatedAgent>[0] = {},
) {
  const directory = mkdtempSync(path.join(tmpdir(), "review-question-runner-"));
  const repository = path.join(directory, "repository");
  mkdirSync(repository);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repository, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Review Test");
  git("config", "user.email", "review@example.invalid");
  git("config", "commit.gpgsign", "false");
  writeFileSync(
    path.join(repository, "source.ts"),
    "export const value = 1;\n",
  );
  git("add", ".");
  git("commit", "-m", "Source");
  const databasePath = path.join(directory, "review.db");
  const store = new ReviewHostStore(databasePath);
  const desktopToken = "desktop-human-private-credential";
  const credentials = new HostCredentials(store, desktopToken);
  const agent = simulatedAgent(agentOptions);
  let runner!: ReviewQuestionRunner;
  const launches: Promise<void>[] = [];
  const host = new ReviewHost(store, {
    questions: {
      capabilities: () => runner.capabilities(),
      start: (run) => {
        const started = runner.start(run);
        launches.push(started);
        return started;
      },
    },
  });
  let baseUrl = "";
  runner = new ReviewQuestionRunner({
    host,
    credentials,
    baseUrl: () => baseUrl,
    executor: new LocalQuestionExecutor({
      agentServer: () => agent.server,
      isAvailable: async (harness) => harness === "codex",
    }),
  });
  const router = createHostHttp({
    host,
    credentials,
    baseUrl: () => baseUrl,
    openReview: async () => {},
  });
  const app = new Hono<ReviewHonoEnv>();
  app.route("/v1", router.app);
  const server = createServer(createNodeRequestListener(app));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!isObjectValue(address)) throw new Error("Expected TCP listener");
  baseUrl = `http://127.0.0.1:${address.port}`;
  let stopped = false;
  let storeClosed = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    router.close();
    await runner.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  };
  cleanup.push(async () => {
    await stop();
    if (!storeClosed) store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const clientId = randomUUID();
  const post = (
    category: "commands" | "queries",
    request: JsonValue,
    token = desktopToken,
  ) =>
    fetch(`${baseUrl}/v1/workspaces/${store.workspaceId}/${category}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-review-token": token,
        "x-review-client-id": clientId,
      },
      body: JSON.stringify(request),
    });
  const command = async <K extends HostCommandName>(
    type: K,
    input: HostCommandInputs[K],
    token = desktopToken,
    commandId = randomUUID(),
  ) => {
    const response = await post("commands", { type, input, commandId }, token);
    const parsed = hostCommandResponseSchema(type).parse(await response.json());
    if (!parsed.ok)
      throw new Error(`${parsed.error.code}: ${parsed.error.message}`);
    return parsed.data.result;
  };
  const query = async <K extends HostQueryName>(
    type: K,
    input: HostQueryInputs[K],
    token = desktopToken,
  ) => {
    const response = await post("queries", { type, input }, token);
    const parsed = hostQueryResponseSchema(type).parse(await response.json());
    if (!parsed.ok)
      throw new Error(`${parsed.error.code}: ${parsed.error.message}`);
    return parsed.data.result;
  };
  const registered = await command("repository.register", { path: repository });
  if (!("id" in registered)) throw new Error("Expected repository");
  const createReview = async (title = "Questions") => {
    const created = await command("review.create", {
      repositoryId: registered.id,
      title,
      change: { kind: "snapshot", ref: "HEAD" },
    });
    if (!("review" in created)) throw new Error("Expected review");
    return created.review;
  };
  const review = await createReview();
  const ask = async (
    body = "Why is the value immutable?",
    commandId = randomUUID(),
  ) => {
    const created = await command(
      "question.start",
      {
        reviewId: review.id,
        target: { kind: "document", reviewVersion: 0 },
        body,
        harness: "codex",
      },
      desktopToken,
      commandId,
    );
    if (!("run" in created) || !("thread" in created))
      throw new Error("Expected question run and thread");
    return created;
  };
  return {
    directory,
    databasePath,
    repository,
    store,
    credentials,
    desktopToken,
    host,
    runner,
    agent,
    launches,
    baseUrl,
    post,
    command,
    query,
    review,
    createReview,
    ask,
    stop,
    closeStore() {
      store.close();
      storeClosed = true;
    },
  };
}

async function running(
  test: Awaited<ReturnType<typeof fixture>>,
  run: HostQuestionRun,
) {
  await vi.waitFor(() =>
    expect(test.store.questionRun(run.reviewId, run.id).state).toBe("running"),
  );
  return test.store.questionRun(run.reviewId, run.id).sessionId!;
}

describe("host-owned question runner", () => {
  it("launches once after durable acceptance with only review/read/answer credentials", async () => {
    const f = await fixture();
    const id = randomUUID();
    const question = await f.ask(undefined, id);
    const session = await running(f, question.run);
    const retry = await f.ask(undefined, id);
    expect(retry).toEqual(question);
    expect(f.agent.inputs).toHaveLength(1);
    const launched = f.agent.inputs[0]!;
    const token = launched.environment!.DEV_REVIEW_HOST_TOKEN!;
    expect(token).not.toBe(f.credentials.agentToken);
    expect(token).not.toBe(f.desktopToken);
    expect(launched.session).toBeUndefined();
    expect(launched.cwd).toBe(realpathSync(f.repository));
    expect(launched.prompt?.text).toContain(question.message.body);
    expect(launched.prompt?.text).not.toContain(token);
    const access = f.credentials.authenticate(token)!;
    expect(access.principal).toEqual(question.run.assistant);
    expect(access.permissions).toEqual(new Set(["read", "answer"]));
    expect(access.reviewIds).toEqual(new Set([f.review.id]));
    expect(access.runIds).toEqual(new Set([question.run.id]));
    expect(
      await f.query(
        "document.get",
        { reviewId: f.review.id, reviewVersion: 0 },
        token,
      ),
    ).toMatchObject({ reviewId: f.review.id, reviewVersion: 0 });
    const other = await f.createReview("Unrelated private review");
    await expect(
      f.query("review.get", { reviewId: other.id }, token),
    ).rejects.toThrow("NOT_FOUND");
    await expect(
      f.command(
        "document.mutate",
        {
          reviewId: f.review.id,
          expectedReviewVersion: 0,
          operations: [
            {
              op: "node.insert",
              node: {
                id: "unauthorized",
                type: "markdown",
                markdown: "Bad edit",
              },
              placement: { parentId: null, position: { kind: "start" } },
            },
          ],
        },
        token,
      ),
    ).rejects.toThrow("FORBIDDEN");
    await expect(
      f.command(
        "review.close",
        { reviewId: f.review.id, expectedStateVersion: 0 },
        token,
      ),
    ).rejects.toThrow("FORBIDDEN");
    await expect(
      f.command(
        "question.complete",
        {
          reviewId: f.review.id,
          runId: randomUUID(),
          body: "Wrong run",
        },
        token,
      ),
    ).rejects.toThrow("FORBIDDEN");
    const discovery = await (
      await fetch(`${f.baseUrl}/v1/connection`, {
        headers: { "x-review-token": token },
      })
    ).json();
    expect(JSON.stringify(discovery)).not.toContain(token);
    expect(
      JSON.stringify(
        await f.query(
          "question.context",
          { reviewId: f.review.id, runId: question.run.id },
          token,
        ),
      ),
    ).not.toContain(token);
    for (const filename of readdirSync(f.directory).filter((name) =>
      name.startsWith("review.db"),
    ))
      expect(
        readFileSync(path.join(f.directory, filename)).includes(
          Buffer.from(token),
        ),
      ).toBe(false);
    expect(
      existsSync(path.join(f.directory, "review-desktop", "host.json")),
    ).toBe(false);
    f.agent.finish(session, "Writes go through a transaction.");
    await vi.waitFor(() =>
      expect(f.credentials.authenticate(token)).toBeNull(),
    );
    expect(f.store.questionRun(f.review.id, question.run.id).state).toBe(
      "completed",
    );
    await expect(
      f.query(
        "document.get",
        { reviewId: f.review.id, reviewVersion: 0 },
        token,
      ),
    ).rejects.toThrow("UNAUTHORIZED");
  });

  it("retains a fast final answer and native session even when buffered before start returns", async () => {
    const f = await fixture({ instantAnswer: "A buffered final answer." });
    const question = await f.ask();
    await vi.waitFor(() =>
      expect(f.store.questionRun(f.review.id, question.run.id).state).toBe(
        "completed",
      ),
    );
    const completed = f.store.questionRun(f.review.id, question.run.id);
    expect(completed.sessionId).toBe([...f.agent.queues.keys()][0]);
    expect(
      f.store
        .messages(f.review.id, question.thread.id)
        .map((message) => message.body),
    ).toEqual([question.message.body, "A buffered final answer."]);
    expect(
      f.store.questionContext(f.review.id, question.run.contextId).question,
    ).toBe(question.message.body);
  });

  it("records a sanitized failed launch without losing the question, and revokes its token", async () => {
    const f = await fixture({ failLaunch: true });
    const question = await f.ask();
    await vi.waitFor(() =>
      expect(f.store.questionRun(f.review.id, question.run.id).state).toBe(
        "failed",
      ),
    );
    const token = f.agent.inputs[0]!.environment!.DEV_REVIEW_HOST_TOKEN!;
    expect(f.credentials.authenticate(token)).toBeNull();
    const run = f.store.questionRun(f.review.id, question.run.id);
    expect(run.sessionId).toBeNull();
    expect(run.error).toContain("could not start");
    expect(run.error).not.toContain(token);
    expect(f.store.messages(f.review.id, question.thread.id)).toEqual([
      question.message,
    ]);
    expect(
      f.store.questionContext(f.review.id, question.run.contextId).question,
    ).toBe(question.message.body);
  });

  it("saves completed output after the review closes", async () => {
    const f = await fixture();
    const question = await f.ask();
    const session = await running(f, question.run);
    await f.command("review.close", {
      reviewId: f.review.id,
      expectedStateVersion: f.store.review(f.review.id).stateVersion,
    });
    f.agent.finish(session, "The accepted question is still answered.");
    await vi.waitFor(() =>
      expect(f.store.questionRun(f.review.id, question.run.id).state).toBe(
        "completed",
      ),
    );
    expect(f.store.messages(f.review.id, question.thread.id).at(-1)?.body).toBe(
      "The accepted question is still answered.",
    );
    expect(f.store.review(f.review.id).state).toBe("closed");
  });

  it("allows the scoped API to persist its answer and ignores a duplicate native final", async () => {
    const f = await fixture();
    const question = await f.ask();
    const session = await running(f, question.run);
    const token = f.agent.inputs[0]!.environment!.DEV_REVIEW_HOST_TOKEN!;
    await f.command(
      "question.complete",
      {
        reviewId: f.review.id,
        runId: question.run.id,
        body: "Saved by the scoped tool.",
      },
      token,
    );
    f.agent.finish(
      session,
      "A competing native final must not replace the saved output.",
    );
    await vi.waitFor(() =>
      expect(f.credentials.authenticate(token)).toBeNull(),
    );
    expect(
      f.store
        .messages(f.review.id, question.thread.id)
        .map((message) => message.body),
    ).toEqual([question.message.body, "Saved by the scoped tool."]);
  });

  it("shutdown revokes credentials, persists interruption, and prevents callbacks after store close", async () => {
    const f = await fixture();
    const question = await f.ask();
    const session = await running(f, question.run);
    const token = f.agent.inputs[0]!.environment!.DEV_REVIEW_HOST_TOKEN!;
    await f.stop();
    expect(f.credentials.authenticate(token)).toBeNull();
    expect(f.agent.closed).toContain(session);
    expect(f.store.questionRun(f.review.id, question.run.id).state).toBe(
      "interrupted",
    );
    f.closeStore();
    f.agent.finish(session, "Late output is not accepted.");
    await Promise.all(f.launches);
    const restarted = new ReviewHostStore(f.databasePath);
    try {
      expect(restarted.questionRun(f.review.id, question.run.id).state).toBe(
        "interrupted",
      );
      expect(restarted.messages(f.review.id, question.thread.id)).toHaveLength(
        1,
      );
      const credentials = new HostCredentials(
        restarted,
        "restarted-human-credential",
      );
      expect(credentials.authenticate(token)).toBeNull();
      expect(f.agent.inputs).toHaveLength(1);
    } finally {
      restarted.close();
    }
  });

  it("handles shutdown during an unresolved native launch without touching a closed store", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture({ launchGate: gate });
    const question = await f.ask();
    await vi.waitFor(() => expect(f.agent.inputs).toHaveLength(1));
    const token = f.agent.inputs[0]!.environment!.DEV_REVIEW_HOST_TOKEN!;
    await f.stop();
    expect(f.store.questionRun(f.review.id, question.run.id).state).toBe(
      "interrupted",
    );
    expect(f.credentials.authenticate(token)).toBeNull();
    f.closeStore();
    release();
    await Promise.all(f.launches);
    expect(f.agent.closed).toHaveLength(1);
  });

  it("startup interrupts persisted unfinished work without resuming an external session", async () => {
    const f = await fixture({ instantAnswer: "Initial completed answer." });
    const question = await f.ask();
    await vi.waitFor(() =>
      expect(f.store.questionRun(f.review.id, question.run.id).state).toBe(
        "completed",
      ),
    );
    await f.stop();
    const interruptedId = randomUUID();
    f.store.command(
      { clientId: "crash-fixture", commandId: randomUUID(), request: {} },
      () => {
        f.store.createQuestionRun({ ...question.run, id: interruptedId });
        f.store.updateQuestionRun(f.review.id, interruptedId, {
          state: "running",
          sessionId: "external-session-before-crash",
        });
        return null;
      },
    );
    f.closeStore();
    const restarted = new ReviewHostStore(f.databasePath);
    try {
      const host = new ReviewHost(restarted);
      host.interruptQuestionRuns();
      expect(restarted.questionRun(f.review.id, interruptedId)).toMatchObject({
        state: "interrupted",
        sessionId: "external-session-before-crash",
      });
      expect(restarted.questionRun(f.review.id, question.run.id).state).toBe(
        "completed",
      );
      expect(f.agent.inputs).toHaveLength(1);
    } finally {
      restarted.close();
    }
  });

  it("closes an already-authorized event stream when its question credential is revoked", async () => {
    const f = await fixture();
    const question = await f.ask();
    const session = await running(f, question.run);
    const token = f.agent.inputs[0]!.environment!.DEV_REVIEW_HOST_TOKEN!;
    const controller = new AbortController();
    const stream = await fetch(
      `${f.baseUrl}/v1/workspaces/${f.store.workspaceId}/events?after=${encodeURIComponent(f.store.cursor())}&reviewId=${f.review.id}`,
      { headers: { "x-review-token": token }, signal: controller.signal },
    );
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    try {
      f.agent.finish(session, "A final answer revokes this connection.");
      await vi.waitFor(() =>
        expect(f.credentials.authenticate(token)).toBeNull(),
      );
      const observed: string[] = [];
      const untilClosed = (async () => {
        while (true) {
          const next = await reader.read();
          if (next.done) return;
          observed.push(new TextDecoder().decode(next.value));
        }
      })();
      await f.command("review.update", {
        reviewId: f.review.id,
        expectedReviewVersion: f.store.review(f.review.id).latestReviewVersion,
        title: "Private later update",
        description: "",
        labels: [],
      });
      let ended = false;
      void untilClosed
        .then(() => {
          ended = true;
        })
        .catch(() => {});
      await vi.waitFor(() => expect(ended).toBe(true), { timeout: 1000 });
      expect(observed.join("")).not.toContain("Private later update");
    } finally {
      controller.abort();
      await reader.cancel().catch(() => {});
    }
  });
});
