// @vitest-environment jsdom
import {
  HOST_LIMITS,
  type HostCheckpoint,
  type HostCommand,
  type HostCommandResults,
  HostCommandSchema,
  type HostDocumentState,
  type HostDraft,
  type HostFeedbackSubmission,
  type HostMessage,
  type HostQuery,
  type HostQueryResults,
  HostQuerySchema,
  type HostQuestionRun,
  type HostThread,
  ReviewClient,
} from "@dev.fast/review-protocol";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { HostFeedbackPanel, hostFeedbackTargets } from "./host-feedback-panel";

const id = "27768987-4d4d-4c6f-885c-4bf783f44c27";
const at = "2026-09-10T12:00:00Z";
const author = { id, kind: "human" as const, displayName: "Reader" };
const documentState: HostDocumentState = {
  schemaVersion: 1,
  documentId: id,
  reviewId: id,
  version: 3,
  roots: ["intro"],
  nodes: { intro: { id: "intro", type: "markdown", markdown: "Hello" } },
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
const checkpoint: HostCheckpoint = {
  id,
  reviewId: id,
  ordinal: 1,
  documentVersion: 3,
  bindingId: id,
  title: "Checkpoint",
  description: "",
  mapVersions: { base: null, head: null },
  authorSessionId: null,
  createdBy: id,
  createdAt: at,
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function fixture() {
  let drafts: HostDraft[] = [];
  const threads: HostThread[] = [];
  const messages: HostMessage[] = [];
  const runs: HostQuestionRun[] = [];
  const submissions: HostFeedbackSubmission[] = [];
  const calls: (HostCommand | HostQuery)[] = [];
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  let eventNumber = 0;
  let mappingFailure = false;
  let heldCommand:
    | { type: HostCommand["type"]; ready: Promise<void> }
    | undefined;
  const client = await ReviewClient.connect({
    serverUrl: "http://127.0.0.1:5570",
    token: "secret",
    fetch: async (url, init) => {
      expect(new Headers(init?.headers).get("x-review-token")).toBe("secret");
      if (String(url).endsWith("/connection"))
        return Response.json({
          apiVersion: 1,
          hostId: id,
          workspaceId: id,
          principal: author,
        });
      if (String(url).includes("/events?")) {
        let current: ReadableStreamDefaultController<Uint8Array>;
        return new Response(
          new ReadableStream({
            start(controller) {
              current = controller;
              streams.push(controller);
              init?.signal?.addEventListener("abort", () => {
                try {
                  controller.close();
                } catch {}
              });
            },
            cancel() {
              streams.splice(streams.indexOf(current), 1);
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      const request = String(url).endsWith("/commands")
        ? HostCommandSchema.parse(JSON.parse(String(init?.body)))
        : HostQuerySchema.parse(JSON.parse(String(init?.body)));
      calls.push(request);
      if (request.type === heldCommand?.type) await heldCommand.ready;
      const respond = (
        result:
          | HostCommandResults[keyof HostCommandResults]
          | HostQueryResults[keyof HostQueryResults],
      ) =>
        Response.json({
          ok: true,
          data: {
            result,
            eventCursor: `cursor-${eventNumber}`,
            commandId: "commandId" in request ? request.commandId : undefined,
          },
        });
      switch (request.type) {
        case "capabilities":
          return respond({
            apiVersions: [1],
            documentSchemaVersions: [1],
            nodeTypes: ["markdown"],
            limits: HOST_LIMITS,
            commands: [],
            queries: [],
            rendererVersion: "test",
            source: { read: true, navigation: true },
            ask: {
              available: true,
              supportedHarnesses: ["codex"],
              isolation: "trusted_local",
            },
          });
        case "drafts.list":
          return respond({ items: drafts, nextCursor: null });
        case "threads.list":
          return respond({ items: threads, nextCursor: null });
        case "questions.list":
          return respond({ items: [...runs].reverse(), nextCursor: null });
        case "feedback.list":
          return respond({ items: submissions, nextCursor: null });
        case "draft.save": {
          const input = request.input;
          const existing = drafts.find((draft) => draft.id === input.draftId);
          if (existing && existing.version !== input.expectedVersion)
            return Response.json(
              {
                ok: false,
                error: {
                  code: "VERSION_CONFLICT",
                  message: "Draft changed; reload before saving",
                  retryable: false,
                  diagnostics: [],
                },
              },
              { status: 409 },
            );
          const draft: HostDraft = {
            id: input.draftId,
            reviewId: id,
            principalId: id,
            version: existing ? existing.version + 1 : 0,
            target: input.target,
            evidence: null,
            body: input.body,
            createdAt: at,
            updatedAt: at,
          };
          drafts = [...drafts.filter((item) => item.id !== draft.id), draft];
          return respond(draft);
        }
        case "feedback.submit": {
          const submission: HostFeedbackSubmission = {
            id: crypto.randomUUID(),
            reviewId: id,
            checkpointId: request.input.checkpointId,
            decision: request.input.decision,
            createdBy: id,
            createdAt: at,
            messageIds: [],
            threadIds: [],
          };
          submissions.push(submission);
          drafts = drafts.filter(
            (draft) =>
              !request.input.drafts.some(
                (selected) => selected.draftId === draft.id,
              ),
          );
          return respond(submission);
        }
        case "thread.create":
        case "question.start": {
          const thread: HostThread = {
            id: crypto.randomUUID(),
            reviewId: id,
            version: 0,
            target: request.input.target,
            evidence: null,
            status: "open",
            createdBy: id,
            createdAt: at,
            updatedAt: at,
          };
          const message: HostMessage = {
            id: crypto.randomUUID(),
            threadId: thread.id,
            ordinal: 1,
            author,
            body: request.input.body,
            replyToMessageId: null,
            questionRunId: null,
            createdAt: at,
          };
          threads.push(thread);
          messages.push(message);
          if (request.type === "thread.create")
            return respond({ thread, message });
          const run: HostQuestionRun = {
            id: crypto.randomUUID(),
            reviewId: id,
            threadId: thread.id,
            questionId: message.id,
            contextId: id,
            requestedBy: id,
            assistant: { id, kind: "agent", displayName: "Agent" },
            harness: request.input.harness,
            state: "running",
            sessionId: "native-one",
            answerMessageId: null,
            error: null,
            createdAt: at,
            updatedAt: at,
          };
          runs.push(run);
          return respond({ thread, message, run });
        }
        case "thread.get":
          return respond({
            thread: threads.find(
              (thread) => thread.id === request.input.threadId,
            )!,
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
          return respond({
            threadId: request.input.threadId,
            documentVersion: request.input.documentVersion,
            status: "missing",
            target: null,
            evidence: null,
          });
        case "thread.reply": {
          const message: HostMessage = {
            id: request.input.messageId,
            threadId: request.input.threadId,
            ordinal: messages.length + 1,
            author,
            body: request.input.body,
            replyToMessageId: null,
            questionRunId: null,
            createdAt: at,
          };
          messages.push(message);
          return respond(message);
        }
        case "question.retry": {
          const run = runs.find((run) => run.id === request.input.runId)!;
          const retried: HostQuestionRun = {
            ...run,
            id: crypto.randomUUID(),
            state: "pending",
            sessionId: null,
            answerMessageId: null,
            error: null,
          };
          runs.push(retried);
          return respond(retried);
        }
        default:
          throw new Error(`Unexpected request ${request.type}`);
      }
    },
  });
  return {
    client,
    calls,
    drafts: () => drafts,
    runs,
    messages,
    holdCommand(type: HostCommand["type"]) {
      let release!: () => void;
      heldCommand = {
        type,
        ready: new Promise<void>((resolve) => {
          release = resolve;
        }),
      };
      return () => {
        heldCommand = undefined;
        release();
      };
    },
    failMapping() {
      mappingFailure = true;
    },
    event() {
      const cursor = `cursor-${++eventNumber}`;
      for (const stream of streams)
        stream.enqueue(
          new TextEncoder().encode(
            `id:${cursor}\ndata:${JSON.stringify({ cursor, reviewId: id, type: "question.updated", payload: {} })}\n\n`,
          ),
        );
    },
  };
}
async function render(client: ReviewClient, state = documentState) {
  await act(async () =>
    root.render(
      <HostFeedbackPanel
        client={client}
        document={state}
        checkpoint={checkpoint}
      />,
    ),
  );
}
async function type(label: string, value: string) {
  const input = container.querySelector<HTMLTextAreaElement>(
    `textarea[aria-label="${label}"]`,
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === label,
  );
  if (!button) throw new Error(`Missing button ${label}`);
  await act(async () => button.click());
}

describe("API-owned discussion", () => {
  it.each([
    ["Add to review", "draft.save"],
    ["Post comment", "thread.create"],
    ["Ask now", "question.start"],
  ] as const)(
    "locks the composer while %s is being saved",
    async (label, command) => {
      const f = await fixture();
      await render(f.client);
      await type("New comment or question", "The submitted text");
      const release = f.holdCommand(command);
      await click(label);
      const composer = container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="New comment or question"]',
      )!;
      expect(composer.disabled).toBe(true);
      expect(composer.value).toBe("The submitted text");
      expect(
        container.querySelector<HTMLSelectElement>(
          '[aria-label="Comment target"]',
        )!.disabled,
      ).toBe(true);
      await act(async () => release());
      expect(composer.disabled).toBe(false);
      expect(composer.value).toBe("");
      expect(f.calls.find((request) => request.type === command)).toMatchObject(
        {
          input: { body: "The submitted text" },
        },
      );
      await type("New comment or question", "Next comment");
      expect(composer.value).toBe("Next comment");
    },
  );

  it("locks the reply composer until the posted reply has been saved", async () => {
    const f = await fixture();
    await render(f.client);
    await type("New comment or question", "First comment");
    await click("Post comment");
    await click("▸ Whole review · open");
    await type("Reply to discussion", "Follow-up text");
    const release = f.holdCommand("thread.reply");
    await click("Reply");
    const composer = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Reply to discussion"]',
    )!;
    expect(composer.disabled).toBe(true);
    expect(composer.value).toBe("Follow-up text");
    await act(async () => release());
    expect(composer.disabled).toBe(false);
    expect(composer.value).toBe("");
    expect(f.messages.map((message) => message.body)).toEqual([
      "First comment",
      "Follow-up text",
    ]);
  });

  it("preserves dirty draft text and its base version when another client saves the draft", async () => {
    const f = await fixture();
    await render(f.client);
    await type("New comment or question", "First saved text");
    await click("Add to review");
    await type("Private draft", "My unsaved edits");
    const submit = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Submit 1 selected draft",
    )!;
    expect(submit.disabled).toBe(true);
    await act(async () => submit.click());
    expect(f.calls.some((call) => call.type === "feedback.submit")).toBe(false);
    f.drafts()[0].version = 1;
    f.drafts()[0].body = "Changed from another client";
    await act(async () => f.event());
    expect(
      container.querySelector<HTMLTextAreaElement>(
        '[aria-label="Private draft"]',
      )?.value,
    ).toBe("My unsaved edits");
    expect(container.textContent).toContain("Your unsaved text is preserved");
    await click("Save draft");
    expect(
      f.calls.filter((call) => call.type === "draft.save")[1].input,
    ).toMatchObject({ expectedVersion: 0, body: "My unsaved edits" });
    expect(container.textContent).toContain(
      "Draft changed; reload before saving",
    );
    expect(
      container.querySelector<HTMLTextAreaElement>(
        '[aria-label="Private draft"]',
      )?.value,
    ).toBe("My unsaved edits");
    await click("Discard local edits and reload");
    expect(
      container.querySelector<HTMLTextAreaElement>(
        '[aria-label="Private draft"]',
      )?.value,
    ).toBe("Changed from another client");
  });

  it("shows immutable messages even when locating their old source target fails", async () => {
    const f = await fixture();
    await render(f.client);
    await type(
      "New comment or question",
      "Saved question before going offline",
    );
    await click("Ask now");
    f.failMapping();
    await click("▸ Whole review · open");
    expect(container.textContent).toContain(
      "Saved question before going offline",
    );
    expect(container.textContent).toContain("Repository offline");
    expect(container.textContent).not.toContain("Loading messages…");
  });

  it("authors a comment from the exact historical native source selection", async () => {
    const f = await fixture();
    const selected = {
      reviewId: id,
      documentVersion: 2,
      range: {
        side: "base" as const,
        file: "src/old.ts",
        fromLine: 17,
        toLine: 19,
      },
    };
    await act(async () =>
      root.render(
        <HostFeedbackPanel
          client={f.client}
          document={documentState}
          checkpoint={checkpoint}
          requestedSource={selected}
        />,
      ),
    );
    await type(
      "New comment or question",
      "This selected code needs explaining",
    );
    await click("Add to review");
    expect(
      f.calls.find((call) => call.type === "draft.save")?.input,
    ).toMatchObject({
      target: { kind: "source", documentVersion: 2, range: selected.range },
    });
  });
  it("keeps the observed target through live edits and submits private draft versions against a checkpoint", async () => {
    const f = await fixture();
    await render(f.client);
    await type("New comment or question", "Please explain this");
    await render(f.client, { ...documentState, version: 4 });
    expect(container.textContent).toContain("Observed version 3");
    await click("Add to review");
    const create = f.calls.find((call) => call.type === "draft.save");
    expect(create?.input).toMatchObject({
      expectedVersion: null,
      target: { kind: "document", documentVersion: 3 },
      body: "Please explain this",
    });
    expect(container.textContent).toContain("Saved privately");
    await type("Private draft", "Updated private question");
    await click("Save draft");
    expect(
      f.calls.filter((call) => call.type === "draft.save")[1].input,
    ).toMatchObject({ expectedVersion: 0, body: "Updated private question" });
    await click("Submit 1 selected draft");
    const submit = f.calls.find((call) => call.type === "feedback.submit");
    expect(submit?.input).toMatchObject({
      checkpointId: id,
      drafts: [{ expectedVersion: 1 }],
    });
    expect(f.drafts()).toHaveLength(0);
    expect(container.textContent).toContain("Review submitted.");
  });

  it("saves questions, shows final answers from live events, and permits follow-up but not editing posted messages", async () => {
    const f = await fixture();
    await render(f.client);
    await type("New comment or question", "Why this design?");
    await click("Ask now");
    expect(
      f.calls.find((call) => call.type === "question.start")?.input,
    ).toMatchObject({
      body: "Why this design?",
      harness: "codex",
      target: { documentVersion: 3 },
    });
    expect(container.textContent).toContain("Question running");
    await click("▸ Whole review · open");
    expect(container.textContent).toContain("Why this design?");
    expect(container.textContent).toContain("original context is retained");
    const run = f.runs[0];
    run.state = "completed";
    f.messages.push({
      id: crypto.randomUUID(),
      threadId: run.threadId,
      ordinal: 2,
      author: run.assistant,
      body: "The final saved answer",
      replyToMessageId: run.questionId,
      questionRunId: run.id,
      createdAt: at,
    });
    await act(async () => f.event());
    expect(container.textContent).toContain("The final saved answer");
    expect(
      [...container.querySelectorAll("textarea")].some((input) =>
        input.value.includes("final saved answer"),
      ),
    ).toBe(false);
    await type("Reply to discussion", "Thanks for clarifying");
    await click("Reply");
    expect(container.textContent).toContain("Thanks for clarifying");
    expect(
      f.calls.find((call) => call.type === "thread.reply")?.input,
    ).toMatchObject({ body: "Thanks for clarifying", threadId: run.threadId });
  });

  it.each(["failed", "interrupted"] as const)(
    "replaces a %s attempt's badge with its successful retry without losing saved messages",
    async (state) => {
      const f = await fixture();
      await render(f.client);
      await type("New comment or question", "Can you explain the source?");
      await click("Ask now");
      const original = f.runs[0];
      original.state = state;
      original.error = "Assistant stopped before answering";
      await act(async () => f.event());
      expect(container.textContent).toContain(`Question ${state}`);

      await click("Retry question");
      expect(
        f.calls.find((call) => call.type === "question.retry")?.input,
      ).toEqual({ reviewId: id, runId: original.id });
      const retried = f.runs[1];
      expect(retried.id).not.toBe(original.id);
      expect(retried.questionId).toBe(original.questionId);
      expect(original.state).toBe(state);
      expect(container.textContent).toContain("Question pending");
      expect(container.textContent).not.toContain(`Question ${state}`);
      expect(container.textContent).not.toContain("Retry question");

      retried.state = "completed";
      retried.answerMessageId = crypto.randomUUID();
      f.messages.push({
        id: retried.answerMessageId,
        threadId: retried.threadId,
        ordinal: 2,
        author: retried.assistant,
        body: "The retry's final saved answer",
        replyToMessageId: retried.questionId,
        questionRunId: retried.id,
        createdAt: at,
      });
      await act(async () => f.event());
      expect(container.textContent).toContain("Question answered");
      expect(container.textContent).not.toContain(`Question ${state}`);
      expect(container.textContent).not.toContain("Retry question");
      await click("▸ Whole review · open");
      expect(container.textContent).toContain("Can you explain the source?");
      expect(container.textContent).toContain("The retry's final saved answer");
      expect(f.runs).toHaveLength(2);
      expect(original.error).toBe("Assistant stopped before answering");
    },
  );

  it("offers exact node, source, diagram-item and retained-trace targets", () => {
    const state = structuredClone(documentState);
    state.nodes.flow = {
      id: "flow",
      type: "sequence",
      title: "Flow",
      messages: [
        {
          id: "message-one",
          fromActorId: "actor",
          toActorId: "actor",
          label: "Same label",
          evidence: { kind: "illustrative_code", language: "ts", text: "code" },
          style: "call",
        },
      ],
    };
    state.nodes.trace = {
      id: "trace",
      type: "trace_quote",
      traceId: id,
      eventId: id,
      text: "Retained evidence",
    };
    state.definitions.source = {
      kind: "anchor",
      title: "Source",
      source: { side: "head", file: "src/main.ts", fromLine: 10, toLine: 12 },
    };
    const targets = hostFeedbackTargets(state).map((choice) => choice.target);
    expect(targets).toContainEqual({
      kind: "diagram",
      documentVersion: 3,
      nodeId: "flow",
      itemId: "message-one",
    });
    expect(targets).toContainEqual({
      kind: "trace",
      documentVersion: 3,
      nodeId: "trace",
      eventId: id,
    });
    expect(targets).toContainEqual({
      kind: "source",
      documentVersion: 3,
      range: { side: "head", file: "src/main.ts", fromLine: 10, toLine: 12 },
    });
  });
});
