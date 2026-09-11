// @vitest-environment jsdom
import {
  type CreateReviewCommentInput,
  HOST_CAPABILITY_LIMITS,
  type HostCommand,
  HostCommandSchema,
  type HostDocumentState,
  type HostDraft,
  type HostFeedbackSubmission,
  type HostMessage,
  type HostQuery,
  HostQuerySchema,
  type HostQuestionRun,
  type HostReviewVersionHeader,
  type HostThread,
  type JsonValue,
  ReviewClient,
  type ReviewHostSourceTarget,
  type ReviewSurfaceEvent,
} from "@dev.fast/review-protocol";
import { afterEach, describe, expect, it } from "vitest";

import { buildBlockTarget, buildCodeTarget } from "../target-fingerprint";
import {
  type HostCommentStore,
  createHostCommentStore,
  projectHostFeedbackTarget,
  toHostFeedbackTarget,
} from "./host-comment-store";
import {
  type HostCanvasContent,
  type HostReviewViewState,
  createHostReviewSession,
  refreshHostReviewSession,
} from "./host-review-session";

const id = "27768987-4d4d-4c6f-885c-4bf783f44c27";
const at = "2026-09-10T12:00:00Z";
const author = { id, kind: "human" as const, displayName: "Reader" };
const originalDocument: HostDocumentState = {
  schemaVersion: 1,
  reviewId: id,
  reviewVersion: 3,
  roots: ["intro"],
  nodes: { intro: { id: "intro", type: "markdown", markdown: "Hello world" } },
  definitions: {},
  evidence: {},
  contentHash: "a".repeat(64),
  createdAt: at,
  binding: {
    id,
    repositoryId: id,
    selector: { kind: "snapshot", ref: "main" },
    baseCommit: "b".repeat(40),
    headCommit: "c".repeat(40),
    createdAt: at,
  },
};
const snapshot: HostReviewVersionHeader = {
  reviewId: id,
  reviewVersion: 3,
  binding: originalDocument.binding,
  title: "Review",
  description: "",
  mapVersions: { base: null, head: null },
  labels: [],
  createdBy: id,
  createdAt: at,
  restoredFromReviewVersion: null,
};
const stores: HostCommentStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  document.body.replaceChildren();
});

function viewState(): HostReviewViewState {
  return {
    document: originalDocument,
    snapshot,
    history: [{ ...snapshot, reason: "document" }],
    selectedReviewVersion: null,
    review: {
      id,
      repositoryId: id,
      stateVersion: 0,
      state: "open",
      latestReviewVersion: originalDocument.reviewVersion,
      createdBy: id,
      createdAt: at,
      deletedAt: null,
    },
  };
}

