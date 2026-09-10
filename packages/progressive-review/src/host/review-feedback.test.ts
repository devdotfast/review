import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  HOST_COMMAND_DEFINITIONS,
  HOST_QUERY_DEFINITIONS,
  type HostCommandInputs,
  type HostCommandName,
  type HostCommandResults,
  HostCommandSchema,
  type HostFeedbackTarget,
  type HostPermission,
  type HostQueryInputs,
  type HostQueryName,
  type HostQueryResults,
  HostQuerySchema,
  type HostQuestionRun,
} from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it } from "vitest";

import { type HostAccess, ReviewHost } from "./review-host";
import { ReviewHostStore } from "./review-host-store";

type FeedbackDependencies = NonNullable<
  ConstructorParameters<typeof ReviewHost>[1]
>;
const directories: string[] = [];
const stores = new Set<ReviewHostStore>();
afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function access(
  kind: "human" | "agent",
  permissions: HostPermission[],
): HostAccess {
  return {
    principal: {
      id: randomUUID(),
      kind,
      displayName: kind === "human" ? "Reviewer" : "Author",
    },
    permissions: new Set(permissions),
  };
}

function git(repositoryPath: string, ...args: string[]) {
  return execFileSync("git", ["-C", repositoryPath, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function fixture(dependencies: FeedbackDependencies = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "review-feedback-"));
  directories.push(directory);
  const repositoryPath = path.join(directory, "repository");
  mkdirSync(path.join(repositoryPath, "src"), { recursive: true });
  git(repositoryPath, "init", "-b", "main");
  git(repositoryPath, "config", "user.name", "Review Test");
  git(repositoryPath, "config", "user.email", "review@example.invalid");
  git(repositoryPath, "config", "commit.gpgsign", "false");
  const source =
    Array.from(
      { length: 8 },
      (_, index) => `export const value${index} = ${index};`,
    ).join("\n") + "\n";
  writeFileSync(path.join(repositoryPath, "src/source.ts"), source);
  git(repositoryPath, "add", ".");
  git(repositoryPath, "commit", "-m", "Original source");
  const commit = git(repositoryPath, "rev-parse", "HEAD");
  const databasePath = path.join(directory, "review.db");
  let store = new ReviewHostStore(databasePath);
  stores.add(store);
  let host = new ReviewHost(store, dependencies);
  const human = access("human", [
    "read",
    "author",
    "publish",
    "human",
    "register_repository",
  ]);
  const otherHuman = access("human", ["read", "author", "human"]);
  const author = access("agent", ["read", "author", "publish"]);
  const envelope = {
    apiVersion: 1,
    hostId: store.hostId,
    workspaceId: store.workspaceId,
    clientId: randomUUID(),
  };
  const command = async <K extends HostCommandName>(
    type: K,
    input: HostCommandInputs[K],
    principal: HostAccess = human,
    commandId: string = randomUUID(),
  ): Promise<HostCommandResults[K]> => {
    const response = await host.command(
      principal,
      HostCommandSchema.parse({ ...envelope, commandId, type, input }),
    );
    // SAFETY: This operation's schema validates exactly its declared result type.
    return HOST_COMMAND_DEFINITIONS[type].result.parse(
      response.result,
    ) as HostCommandResults[K];
  };
  const query = async <K extends HostQueryName>(
    type: K,
    input: HostQueryInputs[K],
    principal: HostAccess = human,
  ): Promise<HostQueryResults[K]> => {
    const response = await host.query(
      principal,
      HostQuerySchema.parse({ ...envelope, type, input }),
    );
    // SAFETY: This operation's schema validates exactly its declared result type.
    return HOST_QUERY_DEFINITIONS[type].result.parse(
      response.result,
    ) as HostQueryResults[K];
  };
  const repository = await command("repository.register", {
    path: repositoryPath,
  });
  const create = () =>
    command(
      "review.create",
      {
        repositoryId: repository.id,
        change: { kind: "snapshot", ref: commit },
        title: "Feedback test",
      },
      author,
    );
  const { review } = await create();
  const reviewId = review.id;
  await command(
    "document.mutate",
    {
      reviewId,
      expectedDocumentVersion: 0,
      operations: [
        {
          op: "node.insert",
          node: {
            id: "intro",
            type: "markdown",
            markdown: "Original explanation",
          },
          placement: { parentId: null, afterId: null },
        },
      ],
    },
    author,
  );
  const target: HostFeedbackTarget = {
    kind: "node",
    documentVersion: 1,
    nodeId: "intro",
  };
  const saveDraft = (
    body: string,
    draftId: string = randomUUID(),
    principal: HostAccess = human,
  ) =>
    command(
      "draft.save",
      { reviewId, draftId, expectedVersion: null, target, body },
      principal,
    );
  const publish = async () => {
    const { review: current } = await query("review.get", { reviewId });
    return command(
      "review.publish",
      {
        reviewId,
        expectedDocumentVersion: current.documentVersion,
        expectedReviewVersion: current.version,
        mapVersions: { base: null, head: null },
      },
      author,
    );
  };
  const start = (
    body = "Why does this work?",
    commandId: string = randomUUID(),
  ) =>
    command(
      "question.start",
      { reviewId, target, body, harness: "codex" },
      human,
      commandId,
    );
  const repin = async (head: string, version: number) => {
    const plan = await command(
      "review.repin.plan",
      {
        reviewId,
        expectedDocumentVersion: version,
        change: { kind: "snapshot", ref: head },
      },
      author,
    );
    return command(
      "review.repin.apply",
      {
        reviewId,
        planId: plan.id,
        expectedDocumentVersion: version,
        operations: [],
      },
      author,
    );
  };
  return {
    get host() {
      return host;
    },
    get store() {
      return store;
    },
    human,
    otherHuman,
    author,
    reviewId,
    repositoryPath,
    source,
    commit,
    target,
    command,
    query,
    create,
    saveDraft,
    publish,
    start,
    repin,
    reopen(nextDependencies: FeedbackDependencies = dependencies) {
      store.close();
      stores.delete(store);
      store = new ReviewHostStore(databasePath);
      stores.add(store);
      host = new ReviewHost(store, nextDependencies);
    },
  };
}

function questionAccess(run: HostQuestionRun): HostAccess {
  return {
    principal: run.assistant,
    permissions: new Set(["read", "answer"]),
    reviewIds: new Set([run.reviewId]),
    runIds: new Set([run.id]),
  };
}

describe("host feedback workflows", () => {
  it("keeps editable drafts and their events private until explicitly submitted", async () => {
    const f = await fixture();
    const before = f.store.cursor();
    const draft = await f.saveDraft("Private unfinished thought");
    const other = await f.saveDraft(
      "Someone else's draft",
      randomUUID(),
      f.otherHuman,
    );
    const edited = await f.command("draft.save", {
      reviewId: f.reviewId,
      draftId: draft.id,
      expectedVersion: draft.version,
      target: f.target,
      body: "Ready to discuss",
    });
    expect(
      (await f.query("drafts.list", { reviewId: f.reviewId })).items,
    ).toEqual([edited]);
    expect(
      (await f.query("drafts.list", { reviewId: f.reviewId }, f.otherHuman))
        .items,
    ).toEqual([other]);
    await expect(
      f.query("drafts.list", { reviewId: f.reviewId }, f.author),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      f.command(
        "draft.delete",
        {
          reviewId: f.reviewId,
          draftId: draft.id,
          expectedVersion: edited.version,
        },
        f.otherHuman,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      f.command("draft.save", {
        reviewId: f.reviewId,
        draftId: draft.id,
        expectedVersion: draft.version,
        target: f.target,
        body: "Stale overwrite",
      }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(
      (await f.query("threads.list", { reviewId: f.reviewId }, f.author)).items,
    ).toEqual([]);
    expect(
      f.host.events(f.author, f.store.workspaceId, before, f.reviewId),
    ).toEqual([]);
    const privateEvents = f.host.events(
      f.human,
      f.store.workspaceId,
      before,
      f.reviewId,
    );
    expect(privateEvents.map((event) => event.type)).toEqual([
      "draft.saved",
      "draft.saved",
    ]);
    expect(JSON.stringify(privateEvents)).not.toContain(other.body);
    const checkpoint = await f.publish();
    const submission = await f.command("feedback.submit", {
      reviewId: f.reviewId,
      checkpointId: checkpoint.id,
      decision: "comment",
      drafts: [{ draftId: edited.id, expectedVersion: edited.version }],
    });
    const publicThread = await f.query(
      "thread.get",
      { reviewId: f.reviewId, threadId: submission.threadIds[0]! },
      f.author,
    );
    expect(publicThread.messages.items.map((message) => message.body)).toEqual([
      edited.body,
    ]);
    expect(
      (await f.query("drafts.list", { reviewId: f.reviewId })).items,
    ).toEqual([]);
    expect(
      (await f.query("drafts.list", { reviewId: f.reviewId }, f.otherHuman))
        .items,
    ).toEqual([other]);
  });

  it("rolls back every selected draft and public side effect if any selected version is stale", async () => {
    const f = await fixture();
    const checkpoint = await f.publish();
    const first = await f.saveDraft("First question");
    const second = await f.saveDraft("Second question");
    const unselected = await f.saveDraft("Keep this private");
    const changed = await f.command("draft.save", {
      reviewId: f.reviewId,
      draftId: second.id,
      expectedVersion: second.version,
      target: f.target,
      body: "Revised second question",
    });
    const reviewBefore = await f.query("review.get", { reviewId: f.reviewId });
    const cursor = f.store.cursor();
    const commandId = randomUUID();
    const input: HostCommandInputs["feedback.submit"] = {
      reviewId: f.reviewId,
      checkpointId: checkpoint.id,
      decision: "request_changes",
      drafts: [
        { draftId: first.id, expectedVersion: first.version },
        { draftId: second.id, expectedVersion: second.version },
      ],
    };
    await expect(
      f.command("feedback.submit", input, f.human, commandId),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(
      (await f.query("threads.list", { reviewId: f.reviewId })).items,
    ).toEqual([]);
    expect(
      (await f.query("feedback.list", { reviewId: f.reviewId })).items,
    ).toEqual([]);
    expect(await f.query("review.get", { reviewId: f.reviewId })).toEqual(
      reviewBefore,
    );
    expect(
      (await f.query("drafts.list", { reviewId: f.reviewId })).items,
    ).toEqual(expect.arrayContaining([first, changed, unselected]));
    expect(f.store.cursor()).toBe(cursor);
    input.drafts[1]!.expectedVersion = changed.version;
    const submission = await f.command(
      "feedback.submit",
      input,
      f.human,
      commandId,
    );
    expect(
      await f.command("feedback.submit", input, f.human, commandId),
    ).toEqual(submission);
    expect(submission).toMatchObject({
      checkpointId: checkpoint.id,
      decision: "request_changes",
    });
    expect(submission.threadIds).toHaveLength(2);
    expect(
      (await f.query("drafts.list", { reviewId: f.reviewId })).items,
    ).toEqual([unselected]);
    expect(
      (await f.query("review.get", { reviewId: f.reviewId })).review.workflow,
    ).toBe("changes_requested");
    expect(
      (await f.query("feedback.list", { reviewId: f.reviewId })).items,
    ).toEqual([submission]);
  });

  it("appends concurrent immutable replies and deduplicates message identity independently of command receipts", async () => {
    const f = await fixture();
    const { thread, message: original } = await f.command("thread.create", {
      reviewId: f.reviewId,
      target: f.target,
      body: "Original question",
    });
    const input = {
      reviewId: f.reviewId,
      threadId: thread.id,
      messageId: randomUUID(),
      replyToMessageId: original.id,
      body: "First answer",
    };
    const [first, second] = await Promise.all([
      f.command("thread.reply", input, f.author),
      f.command(
        "thread.reply",
        { ...input, messageId: randomUUID(), body: "Additional answer" },
        f.author,
      ),
    ]);
    const beforeReplay = f.store.cursor();
    expect(await f.command("thread.reply", input, f.author)).toEqual(first);
    expect(f.store.cursor()).toBe(beforeReplay);
    await expect(
      f.command(
        "thread.reply",
        { ...input, body: "Rewritten answer" },
        f.author,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(
      f.command("thread.reply", input, f.otherHuman),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const result = await f.query("thread.get", {
      reviewId: f.reviewId,
      threadId: thread.id,
    });
    expect(result.messages.items).toEqual([original, first, second]);
    expect(result.messages.items.map((message) => message.ordinal)).toEqual([
      1, 2, 3,
    ]);
    const anotherReview = await f.create();
    await expect(
      f.command(
        "thread.reply",
        {
          ...input,
          reviewId: anotherReview.review.id,
          messageId: randomUUID(),
        },
        f.author,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("retains the exact original source target and quote while computing new mappings across repins", async () => {
    const f = await fixture();
    const checkpoint = await f.publish();
    const target: HostFeedbackTarget = {
      kind: "source",
      documentVersion: 1,
      range: { side: "head", file: "src/source.ts", fromLine: 3, toLine: 4 },
    };
    const created = await f.command("thread.create", {
      reviewId: f.reviewId,
      target,
      body: "Why these values?",
    });
    expect(created.thread.evidence).toMatchObject({
      span: { commit: f.commit, file: "src/source.ts", fromLine: 3, toLine: 4 },
      text: "export const value2 = 2;\nexport const value3 = 3;",
    });
    renameSync(
      path.join(f.repositoryPath, "src/source.ts"),
      path.join(f.repositoryPath, "src/renamed.ts"),
    );
    writeFileSync(
      path.join(f.repositoryPath, "src/renamed.ts"),
      "// New introduction\n" + f.source,
    );
    git(f.repositoryPath, "add", ".");
    git(f.repositoryPath, "commit", "-m", "Rename and prepend");
    const movedCommit = git(f.repositoryPath, "rev-parse", "HEAD");
    await f.repin(movedCommit, 1);
    const mapping = await f.query("thread.mapping", {
      reviewId: f.reviewId,
      threadId: created.thread.id,
      documentVersion: 2,
    });
    expect(mapping).toMatchObject({
      status: "relocated",
      target: {
        kind: "source",
        documentVersion: 2,
        range: { side: "head", file: "src/renamed.ts", fromLine: 4, toLine: 5 },
      },
      evidence: {
        span: { commit: movedCommit },
        text: created.thread.evidence!.text,
      },
    });
    expect(
      (
        await f.query("thread.get", {
          reviewId: f.reviewId,
          threadId: created.thread.id,
        })
      ).thread,
    ).toEqual(created.thread);
    const historical = await f.query("checkpoint.get", {
      reviewId: f.reviewId,
      checkpointId: checkpoint.id,
    });
    expect(historical.document.binding.headCommit).toBe(f.commit);
    expect(historical.document.version).toBe(1);
    writeFileSync(
      path.join(f.repositoryPath, "src/renamed.ts"),
      ("// New introduction\n" + f.source).replace(
        "value2 = 2",
        "value2 = 200",
      ),
    );
    git(f.repositoryPath, "add", ".");
    git(f.repositoryPath, "commit", "-m", "Change selected source");
    await f.repin(git(f.repositoryPath, "rev-parse", "HEAD"), 2);
    expect(
      await f.query("thread.mapping", {
        reviewId: f.reviewId,
        threadId: created.thread.id,
        documentVersion: 3,
      }),
    ).toEqual({
      threadId: created.thread.id,
      documentVersion: 3,
      status: "missing",
      target: null,
      evidence: null,
    });
    expect(
      (
        await f.query("thread.get", {
          reviewId: f.reviewId,
          threadId: created.thread.id,
        })
      ).messages.items,
    ).toEqual([created.message]);
    expect(
      await f.query("thread.mapping", {
        reviewId: f.reviewId,
        threadId: created.thread.id,
        documentVersion: 2,
      }),
    ).toEqual(mapping);
  });

  it("maps retained source comments offline only when their exact pinned source is unchanged", async () => {
    const f = await fixture();
    const target: HostFeedbackTarget = {
      kind: "source",
      documentVersion: 1,
      range: { side: "head", file: "src/source.ts", fromLine: 3, toLine: 4 },
    };
    const created = await f.command("thread.create", {
      reviewId: f.reviewId,
      target,
      body: "Explain this source selection.",
    });
    expect(f.store.document(f.reviewId).evidence).toEqual({});
    await f.command("document.mutate", {
      reviewId: f.reviewId,
      expectedDocumentVersion: 1,
      operations: [
        {
          op: "node.replace",
          node: { id: "intro", type: "markdown", markdown: "New explanation" },
        },
      ],
    });
    writeFileSync(path.join(f.repositoryPath, "unrelated.txt"), "New commit");
    git(f.repositoryPath, "add", ".");
    git(f.repositoryPath, "commit", "-m", "Change unrelated source");
    await f.repin(git(f.repositoryPath, "rev-parse", "HEAD"), 2);
    renameSync(f.repositoryPath, `${f.repositoryPath}-offline`);
    f.reopen();

    for (const documentVersion of [1, 2]) {
      expect(
        await f.query("thread.mapping", {
          reviewId: f.reviewId,
          threadId: created.thread.id,
          documentVersion,
        }),
      ).toEqual({
        threadId: created.thread.id,
        documentVersion,
        status: "exact",
        target: { ...target, documentVersion },
        evidence: created.thread.evidence,
      });
    }
    await expect(
      f.query("thread.mapping", {
        reviewId: f.reviewId,
        threadId: created.thread.id,
        documentVersion: 3,
      }),
    ).rejects.toMatchObject({ code: "DEPENDENCY_UNAVAILABLE" });
    expect(
      (
        await f.query("thread.get", {
          reviewId: f.reviewId,
          threadId: created.thread.id,
        })
      ).thread,
    ).toEqual(created.thread);
  });

  it("saves the question and frozen public context before execution and never launches a receipt retry twice", async () => {
    const launches: HostQuestionRun[] = [];
    const observed: { state: string; questionId: string; question: string }[] =
      [];
    const f = await fixture({
      questions: {
        capabilities: async () => ["codex"],
        start: async (run) => {
          launches.push(run);
          observed.push({
            state: f.store.questionRun(run.reviewId, run.id).state,
            questionId: f.store.messages(run.reviewId, run.threadId)[0]!.id,
            question: f.store.questionContext(run.reviewId, run.contextId)
              .question,
          });
        },
      },
    });
    await f.saveDraft("Secret private draft");
    const commandId = randomUUID();
    const started = await f.start("Why this explanation?", commandId);
    const context = await f.query("question.context", {
      reviewId: f.reviewId,
      runId: started.run.id,
    });
    expect(started.run.state).toBe("pending");
    expect(observed).toEqual([
      {
        state: "pending",
        questionId: started.message.id,
        question: "Why this explanation?",
      },
    ]);
    expect(context).toMatchObject({
      documentVersion: 1,
      question: "Why this explanation?",
    });
    expect(JSON.stringify(context)).toContain("Original explanation");
    expect(JSON.stringify(context)).not.toContain("Secret private draft");
    expect(JSON.stringify(context)).not.toContain("authorSession");
    await f.command(
      "document.mutate",
      {
        reviewId: f.reviewId,
        expectedDocumentVersion: 1,
        operations: [
          {
            op: "node.replace",
            node: {
              id: "intro",
              type: "markdown",
              markdown: "Changed after question",
            },
          },
        ],
      },
      f.author,
    );
    expect(
      await f.query("question.context", {
        reviewId: f.reviewId,
        runId: started.run.id,
      }),
    ).toEqual(context);
    expect(await f.start("Why this explanation?", commandId)).toEqual(started);
    expect(launches).toEqual([started.run]);
    expect(
      (await f.query("threads.list", { reviewId: f.reviewId })).items,
    ).toHaveLength(1);
  });

  it("launches only one session when identical question commands arrive concurrently", async () => {
    const launches: HostQuestionRun[] = [];
    const f = await fixture({
      questions: {
        capabilities: async () => ["codex"],
        start: async (run) => {
          launches.push(run);
        },
      },
    });
    const commandId = randomUUID();
    const [first, duplicate] = await Promise.all([
      f.start("Concurrent question", commandId),
      f.start("Concurrent question", commandId),
    ]);
    expect(duplicate).toEqual(first);
    expect(launches).toEqual([first.run]);
    expect(
      (await f.query("questions.list", { reviewId: f.reviewId })).items,
    ).toEqual([first.run]);
  });

  it("retains failed launch questions and permits an explicit retry of the same frozen question", async () => {
    const f = await fixture();
    const started = await f.start();
    const failed = await f.query("question.get", {
      reviewId: f.reviewId,
      runId: started.run.id,
    });
    expect(failed.state).toBe("failed");
    expect(failed.error).toContain("No local question executor");
    expect(
      (
        await f.query("thread.get", {
          reviewId: f.reviewId,
          threadId: started.thread.id,
        })
      ).messages.items,
    ).toEqual([started.message]);
    const launches: HostQuestionRun[] = [];
    f.reopen({
      questions: {
        capabilities: async () => ["codex"],
        start: async (run) => {
          launches.push(run);
        },
      },
    });
    const retried = await f.command("question.retry", {
      reviewId: f.reviewId,
      runId: failed.id,
    });
    expect(retried.id).not.toBe(failed.id);
    expect(retried).toMatchObject({
      state: "pending",
      questionId: failed.questionId,
      contextId: failed.contextId,
      threadId: failed.threadId,
    });
    expect(launches).toEqual([retried]);
    expect(
      await f.query("question.get", { reviewId: f.reviewId, runId: failed.id }),
    ).toEqual(failed);
    await expect(
      f.command("question.retry", { reviewId: f.reviewId, runId: failed.id }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  });

  it("restricts completions to the granted run and assistant, and saves exactly one immutable final answer", async () => {
    const f = await fixture({
      questions: { capabilities: async () => ["codex"], start: async () => {} },
    });
    const started = await f.start();
    const another = await f.start("A different question");
    const scoped = questionAccess(started.run);
    const input = {
      reviewId: f.reviewId,
      runId: started.run.id,
      outputId: randomUUID(),
      body: "The retained source explains it.",
    };
    await expect(
      f.command("question.complete", input, f.author),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      f.command(
        "question.complete",
        { ...input, runId: another.run.id },
        scoped,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      f.command("question.complete", input, {
        ...scoped,
        principal: f.author.principal,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      f.command(
        "document.mutate",
        {
          reviewId: f.reviewId,
          expectedDocumentVersion: 1,
          operations: [
            {
              op: "node.replace",
              node: {
                id: "intro",
                type: "markdown",
                markdown: "Unauthorized edit",
              },
            },
          ],
        },
        scoped,
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const completed = await f.command("question.complete", input, scoped);
    expect(completed.run).toMatchObject({
      state: "completed",
      answerMessageId: input.outputId,
    });
    expect(completed.message).toMatchObject({
      author: started.run.assistant,
      replyToMessageId: started.message.id,
      questionRunId: started.run.id,
      body: input.body,
    });
    const cursor = f.store.cursor();
    expect(await f.command("question.complete", input, scoped)).toEqual(
      completed,
    );
    expect(f.store.cursor()).toBe(cursor);
    await expect(
      f.command(
        "question.complete",
        { ...input, body: "Overwritten answer" },
        scoped,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(
      f.command(
        "question.complete",
        { ...input, outputId: randomUUID() },
        scoped,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    f.host.completeQuestion(started.run, "Duplicate native capture");
    f.host.failQuestion(started.run, "Late native disconnect");
    expect(
      (
        await f.query("thread.get", {
          reviewId: f.reviewId,
          threadId: started.thread.id,
        })
      ).messages.items,
    ).toEqual([started.message, completed.message]);
    expect(
      await f.query("question.get", {
        reviewId: f.reviewId,
        runId: started.run.id,
      }),
    ).toEqual(completed.run);
  });

  it("interrupts outstanding runs only at host startup and never automatically replays them after restart", async () => {
    const launches: HostQuestionRun[] = [];
    const f = await fixture({
      questions: {
        capabilities: async () => ["codex"],
        start: async (run) => {
          launches.push(run);
        },
      },
    });
    const pending = await f.start("Pending question");
    const running = await f.start("Running question");
    f.host.recordQuestionSession(running.run, "fresh-native-session");
    const done = await f.start("Completed question");
    f.host.completeQuestion(done.run, "Already saved answer");
    const completed = await f.query("question.get", {
      reviewId: f.reviewId,
      runId: done.run.id,
    });
    f.reopen();
    expect(
      (
        await f.query("question.get", {
          reviewId: f.reviewId,
          runId: running.run.id,
        })
      ).state,
    ).toBe("running");
    f.host.interruptQuestionRuns();
    expect(
      (
        await f.query("question.get", {
          reviewId: f.reviewId,
          runId: pending.run.id,
        })
      ).state,
    ).toBe("interrupted");
    const interrupted = await f.query("question.get", {
      reviewId: f.reviewId,
      runId: running.run.id,
    });
    expect(interrupted).toMatchObject({
      state: "interrupted",
      sessionId: "fresh-native-session",
    });
    expect(
      await f.query("question.get", {
        reviewId: f.reviewId,
        runId: done.run.id,
      }),
    ).toEqual(completed);
    expect(launches).toHaveLength(3);
    await expect(
      f.command(
        "question.complete",
        {
          reviewId: f.reviewId,
          runId: running.run.id,
          outputId: randomUUID(),
          body: "Late answer",
        },
        questionAccess(running.run),
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    const retry = await f.command("question.retry", {
      reviewId: f.reviewId,
      runId: running.run.id,
    });
    expect(retry).toMatchObject({
      state: "pending",
      contextId: running.run.contextId,
      questionId: running.run.questionId,
      sessionId: null,
    });
    expect(retry.id).not.toBe(running.run.id);
    expect(launches).toHaveLength(4);
    expect(
      await f.query("question.get", {
        reviewId: f.reviewId,
        runId: running.run.id,
      }),
    ).toEqual(interrupted);
    expect(
      (
        await f.query("thread.get", {
          reviewId: f.reviewId,
          threadId: running.thread.id,
        })
      ).messages.items,
    ).toEqual([running.message]);
  });

  it("freezes follow-up context from original evidence and public conversation, not the changed document or private drafts", async () => {
    const f = await fixture({
      questions: { capabilities: async () => ["codex"], start: async () => {} },
    });
    const started = await f.start("First public question");
    f.host.completeQuestion(started.run, "First public answer");
    await f.saveDraft("Private note that must not reach Ask");
    await f.command(
      "document.mutate",
      {
        reviewId: f.reviewId,
        expectedDocumentVersion: 1,
        operations: [
          {
            op: "node.replace",
            node: {
              id: "intro",
              type: "markdown",
              markdown: "Later unrelated explanation",
            },
          },
        ],
      },
      f.author,
    );
    const followUp = await f.command("question.follow_up", {
      reviewId: f.reviewId,
      threadId: started.thread.id,
      body: "Can you clarify that answer?",
      harness: "codex",
    });
    const context = await f.query("question.context", {
      reviewId: f.reviewId,
      runId: followUp.run.id,
    });
    expect(context).toMatchObject({
      documentVersion: 1,
      question: followUp.message.body,
    });
    const serialized = JSON.stringify(context.material);
    expect(serialized).toContain("Original explanation");
    expect(serialized).toContain("First public question");
    expect(serialized).toContain("First public answer");
    expect(serialized).not.toContain("Private note that must not reach Ask");
    expect(serialized).not.toContain("Later unrelated explanation");
    expect(followUp.thread).toMatchObject({
      id: started.thread.id,
      target: started.thread.target,
    });
    expect(
      (
        await f.query("thread.get", {
          reviewId: f.reviewId,
          threadId: started.thread.id,
        })
      ).messages.items.map((message) => message.body),
    ).toEqual([
      started.message.body,
      "First public answer",
      followUp.message.body,
    ]);
  });

  it("accepts an already-authorized answer after closure or trash without permitting new conversations", async () => {
    const f = await fixture({
      questions: { capabilities: async () => ["codex"], start: async () => {} },
    });
    const beforeClosure = await f.start("Question before closing");
    const beforeTrash = await f.start("Question before trashing");
    const closed = await f.command("review.close", {
      reviewId: f.reviewId,
      expectedVersion: 0,
    });
    const completed = await f.command(
      "question.complete",
      {
        reviewId: f.reviewId,
        runId: beforeClosure.run.id,
        outputId: randomUUID(),
        body: "Answer delivered after close",
      },
      questionAccess(beforeClosure.run),
    );
    expect(completed.run.state).toBe("completed");
    await expect(f.start("New question after close")).rejects.toMatchObject({
      code: "INVALID_STATE",
    });
    await f.command("review.trash", {
      reviewId: f.reviewId,
      expectedVersion: closed.version,
    });
    f.host.completeQuestion(beforeTrash.run, "Answer delivered after trash");
    expect(
      (
        await f.query("question.get", {
          reviewId: f.reviewId,
          runId: beforeTrash.run.id,
        })
      ).state,
    ).toBe("completed");
    expect(
      (
        await f.query("thread.get", {
          reviewId: f.reviewId,
          threadId: beforeTrash.thread.id,
        })
      ).messages.items.map((message) => message.body),
    ).toEqual([beforeTrash.message.body, "Answer delivered after trash"]);
    await expect(
      f.command(
        "thread.reply",
        {
          reviewId: f.reviewId,
          threadId: beforeTrash.thread.id,
          messageId: randomUUID(),
          body: "New unscoped reply",
        },
        f.author,
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("uses retained quote subsets for new source comments even when the repository is unavailable", async () => {
    const f = await fixture();
    await f.command(
      "document.mutate",
      {
        reviewId: f.reviewId,
        expectedDocumentVersion: 1,
        operations: [
          {
            op: "definition.put",
            id: "source",
            value: {
              kind: "anchor",
              title: "Original source",
              source: {
                side: "head",
                file: "src/source.ts",
                fromLine: 1,
                toLine: 8,
              },
            },
          },
          {
            op: "node.insert",
            node: { id: "peek", type: "code_peek", anchorId: "source" },
            placement: { parentId: null, afterId: "intro" },
          },
        ],
      },
      f.author,
    );
    renameSync(f.repositoryPath, f.repositoryPath + "-offline");
    const target: HostFeedbackTarget = {
      kind: "source",
      documentVersion: 2,
      range: { side: "head", file: "src/source.ts", fromLine: 3, toLine: 4 },
    };
    const created = await f.command("thread.create", {
      reviewId: f.reviewId,
      target,
      body: "Question from the retained canvas",
    });
    expect(created.thread.evidence).toMatchObject({
      span: { commit: f.commit, fromLine: 3, toLine: 4 },
      text: "export const value2 = 2;\nexport const value3 = 3;",
    });
    expect(
      (
        await f.query(
          "thread.get",
          { reviewId: f.reviewId, threadId: created.thread.id },
          f.author,
        )
      ).thread,
    ).toEqual(created.thread);
  });
});
