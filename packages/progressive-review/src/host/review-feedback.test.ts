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
    "human",
    "register_repository",
  ]);
  const otherHuman = access("human", ["read", "author", "human"]);
  const author = access("agent", ["read", "author"]);
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
      expectedReviewVersion: 0,
      operations: [
        {
          op: "node.insert",
          node: {
            id: "intro",
            type: "markdown",
            markdown: "Original explanation",
          },
          placement: { parentId: null, position: { kind: "start" } },
        },
      ],
    },
    author,
  );
  const target: HostFeedbackTarget = {
    kind: "node",
    reviewVersion: 1,
    nodeId: "intro",
  };
  const saveDraft = (
    body: string,
    draftId: string = randomUUID(),
    principal: HostAccess = human,
  ) =>
    command(
      "draft.save",
      { reviewId, draftId, expectedDraftVersion: null, target, body },
      principal,
    );
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
  const revise = (head: string, reviewVersion: number) =>
    command(
      "review.revision.create",
      {
        reviewId,
        expectedReviewVersion: reviewVersion,
        change: { kind: "snapshot", ref: head },
      },
      author,
    );
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
    start,
    revise,
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
  it("submits the maximum draft batch plus summary against a saved historical version without publishing", async () => {
    const f = await fixture();
    const drafts = await Promise.all(
      Array.from({ length: 200 }, (_, index) =>
        f.saveDraft(`Finding ${index}`),
      ),
    );
    const before = f.store.review(f.reviewId);
    const commandId = randomUUID();
    const input = {
      reviewId: f.reviewId,
      reviewVersion: 0,
      decision: "request_changes" as const,
      drafts: drafts.map((draft) => ({
        draftId: draft.id,
        expectedDraftVersion: draft.draftVersion,
      })),
      body: "Overall summary",
    };
    const submission = await f.command(
      "feedback.submit",
      input,
      f.human,
      commandId,
    );
    expect(submission.reviewVersion).toBe(0);
    expect(submission.messageIds).toHaveLength(201);
    expect(submission.threadIds).toHaveLength(201);
    expect(f.store.review(f.reviewId)).toEqual(before);
    expect(f.store.drafts(f.reviewId, f.human.principal.id)).toEqual([]);
    expect(
      await f.command("feedback.submit", input, f.human, commandId),
    ).toEqual(submission);
    expect(f.store.threads(f.reviewId)).toHaveLength(201);
  });

  it("retains one bounded source excerpt rather than duplicating a large quote in Ask mappings", async () => {
    const quote = "long source text ".repeat(8000);
    const f = await fixture({
      evidence: {
        resolve: async (binding, range) => ({
          span: {
            repositoryId: binding.repositoryId,
            commit: binding.headCommit,
            blob: "f".repeat(40),
            file: range.file,
            fromLine: range.fromLine,
            toLine: range.toLine,
          },
          text: quote,
          sha256: "a".repeat(64),
        }),
      },
    });
    const started = await f.command("question.start", {
      reviewId: f.reviewId,
      target: {
        kind: "source",
        reviewVersion: 1,
        range: { side: "head", file: "src/source.ts", fromLine: 1, toLine: 1 },
      },
      body: "What does this source do?",
      harness: "codex",
    });
    const context = f.store.questionContext(f.reviewId, started.run.contextId);
    expect(context.material.sourceEvidence?.text).toMatchObject({
      state: "truncated",
    });
    expect(context.material.viewedTarget).not.toHaveProperty("evidence");
    expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThan(56 * 1024);
    expect(started.thread.evidence?.text).toBe(quote);
  });

  it("selects only the configured or sole available Ask harness when omitted", async () => {
    let available: HostQuestionRun["harness"][] = ["pi"];
    let configured: HostQuestionRun["harness"] | undefined;
    const f = await fixture({
      questions: {
        capabilities: async () => available,
        defaultHarness: () => configured,
        start: async () => {},
      },
    });
    const ask = () =>
      f.command("question.start", {
        reviewId: f.reviewId,
        target: f.target,
        body: "Why?",
      });
    expect((await ask()).run.harness).toBe("pi");
    available = ["codex", "claude-code"];
    await expect(ask()).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(f.store.threads(f.reviewId)).toHaveLength(1);
    configured = "claude-code";
    expect((await ask()).run.harness).toBe("claude-code");
    expect(
      (
        await f.command("question.start", {
          reviewId: f.reviewId,
          target: f.target,
          body: "Explicit choice",
          harness: "codex",
        })
      ).run.harness,
    ).toBe("codex");
  });

  it("records the version most recently viewed, including revisits and historical snapshots", async () => {
    const f = await fixture();
    expect(
      await f.query("attention.get", { reviewId: f.reviewId }),
    ).toMatchObject({
      attentionVersion: 0,
      lastViewedReviewVersion: null,
      lastViewedAt: null,
    });
    await f.command("attention.update", {
      reviewId: f.reviewId,
      expectedAttentionVersion: 0,
      lastViewedReviewVersion: 1,
    });
    const historical = await f.command("attention.update", {
      reviewId: f.reviewId,
      expectedAttentionVersion: 1,
      lastViewedReviewVersion: 0,
    });
    expect(historical).toMatchObject({
      attentionVersion: 2,
      lastViewedReviewVersion: 0,
    });
    expect(
      await f.command("attention.update", {
        reviewId: f.reviewId,
        expectedAttentionVersion: 2,
        pinned: false,
      }),
    ).toEqual(historical);
    const revisited = await f.command("attention.update", {
      reviewId: f.reviewId,
      expectedAttentionVersion: 2,
      lastViewedReviewVersion: 0,
    });
    expect(revisited.attentionVersion).toBe(3);
    await expect(
      f.command("attention.update", {
        reviewId: f.reviewId,
        expectedAttentionVersion: 2,
        pinned: true,
      }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(f.store.review(f.reviewId)).toMatchObject({
      latestReviewVersion: 1,
      stateVersion: 0,
    });
  });

  it("keeps page boundaries fixed while newly saved drafts arrive and rejects foreign cursors", async () => {
    const f = await fixture();
    const drafts = await Promise.all([
      f.saveDraft("First"),
      f.saveDraft("Second"),
      f.saveDraft("Third"),
    ]);
    const first = await f.query("drafts.list", {
      reviewId: f.reviewId,
      limit: 1,
    });
    const newer = await f.saveDraft("After the first page");
    const rest = await f.query("drafts.list", {
      reviewId: f.reviewId,
      cursor: first.nextCursor!,
      limit: 200,
    });
    expect(
      [...first.items, ...rest.items].map((draft) => draft.id).sort(),
    ).toEqual(drafts.map((draft) => draft.id).sort());
    expect(rest.items.some((draft) => draft.id === newer.id)).toBe(false);
    await expect(
      f.query(
        "drafts.list",
        { reviewId: f.reviewId, cursor: first.nextCursor! },
        f.otherHuman,
      ),
    ).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
    await f.command("draft.delete", {
      reviewId: f.reviewId,
      draftId: first.items[0]!.id,
      expectedDraftVersion: 0,
    });
    await expect(
      f.query("drafts.list", {
        reviewId: f.reviewId,
        cursor: first.nextCursor!,
      }),
    ).rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
  });

  it("freezes bounded current context for a follow-up when its original node is gone", async () => {
    const f = await fixture();
    const original = await f.start();
    const originalContext = f.store.questionContext(
      f.reviewId,
      original.run.contextId,
    );
    for (let index = 0; index < 10; index++)
      await f.command("thread.reply", {
        reviewId: f.reviewId,
        threadId: original.thread.id,
        body: `${index}: ${"answer ".repeat(300)}`,
      });
    await f.saveDraft("Private context must stay private");
    await f.command("document.mutate", {
      reviewId: f.reviewId,
      expectedReviewVersion: 1,
      operations: [
        { op: "node.remove", nodeId: "intro" },
        {
          op: "node.insert",
          node: {
            id: "new",
            type: "markdown",
            markdown: "Current explanation ".repeat(1000),
          },
          placement: { parentId: null, position: { kind: "start" } },
        },
      ],
    });
    const followUp = await f.command("question.follow_up", {
      reviewId: f.reviewId,
      threadId: original.thread.id,
      reviewVersion: 2,
      body: "How about this version?",
      harness: "codex",
    });
    const context = f.store.questionContext(f.reviewId, followUp.run.contextId);
    expect(context).toMatchObject({
      reviewVersion: 2,
      material: {
        originalTarget: f.target,
        viewedTarget: {
          reviewVersion: 2,
          status: "missing",
          reason: "target_removed",
          target: null,
        },
        sourceEvidence: null,
        documentJson: { state: "truncated" },
        priorMessagesOmitted: 3,
      },
    });
    expect(context.material.priorMessages).toHaveLength(8);
    expect(
      context.material.priorMessages.every(
        (message) =>
          message.body.state === "truncated" &&
          Buffer.byteLength(message.body.text) <= 1000,
      ),
    ).toBe(true);
    expect(JSON.stringify(context)).not.toContain("Private context");
    expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThanOrEqual(
      56 * 1024,
    );
    expect(f.store.questionContext(f.reviewId, original.run.contextId)).toEqual(
      originalContext,
    );
    const historical = await f.command("question.follow_up", {
      reviewId: f.reviewId,
      threadId: original.thread.id,
      reviewVersion: 1,
      body: "Back to the old view",
      harness: "codex",
    });
    expect(
      f.store.questionContext(f.reviewId, historical.run.contextId),
    ).toMatchObject({
      reviewVersion: 1,
      material: { viewedTarget: { status: "exact" } },
    });
    const before = f.store.threads(f.reviewId).length;
    await expect(
      f.command("question.start", {
        reviewId: f.reviewId,
        target: { kind: "document", reviewVersion: 2 },
        body: "\u0001".repeat(20_000),
        harness: "codex",
      }),
    ).rejects.toMatchObject({ code: "RESOURCE_LIMIT" });
    expect(f.store.threads(f.reviewId)).toHaveLength(before);
  });

  it("distinguishes sequence actor/message, frame sides, and use-case-scoped operation targets", async () => {
    const f = await fixture();
    const definition = (side: "base" | "head", line: number) => ({
      kind: "anchor" as const,
      title: "Source",
      source: { side, file: "src/source.ts", fromLine: line, toLine: line },
    });
    await f.command("document.mutate", {
      reviewId: f.reviewId,
      expectedReviewVersion: 1,
      operations: [
        {
          op: "definition.put",
          id: "same",
          value: { kind: "actor", label: "Client" },
        },
        {
          op: "definition.put",
          id: "server",
          value: { kind: "actor", label: "Server" },
        },
        { op: "definition.put", id: "base", value: definition("base", 1) },
        { op: "definition.put", id: "head", value: definition("head", 2) },
        {
          op: "definition.put",
          id: "store",
          value: {
            kind: "store",
            label: "DB",
            storage: "relational",
            collections: { rows: { label: "Rows", fields: {} } },
          },
        },
        {
          op: "node.insert",
          node: {
            id: "seq",
            type: "sequence",
            title: "Sequence",
            messages: [
              {
                id: "same",
                fromActorId: "same",
                toActorId: "server",
                label: "Request",
                evidence: { kind: "anchor", anchorId: "head" },
              },
            ],
          },
          placement: { parentId: null, position: { kind: "end" } },
        },
        {
          op: "node.insert",
          node: {
            id: "stack",
            type: "call_stack_diff",
            title: "Stack",
            base: [{ id: "frame", anchorId: "base" }],
            head: [{ id: "frame", anchorId: "head" }],
          },
          placement: { parentId: null, position: { kind: "end" } },
        },
        {
          op: "node.insert",
          node: {
            id: "db",
            type: "database_lens",
            title: "DB",
            storeIds: ["store"],
            useCases: ["one", "two"].map((id, index) => ({
              id,
              label: id,
              operations: [
                {
                  id: "operation",
                  kind: "read" as const,
                  store: { storeId: "store", collectionId: "rows" },
                  actorId: "server",
                  label: "Read",
                  anchorId: index ? "head" : "base",
                },
              ],
            })),
          },
          placement: { parentId: null, position: { kind: "end" } },
        },
      ],
    });
    const post = (
      nodeId: string,
      item: Extract<HostFeedbackTarget, { kind: "diagram" }>["item"],
    ) =>
      f.command("thread.create", {
        reviewId: f.reviewId,
        target: { kind: "diagram", reviewVersion: 2, nodeId, item },
        body: "Question",
      });
    expect(
      (await post("seq", { kind: "actor", actorId: "same" })).thread.evidence,
    ).toBeNull();
    expect(
      (await post("seq", { kind: "message", messageId: "same" })).thread
        .evidence?.span.fromLine,
    ).toBe(2);
    expect(
      (await post("stack", { kind: "frame", side: "base", frameId: "frame" }))
        .thread.evidence?.span.fromLine,
    ).toBe(1);
    expect(
      (await post("stack", { kind: "frame", side: "head", frameId: "frame" }))
        .thread.evidence?.span.fromLine,
    ).toBe(2);
    expect(
      (
        await post("db", {
          kind: "operation",
          useCaseId: "one",
          operationId: "operation",
        })
      ).thread.evidence?.span.fromLine,
    ).toBe(1);
    expect(
      (
        await post("db", {
          kind: "operation",
          useCaseId: "two",
          operationId: "operation",
        })
      ).thread.evidence?.span.fromLine,
    ).toBe(2);
    await expect(
      post("db", {
        kind: "operation",
        useCaseId: "missing",
        operationId: "operation",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      post("seq", { kind: "frame", side: "base", frameId: "same" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("retains selected document text and does not claim edited content is an exact mapping", async () => {
    const f = await fixture();
    const target: HostFeedbackTarget = {
      ...f.target,
      selection: { quote: "Original", suffix: " explanation" },
    };
    const { thread } = await f.command("thread.create", {
      reviewId: f.reviewId,
      target,
      body: "Explain this selected phrase.",
    });
    expect(
      (
        await f.query("thread.mapping", {
          reviewId: f.reviewId,
          threadId: thread.id,
          reviewVersion: 1,
        })
      ).status,
    ).toBe("exact");
    await f.command("document.mutate", {
      reviewId: f.reviewId,
      expectedReviewVersion: 1,
      operations: [
        {
          op: "node.replace",
          node: {
            id: "intro",
            type: "markdown",
            markdown: "A different explanation",
          },
        },
      ],
    });
    expect(
      await f.query("thread.mapping", {
        reviewId: f.reviewId,
        threadId: thread.id,
        reviewVersion: 2,
      }),
    ).toMatchObject({ status: "missing", target: null });
    f.reopen();
    expect(
      (
        await f.query("thread.get", {
          reviewId: f.reviewId,
          threadId: thread.id,
        })
      ).thread.target,
    ).toEqual(target);
  });

  it("retains an original commit-view comment without attaching it to an unavailable comparison", async () => {
    const f = await fixture();
    writeFileSync(
      path.join(f.repositoryPath, "src/source.ts"),
      `// inserted\n${f.source}`,
    );
    git(f.repositoryPath, "add", ".");
    git(f.repositoryPath, "commit", "-m", "Insert a source line");
    const selectedCommit = git(f.repositoryPath, "rev-parse", "HEAD");
    await f.command("review.revision.create", {
      reviewId: f.reviewId,
      expectedReviewVersion: 1,
      change: { kind: "range", baseRef: f.commit, headRef: selectedCommit },
    });
    const target: HostFeedbackTarget = {
      kind: "source",
      reviewVersion: 2,
      comparisonCommit: selectedCommit,
      range: { side: "base", file: "src/source.ts", fromLine: 3, toLine: 4 },
    };
    const { thread } = await f.command("thread.create", {
      reviewId: f.reviewId,
      target,
      body: "These old lines changed here.",
    });
    expect(thread.evidence?.span.commit).toBe(f.commit);
    expect(thread.evidence?.text).toBe(
      "export const value2 = 2;\nexport const value3 = 3;",
    );
    await f.revise(selectedCommit, 2);
    renameSync(f.repositoryPath, `${f.repositoryPath}-offline`);
    f.reopen();
    expect(
      await f.query("thread.mapping", {
        reviewId: f.reviewId,
        threadId: thread.id,
        reviewVersion: 3,
      }),
    ).toMatchObject({ status: "missing", reason: "comparison_not_available" });
    expect(
      (
        await f.query("thread.get", {
          reviewId: f.reviewId,
          threadId: thread.id,
        })
      ).thread,
    ).toMatchObject({ target, evidence: thread.evidence });
  });

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
      expectedDraftVersion: draft.draftVersion,
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
          expectedDraftVersion: edited.draftVersion,
        },
        f.otherHuman,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      f.command("draft.save", {
        reviewId: f.reviewId,
        draftId: draft.id,
        expectedDraftVersion: draft.draftVersion,
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
    const reviewedVersion = 1;
    const submission = await f.command("feedback.submit", {
      reviewId: f.reviewId,
      reviewVersion: reviewedVersion,
      decision: "comment",
      drafts: [
        { draftId: edited.id, expectedDraftVersion: edited.draftVersion },
      ],
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
    const reviewedVersion = 1;
    const first = await f.saveDraft("First question");
    const second = await f.saveDraft("Second question");
    const unselected = await f.saveDraft("Keep this private");
    const changed = await f.command("draft.save", {
      reviewId: f.reviewId,
      draftId: second.id,
      expectedDraftVersion: second.draftVersion,
      target: f.target,
      body: "Revised second question",
    });
    const reviewBefore = await f.query("review.get", { reviewId: f.reviewId });
    const cursor = f.store.cursor();
    const commandId = randomUUID();
    const input: HostCommandInputs["feedback.submit"] = {
      reviewId: f.reviewId,
      reviewVersion: reviewedVersion,
      decision: "request_changes",
      drafts: [
        { draftId: first.id, expectedDraftVersion: first.draftVersion },
        { draftId: second.id, expectedDraftVersion: second.draftVersion },
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
    input.drafts[1]!.expectedDraftVersion = changed.draftVersion;
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
      reviewVersion: reviewedVersion,
      decision: "request_changes",
    });
    expect(submission.threadIds).toHaveLength(2);
    expect(
      (await f.query("drafts.list", { reviewId: f.reviewId })).items,
    ).toEqual([unselected]);
    expect(await f.query("review.get", { reviewId: f.reviewId })).toEqual(
      reviewBefore,
    );
    expect(
      (await f.query("feedback.list", { reviewId: f.reviewId })).items,
    ).toEqual([submission]);
  });

  it("assigns reply IDs on the server and retries identical commands without duplicate messages", async () => {
    const f = await fixture();
    const { thread, message: original } = await f.command("thread.create", {
      reviewId: f.reviewId,
      target: f.target,
      body: "Original question",
    });
    const input = {
      reviewId: f.reviewId,
      threadId: thread.id,
      replyToMessageId: original.id,
      body: "First answer",
    };
    const commandId = randomUUID();
    const [first, second] = await Promise.all([
      f.command("thread.reply", input, f.author, commandId),
      f.command(
        "thread.reply",
        { ...input, body: "Additional answer" },
        f.author,
      ),
    ]);
    const beforeReplay = f.store.cursor();
    expect(await f.command("thread.reply", input, f.author, commandId)).toEqual(
      first,
    );
    expect(first.id).not.toBe(second.id);
    expect(f.store.cursor()).toBe(beforeReplay);
    await expect(
      f.command(
        "thread.reply",
        { ...input, body: "Rewritten answer" },
        f.author,
        commandId,
      ),
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
        },
        f.author,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("retains the exact original source target and quote while computing new mappings across repins", async () => {
    const f = await fixture();
    const reviewedVersion = 1;
    const target: HostFeedbackTarget = {
      kind: "source",
      reviewVersion: 1,
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
    await f.revise(movedCommit, 1);
    const mapping = await f.query("thread.mapping", {
      reviewId: f.reviewId,
      threadId: created.thread.id,
      reviewVersion: 2,
    });
    expect(mapping).toMatchObject({
      status: "relocated",
      target: {
        kind: "source",
        reviewVersion: 2,
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
    const historical = await f.query("document.get", {
      reviewId: f.reviewId,
      reviewVersion: reviewedVersion,
    });
    expect(historical.binding.headCommit).toBe(f.commit);
    expect(historical.reviewVersion).toBe(1);
    writeFileSync(
      path.join(f.repositoryPath, "src/renamed.ts"),
      ("// New introduction\n" + f.source).replace(
        "value2 = 2",
        "value2 = 200",
      ),
    );
    git(f.repositoryPath, "add", ".");
    git(f.repositoryPath, "commit", "-m", "Change selected source");
    await f.revise(git(f.repositoryPath, "rev-parse", "HEAD"), 2);
    expect(
      await f.query("thread.mapping", {
        reviewId: f.reviewId,
        threadId: created.thread.id,
        reviewVersion: 3,
      }),
    ).toEqual({
      threadId: created.thread.id,
      reviewVersion: 3,
      status: "missing",
      target: null,
      evidence: null,
      reason: "selection_changed",
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
        reviewVersion: 2,
      }),
    ).toEqual(mapping);
  });

  it("maps retained source comments offline only when their exact pinned source is unchanged", async () => {
    const f = await fixture();
    const target: HostFeedbackTarget = {
      kind: "source",
      reviewVersion: 1,
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
      expectedReviewVersion: 1,
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
    await f.revise(git(f.repositoryPath, "rev-parse", "HEAD"), 2);
    renameSync(f.repositoryPath, `${f.repositoryPath}-offline`);
    f.reopen();

    for (const reviewVersion of [1, 2]) {
      expect(
        await f.query("thread.mapping", {
          reviewId: f.reviewId,
          threadId: created.thread.id,
          reviewVersion,
        }),
      ).toEqual({
        threadId: created.thread.id,
        reviewVersion,
        status: "exact",
        target: { ...target, reviewVersion },
        evidence: created.thread.evidence,
      });
    }
    expect(
      await f.query("thread.mapping", {
        reviewId: f.reviewId,
        threadId: created.thread.id,
        reviewVersion: 3,
      }),
    ).toMatchObject({ status: "missing", reason: "source_unavailable" });
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
      reviewVersion: 1,
      question: "Why this explanation?",
    });
    expect(JSON.stringify(context)).toContain("Original explanation");
    expect(JSON.stringify(context)).not.toContain("Secret private draft");
    expect(JSON.stringify(context)).not.toContain("authorSession");
    await f.command(
      "document.mutate",
      {
        reviewId: f.reviewId,
        expectedReviewVersion: 1,
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
          expectedReviewVersion: 1,
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
      answerMessageId: completed.message.id,
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

  it("freezes follow-up context from the explicitly viewed version while preserving the original conversation", async () => {
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
        expectedReviewVersion: 1,
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
      reviewVersion: 2,
      body: "Can you clarify that answer?",
      harness: "codex",
    });
    const context = await f.query("question.context", {
      reviewId: f.reviewId,
      runId: followUp.run.id,
    });
    expect(context).toMatchObject({
      reviewVersion: 2,
      question: followUp.message.body,
    });
    const serialized = JSON.stringify(context.material);
    expect(context.material.originalTarget.reviewVersion).toBe(1);
    expect(context.material.viewedTarget.target?.reviewVersion).toBe(2);
    expect(serialized).toContain("First public question");
    expect(serialized).toContain("First public answer");
    expect(serialized).not.toContain("Private note that must not reach Ask");
    expect(serialized).toContain("Later unrelated explanation");
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
      expectedStateVersion: 0,
    });
    const completed = await f.command(
      "question.complete",
      {
        reviewId: f.reviewId,
        runId: beforeClosure.run.id,
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
      expectedStateVersion: closed.stateVersion,
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
        expectedReviewVersion: 1,
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
            placement: {
              parentId: null,
              position: { kind: "after", nodeId: "intro" },
            },
          },
        ],
      },
      f.author,
    );
    renameSync(f.repositoryPath, f.repositoryPath + "-offline");
    const target: HostFeedbackTarget = {
      kind: "source",
      reviewVersion: 2,
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