describe("the original review session API adapter", () => {
  it("keeps an in-flight pinned source comment through a live metadata refresh", async () => {
    const f = await fixture();
    const state = viewState();
    const release = f.holdSourceRead();
    let requested: ((target: ReviewHostSourceTarget) => void) | undefined;
    let nativeSubscriptions = 0;
    let nativeDisposals = 0;
    const core = createHostReviewSession({
      client: f.client,
      comments: f.store,
      getState: () => state,
      openRevision() {},
      appSessionId: "stable-review-session",
      content: {
        kind: "host",
        connection: { serverUrl: "http://127.0.0.1:5570", token: "test" },
        openReview() {},
        showHome() {},
        source: {
          async open() {},
          createPeek() {
            throw new Error("Unused editor");
          },
          onDidRequestComment(listener) {
            ++nativeSubscriptions;
            requested = listener;
            return {
              dispose() {
                ++nativeDisposals;
              },
            };
          },
        },
      },
    });
    const oldView = refreshHostReviewSession(core);
    const oldEvents: ReviewSurfaceEvent[] = [];
    const unsubscribeOld = oldView.surface.subscribe((event) =>
      oldEvents.push(event),
    );
    requested?.({
      reviewId: id,
      reviewVersion: 3,
      range: { side: "head", file: "src/source.ts", fromLine: 2, toLine: 4 },
    });
    await expect
      .poll(() => f.calls.some((call) => call.type === "source.read"))
      .toBe(true);
    unsubscribeOld();
    state.document = {
      ...originalDocument,
      reviewVersion: 4,
      createdAt: "2026-09-11T12:00:00Z",
    };
    const nextView = refreshHostReviewSession(core);
    const newEvents: ReviewSurfaceEvent[] = [];
    const unsubscribeNext = nextView.surface.subscribe((event) =>
      newEvents.push(event),
    );
    release();
    await expect.poll(() => newEvents.length).toBe(1);
    expect(oldEvents).toEqual([]);
    expect(newEvents[0]).toMatchObject({
      event: "commentRequested",
      target: { documentVersion: 3 },
    });
    expect(nextView.appSessionId).toBe(oldView.appSessionId);
    expect(nextView.fetch).not.toBe(oldView.fetch);
    expect(await (await nextView.fetch("/document-meta")).json()).toMatchObject(
      { updatedAtMs: Date.parse(state.document.createdAt) },
    );
    expect(nativeSubscriptions).toBe(1);
    expect(nativeDisposals).toBe(0);
    unsubscribeNext();
    core.dispose();
    expect(nativeDisposals).toBe(1);
  });

  it("reveals the saved question run for a UI thread ID and never dispatches legacy resume commands", async () => {
    const f = await fixture();
    const question = input("Why?");
    await f.store.askAgent(question);
    const opened: string[] = [];
    const session = createHostReviewSession({
      client: f.client,
      comments: f.store,
      getState: viewState,
      openRevision() {},
      content: {
        kind: "host",
        connection: { serverUrl: "http://127.0.0.1:5570", token: "test" },
        openReview() {},
        showHome() {},
        async openQuestion(runId) {
          opened.push(runId);
        },
        post() {
          throw new Error("Must not dispatch a legacy terminal action.");
        },
      },
    });
    await session.surface.post({
      name: "resumeAgentTerminal",
      args: { threadId: question.threadId },
    });
    expect(opened).toEqual([f.runs[0]!.id]);
  });
  it("submits only the selected drafts plus an unsaved global summary and preserves replay", async () => {
    const f = await fixture();
    const selected = input("Selected draft");
    const unselected = input("Later draft");
    const summary = input("Global summary");
    await f.store.saveComment(selected);
    await f.store.saveComment(unselected);
    const state = viewState();
    const session = createHostReviewSession({
      client: f.client,
      comments: f.store,
      getState: () => state,
      openRevision() {},
      content: {
        kind: "host",
        connection: { serverUrl: "http://127.0.0.1:5570", token: "test" },
        openReview() {},
        showHome() {},
      },
    });
    const submissionId = crypto.randomUUID();
    const request = {
      method: "POST",
      body: JSON.stringify({
        decision: "request-changes",
        submissionId,
        comments: [selected, summary],
      }),
    };
    f.loseNextSubmissionResponse();
    await expect(session.fetch("/submissions", request)).rejects.toThrow(
      "Response lost",
    );
    expect((await session.fetch("/submissions", request)).ok).toBe(true);
    expect([...f.drafts.values()].map((draft) => draft.body)).toEqual([
      "Later draft",
    ]);
    const submits = f.calls.filter((call) => call.type === "feedback.submit");
    expect(submits).toHaveLength(2);
    expect(submits[0]?.input.drafts.map((draft) => draft.draftId)).toEqual([
      selected.threadId,
      summary.threadId,
    ]);
    expect(submits[1]).toEqual(submits[0]);
  });

  it("opens source comments at the selection's historical version and ignores callbacks after disposal", async () => {
    const f = await fixture();
    let requested: ((target: ReviewHostSourceTarget) => void) | undefined;
    const content: HostCanvasContent = {
      kind: "host",
      connection: { serverUrl: "http://127.0.0.1:5570", token: "test" },
      openReview() {},
      showHome() {},
      source: {
        async open() {},
        createPeek() {
          throw new Error("This test does not create an editor.");
        },
        onDidRequestComment(listener) {
          requested = listener;
          return { dispose() {} };
        },
      },
    };
    const session = createHostReviewSession({
      client: f.client,
      comments: f.store,
      content,
      getState: viewState,
      openRevision() {},
    });
    const events: ReviewSurfaceEvent[] = [];
    const earlyEvents: ReviewSurfaceEvent[] = [];
    const earlyUnsubscribe = session.surface.subscribe((event) =>
      earlyEvents.push(event),
    );
    const unsubscribe = session.surface.subscribe((event) =>
      events.push(event),
    );
    const target: ReviewHostSourceTarget = {
      reviewId: id,
      reviewVersion: 2,
      comparisonCommit: "e".repeat(40),
      range: { side: "base", file: "src/old.ts", fromLine: 17, toLine: 19 },
    };
    requested?.(target);
    await expect.poll(() => events.length).toBe(1);
    expect(earlyEvents).toEqual(events);
    expect(f.calls.filter((call) => call.type === "source.read")).toHaveLength(
      1,
    );
    expect(events[0]).toMatchObject({
      event: "commentRequested",
      target: {
        documentVersion: 2,
        commit: target.comparisonCommit,
        position: {
          base_sha: "d".repeat(40),
          head_sha: target.comparisonCommit,
        },
      },
    });
    requested?.(target);
    earlyUnsubscribe();
    unsubscribe();
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toHaveLength(1);
    session.dispose();
  });

  it("serves snapshot history, routes map analysis through the pinned API and rejects authored modules", async () => {
    const f = await fixture();
    const state = viewState();
    let selected: number | null = null;
    const session = createHostReviewSession({
      client: f.client,
      comments: f.store,
      getState: () => state,
      openRevision(id) {
        selected = id;
      },
      content: {
        kind: "host",
        connection: { serverUrl: "http://127.0.0.1:5570", token: "test" },
        openReview() {},
        showHome() {},
      },
    });
    const history = await (await session.fetch("/revisions")).json();
    expect(history.versions).toEqual([
      {
        revision: String(snapshot.reviewVersion),
        sealedAt: Date.parse(at),
        isCurrent: true,
      },
    ]);
    await session.surface.post({
      name: "openReviewRevision",
      args: { revision: String(snapshot.reviewVersion) },
    });
    expect(selected).toBe(snapshot.reviewVersion);
    const analysis = await session.fetch("/software-map/resolved-data", {
      method: "POST",
      body: JSON.stringify({
        savedMap: { id, commit: originalDocument.binding.headCommit },
      }),
    });
    expect(analysis.ok).toBe(true);
    expect(f.calls.find((call) => call.type === "map.analyze")?.input).toEqual({
      reviewId: id,
      reviewVersion: originalDocument.reviewVersion,
      mapVersions: { base: null, head: id },
      includeDiff: true,
      limit: 200,
    });
    await expect(
      session.importModule("http://127.0.0.1:5570/author.js"),
    ).rejects.toThrow("do not execute authored modules");
  });
});

function input(body = "Please clarify this"): CreateReviewCommentInput {
  return {
    threadId: crypto.randomUUID(),
    messageId: crypto.randomUUID(),
    target: { kind: "document" },
    body,
  };
}

async function fixture(
  defaultHarness: HostQuestionRun["harness"] | null = "codex",
) {
  const drafts = new Map<string, HostDraft>();
  const threads = new Map<string, HostThread>();
  const messages: HostMessage[] = [];
  const runs: HostQuestionRun[] = [];
  const submissions: HostFeedbackSubmission[] = [];
  const calls: (HostCommand | HostQuery)[] = [];
  const receipts = new Map<string, JsonValue>();
  let currentDocument = structuredClone(originalDocument);
  let loseSubmissionResponse = false;
  let available = true;
  let mappingFailure = false;
  let sourceGate: Promise<void> | undefined;
  let eventNumber = 0;
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const client = await ReviewClient.connect({
    serverUrl: "http://127.0.0.1:5570",
    token: "test",
    fetch: async (url, init) => {
      if (String(url).endsWith("/connection"))
        return Response.json({
          ok: true,
          data: {
            apiVersion: 1,
            hostId: id,
            workspaceId: id,
            principal: author,
          },
        });
      if (String(url).includes("/events?")) {
        let closed = false;
        return new Response(
          new ReadableStream({
            start(controller) {
              streams.push(controller);
              init?.signal?.addEventListener("abort", () => {
                if (!closed) {
                  closed = true;
                  controller.close();
                }
              });
            },
            cancel() {
              closed = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      const body = JSON.parse(String(init?.body));
      const envelope = {
        ...body,
        apiVersion: 1,
        hostId: id,
        workspaceId: id,
        clientId: id,
      };
      const request = String(url).endsWith("/commands")
        ? HostCommandSchema.parse(envelope)
        : HostQuerySchema.parse(envelope);
      calls.push(request);
      const response = (result: JsonValue) => {
        const data = {
          result,
          eventCursor: String(eventNumber),
          commandId: "commandId" in request ? request.commandId : undefined,
        };
        return Response.json({ ok: true, data });
      };
      if ("commandId" in request && receipts.has(request.commandId))
        return response(receipts.get(request.commandId)!);
      const postMessage = (
        thread: HostThread,
        body: string,
        messageId: string = crypto.randomUUID(),
      ) => {
        const message: HostMessage = {
          id: messageId,
          threadId: thread.id,
          ordinal:
            messages.filter((item) => item.threadId === thread.id).length + 1,
          author,
          body,
          replyToMessageId: null,
          questionRunId: null,
          createdAt: at,
        };
        messages.push(message);
        return message;
      };
      switch (request.type) {
        case "capabilities":
          return response({
            apiVersions: [1],
            documentSchemaVersions: [1],
            nodeTypes: ["markdown"],
            limits: HOST_CAPABILITY_LIMITS,
            commands: [],
            queries: [],
            ask: {
              supportedHarnesses: available ? ["claude-code", "codex"] : [],
              defaultHarness: available ? defaultHarness : null,
              isolation: "trusted_local",
            },
          });
        case "document.get":
          return response(
            request.input.reviewVersion === originalDocument.reviewVersion
              ? originalDocument
              : currentDocument,
          );
        case "drafts.list":
          return response({ items: [...drafts.values()], nextCursor: null });
        case "feedback.list":
          return response({ items: submissions, nextCursor: null });
        case "threads.list":
          return response({ items: [...threads.values()], nextCursor: null });
        case "questions.list":
          return response({ items: runs, nextCursor: null });
        case "thread.get":
          return response({
            thread: threads.get(request.input.threadId)!,
            messages: {
              items: messages.filter(
                (message) => message.threadId === request.input.threadId,
              ),
              nextCursor: null,
            },
          });
        case "thread.mapping":
          if (mappingFailure)
            return Response.json(
              {
                ok: false,
                error: {
                  code: "DEPENDENCY_UNAVAILABLE",
                  message: "Repository offline",
                  retryable: true,
                  diagnostics: [],
                },
              },
              { status: 503 },
            );
          return response({
            threadId: request.input.threadId,
            reviewVersion: request.input.reviewVersion,
            status: "exact",
            target: threads.get(request.input.threadId)!.target,
            evidence: null,
          });
        case "draft.save": {
          const before = drafts.get(request.input.draftId);
          if (
            before &&
            before.draftVersion !== request.input.expectedDraftVersion
          )
            return Response.json(
              {
                ok: false,
                error: {
                  code: "VERSION_CONFLICT",
                  message: "Draft changed; reopen it before saving.",
                  retryable: false,
                  diagnostics: [],
                },
              },
              { status: 409 },
            );
          const draft: HostDraft = {
            id: request.input.draftId,
            reviewId: id,
            principalId: id,
            draftVersion: before ? before.draftVersion + 1 : 0,
            target: request.input.target,
            evidence: null,
            body: request.input.body,
            createdAt: at,
            updatedAt: at,
          };
          drafts.set(draft.id, draft);
          receipts.set(request.commandId, draft);
          return response(draft);
        }
        case "draft.delete":
          drafts.delete(request.input.draftId);
          return response({ deleted: true });
        case "question.start":
        case "question.follow_up": {
          const thread: HostThread =
            request.type === "question.follow_up"
              ? threads.get(request.input.threadId)!
              : {
                  id: crypto.randomUUID(),
                  reviewId: id,
                  threadVersion: 0,
                  target: request.input.target,
                  evidence: null,
                  status: "open",
                  createdBy: id,
                  createdAt: at,
                  updatedAt: at,
                };
          threads.set(thread.id, thread);
          const message = postMessage(thread, request.input.body);
          const run: HostQuestionRun = {
            id: crypto.randomUUID(),
            reviewId: id,
            threadId: thread.id,
            questionId: message.id,
            contextId: id,
            requestedBy: id,
            assistant: { id, kind: "agent", displayName: "Agent" },
            harness: request.input.harness ?? "codex",
            state: "running",
            sessionId: "native-one",
            answerMessageId: null,
            error: null,
            createdAt: at,
            updatedAt: at,
          };
          runs.push(run);
          return response({ thread, message, run });
        }
        case "thread.reply":
          return response(
            postMessage(
              threads.get(request.input.threadId)!,
              request.input.body,
            ),
          );
        case "thread.set_status": {
          const thread = {
            ...threads.get(request.input.threadId)!,
            status: request.input.status,
            threadVersion: request.input.expectedThreadVersion + 1,
          };
          threads.set(thread.id, thread);
          return response(thread);
        }
        case "feedback.submit": {
          const result: HostFeedbackSubmission = {
            id: crypto.randomUUID(),
            reviewId: id,
            reviewVersion: request.input.reviewVersion,
            decision: request.input.decision,
            createdBy: id,
            createdAt: at,
            messageIds: [],
            threadIds: [],
          };
          for (const selected of request.input.drafts)
            drafts.delete(selected.draftId);
          receipts.set(request.commandId, result);
          submissions.unshift(result);
          if (loseSubmissionResponse) {
            loseSubmissionResponse = false;
            throw new Error("Response lost");
          }
          return response(result);
        }
        case "source.read":
          await sourceGate;
          return response({
            repositoryId: id,
            commit:
              request.input.side === "base"
                ? "d".repeat(40)
                : (request.input.comparisonCommit ??
                  currentDocument.binding.headCommit),
            blob: "f".repeat(40),
            file: request.input.file,
            range: request.input.range ?? null,
            text: "Pinned code",
            sha256: "a".repeat(64),
          });
        case "map.analyze":
          return response({
            reviewVersion: request.input.reviewVersion,
            mapVersions: request.input.mapVersions ?? snapshot.mapVersions,
            comparison: {
              baseCommit: originalDocument.binding.baseCommit,
              headCommit: originalDocument.binding.headCommit,
            },
            items: [],
            nextCursor: null,
          });
        default:
          throw new Error(`Unexpected ${request.type}`);
      }
    },
  });
  const store = createHostCommentStore({
    client,
    reviewId: id,
    getDocument: () => currentDocument,
  });
  stores.push(store);
  await store.start();
  return {
    store,
    client,
    calls,
    drafts,
    messages,
    runs,
    setDocument(value: HostDocumentState) {
      currentDocument = value;
    },
    loseNextSubmissionResponse() {
      loseSubmissionResponse = true;
    },
    setAskAvailable(value: boolean) {
      available = value;
    },
    failMapping() {
      mappingFailure = true;
    },
    holdSourceRead() {
      let release!: () => void;
      sourceGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    event(type: string) {
      const event = {
        cursor: String(++eventNumber),
        type,
        reviewId: id,
        payload: type === "question.updated" ? { run: runs.at(-1)! } : {},
      };
      for (const stream of streams)
        stream.enqueue(
          new TextEncoder().encode(
            `id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`,
          ),
        );
    },
  };
}

describe("the existing comment interface over host APIs", () => {
  it("keeps decisions on their exact saved version, not on later edits or restored content", async () => {
    const f = await fixture();
    const version = originalDocument.reviewVersion;
    await f.store.submit("approve", crypto.randomUUID());
    expect(f.store.getSnapshot().reviewDecision).toEqual({
      reviewVersion: version,
      decision: "approve",
    });
    f.setDocument({ ...originalDocument, reviewVersion: version + 1 });
    await f.store.refresh();
    expect(f.store.getSnapshot().reviewDecision).toBeNull();
    // Restoring the same JSON creates another version, not another approval.
    f.setDocument({ ...originalDocument, reviewVersion: version + 2 });
    await f.store.refresh();
    expect(f.store.getSnapshot().reviewDecision).toBeNull();
    f.setDocument(originalDocument);
    await f.store.refresh();
    expect(f.store.getSnapshot().reviewDecision).toEqual({
      reviewVersion: version,
      decision: "approve",
    });
  });
  it("uses the draft version observed when editing began rather than overwriting a concurrent edit", async () => {
    const f = await fixture();
    const draft = input("Original text");
    await f.store.saveComment(draft);
    f.store.observeDraft?.(draft.threadId);
    f.drafts.set(draft.threadId, {
      ...f.drafts.get(draft.threadId)!,
      draftVersion: 1,
      body: "Another client's edit",
    });
    await f.store.refresh();
    await expect(
      f.store.updateComment(draft.threadId, "My unsaved text", draft.messageId),
    ).rejects.toThrow("Draft changed");
    expect(f.drafts.get(draft.threadId)?.body).toBe("Another client's edit");
  });

  it("receives saved answers through subscriptions even when locating the source is unavailable", async () => {
    const f = await fixture();
    const question = input("Why this source?");
    await f.store.askAgent(question);
    const run = f.runs[0]!;
    run.state = "completed";
    f.messages.push({
      id: crypto.randomUUID(),
      threadId: run.threadId,
      ordinal: 2,
      author: run.assistant,
      body: "The retained answer",
      replyToMessageId: null,
      questionRunId: run.id,
      createdAt: at,
    });
    f.failMapping();
    f.event("question.updated");
    await expect
      .poll(
        () =>
          f.store
            .getSnapshot()
            .commentThreads.get(question.threadId)
            ?.messages.at(-1)?.body,
      )
      .toBe("The retained answer");
    expect(f.store.getSnapshot().agentActivities.has(question.threadId)).toBe(
      false,
    );
  });

  it("saves editable private drafts without posting or publishing, then explicitly submits selected versions", async () => {
    const f = await fixture();
    const comment = input();
    await f.store.saveComment(comment);
    expect(
      f.store.getSnapshot().localComments.get(comment.threadId)?.clientStatus,
    ).toBe("draft");
    expect(f.store.getSnapshot().pendingCommentCount).toBe(1);
    await f.store.updateComment(
      comment.threadId,
      "Updated question",
      comment.messageId,
    );
    expect(f.drafts.get(comment.threadId)?.body).toBe("Updated question");
    const comments = await f.store.flushPendingComments();
    expect(comments[0]?.body).toBe("Updated question");
    const result = await f.store.submit(
      "request_changes",
      crypto.randomUUID(),
      comments,
    );
    expect(result.reviewVersion).toBe(snapshot.reviewVersion);
    expect(f.store.getSnapshot().pendingCommentCount).toBe(0);
    expect(
      f.calls.filter((call) => "commandId" in call).map((call) => call.type),
    ).toEqual(["draft.save", "draft.save", "feedback.submit"]);
  });

  it("freezes the selected node version while the reader composes and retains the highlighted quote after reopening", async () => {
    document.body.innerHTML =
      '<article class="review-document"><section data-host-node-id="intro"><p data-review-block-index="0">Hello world</p></section></article>';
    const f = await fixture();
    const target = buildBlockTarget({
      tag: "p",
      index: 0,
      text: "Hello world",
      start: 6,
      length: 5,
    });
    f.store.observeTarget?.(target);
    f.setDocument({
      ...originalDocument,
      reviewVersion: 4,
      nodes: {
        intro: { id: "intro", type: "markdown", markdown: "New content" },
      },
    });
    const comment = { ...input(), target };
    await f.store.saveComment(comment);
    const retained = f.drafts.get(comment.threadId)!.target;
    expect(retained).toMatchObject({
      kind: "node",
      nodeId: "intro",
      reviewVersion: 3,
      selection: { quote: "world", prefix: "Hello ", suffix: "" },
    });
    expect(projectHostFeedbackTarget(retained, originalDocument)).toEqual(
      target,
    );
  });

  it("starts Ask with the supported Codex harness and replies without allowing posted edits/deletes", async () => {
    const f = await fixture();
    const question = input("Why?");
    await f.store.askAgent(question);
    expect(f.runs[0]?.harness).toBe("codex");
    expect(
      f.store.getSnapshot().agentActivities.get(question.threadId)?.status,
    ).toBe("running");
    await expect(
      f.store.updateComment(question.threadId, "Replacement"),
    ).rejects.toThrow("Posted messages");
    await expect(f.store.deleteComment(question.threadId)).rejects.toThrow(
      "Posted messages",
    );
    await f.store.saveComment({
      ...question,
      messageId: crypto.randomUUID(),
      body: "Thanks",
    });
    await f.store.askAgent({
      ...question,
      messageId: crypto.randomUUID(),
      body: "What about failures?",
    });
    expect(f.messages.map((message) => message.body)).toEqual([
      "Why?",
      "Thanks",
      "What about failures?",
    ]);
    expect(f.calls.some((call) => call.type === "question.follow_up")).toBe(
      true,
    );
    await f.store.setCommentResolved(question.threadId, true);
    expect(
      f.store.getSnapshot().commentThreads.get(question.threadId)?.status,
    ).toBe("resolved");
  });

  it("requires a choice with multiple agents and sends the selected agent for new and follow-up questions", async () => {
    const f = await fixture(null);
    const question = input("Why?");
    await expect(f.store.askAgent(question)).rejects.toThrow(
      "Choose an answering agent",
    );
    expect(f.runs).toHaveLength(0);
    await f.store.askAgent(question, "claude-code");
    await f.store.askAgent(
      { ...question, messageId: crypto.randomUUID(), body: "And this?" },
      "codex",
    );
    expect(f.runs.map((run) => run.harness)).toEqual(["claude-code", "codex"]);
    await expect(f.store.askAgent(input(), "pi")).rejects.toThrow(
      "no longer available",
    );
    expect(f.runs).toHaveLength(2);
  });

  it("does not erase a private draft when adding another comment or asking a different question", async () => {
    const f = await fixture();
    const draft = input("Original finding");
    await f.store.saveComment(draft);
    await f.store.saveComment({
      ...draft,
      messageId: crypto.randomUUID(),
      body: "Another finding",
    });
    await f.store.askAgent({
      ...draft,
      messageId: crypto.randomUUID(),
      body: "A different question?",
    });
    expect([...f.drafts.values()].map((item) => item.body)).toEqual([
      "Original finding",
      "Another finding",
    ]);
    expect(f.store.getSnapshot().pendingCommentCount).toBe(2);
    expect(f.messages.map((message) => message.body)).toEqual([
      "A different question?",
    ]);
  });

  it("replays exactly the same snapshot and draft versions after a lost submission response", async () => {
    const f = await fixture();
    const comment = input();
    await f.store.saveComment(comment);
    const submissionId = crypto.randomUUID();
    f.loseNextSubmissionResponse();
    await expect(f.store.submit("approve", submissionId)).rejects.toThrow(
      "Response lost",
    );
    f.setDocument({
      ...originalDocument,
      reviewVersion: 4,
    });
    await f.store.refresh();
    const result = await f.store.submit("approve", submissionId);
    expect(result.reviewVersion).toBe(snapshot.reviewVersion);
    const attempts = f.calls.filter((call) => call.type === "feedback.submit");
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
  });

  it("submits the saved snapshot without publishing and refuses Ask without a supported local agent", async () => {
    const f = await fixture();
    await expect(
      f.store.submit("approve", crypto.randomUUID()),
    ).resolves.toMatchObject({ reviewVersion: originalDocument.reviewVersion });
    f.setAskAvailable(false);
    await expect(f.store.askAgent(input())).rejects.toThrow(
      "Ask is unavailable",
    );
    expect(
      f.calls.filter((call) => "commandId" in call).map((call) => call.type),
    ).toEqual(["feedback.submit"]);
  });

  it("keeps source ranges on their original side and selected immutable commit", () => {
    const target = {
      ...buildCodeTarget({
        path: "src/example.ts",
        side: "base",
        baseCommit: "d".repeat(40),
        headCommit: "e".repeat(40),
        span: { startLine: 8, endLine: 12 },
      }),
      documentVersion: 2,
      commit: "e".repeat(40),
    };
    const host = toHostFeedbackTarget(target, originalDocument);
    expect(host).toEqual({
      kind: "source",
      reviewVersion: 2,
      comparisonCommit: "e".repeat(40),
      range: { side: "base", file: "src/example.ts", fromLine: 8, toLine: 12 },
    });
    const projected = projectHostFeedbackTarget(
      host,
      originalDocument,
      undefined,
      {
        span: {
          repositoryId: id,
          commit: "d".repeat(40),
          blob: "f".repeat(40),
          file: "src/example.ts",
          fromLine: 8,
          toLine: 12,
        },
        text: "retained",
        sha256: "a".repeat(64),
      },
    );
    expect(projected).toEqual(target);
  });
});
