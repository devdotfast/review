import { ReviewClientError } from "@dev.fast/review-protocol";
import type {
  CreateReviewCommentInput,
  HostDiagramItem,
  HostDocumentState,
  HostDraft,
  HostFeedbackSubmission,
  HostFeedbackTarget,
  HostMessage,
  HostNode,
  HostQuestionRun,
  HostSourceQuote,
  HostThread,
  ReviewClient,
  ReviewCommentStoreBridge,
  ReviewCommentStoreChange,
  ReviewCommentStoreSnapshot,
  ReviewCommentThreadRecord,
  ThreadTarget,
} from "@dev.fast/review-protocol";

import {
  buildBlockTarget,
  buildCodeTarget,
  buildDocumentTextTarget,
  buildGraphTarget,
  buildTableCellTarget,
  projectCodeTarget,
} from "../target-fingerprint";

type Decision = HostFeedbackSubmission["decision"];
type Harness = HostQuestionRun["harness"];
type Selection = { quote: string; prefix?: string; suffix?: string };

export interface HostCommentStore extends ReviewCommentStoreBridge {
  hostThreadId(threadId: string): string | undefined;
  start(): Promise<void>;
  refresh(): Promise<void>;
  dispose(): void;
  submit(
    decision: Decision,
    submissionId: string,
    inputs?: CreateReviewCommentInput[],
  ): Promise<HostFeedbackSubmission>;
}

export interface HostCommentStoreOptions {
  client: ReviewClient;
  reviewId: string;
  getDocument(): HostDocumentState;
  onError?(error: Error): void;
  resolveGraphTarget?(
    target: Extract<ThreadTarget, { kind: "graph" }>,
    document: HostDocumentState,
  ): { nodeId: string; item?: HostDiagramItem } | null;
  projectGraphTarget?(
    target: Extract<HostFeedbackTarget, { kind: "diagram" }>,
    document: HostDocumentState,
  ): ThreadTarget | null;
}

/** Adapt the existing annotation UI to host APIs. No local persistence. */
export function createHostCommentStore(
  options: HostCommentStoreOptions,
): HostCommentStore {
  const { client, reviewId } = options;
  const abort = new AbortController();
  const listeners = new Set<(change: ReviewCommentStoreChange) => void>();
  const aliases = new Map<string, string>();
  const targets = new Map<string, { version: number; target: ThreadTarget }>();
  const observations = new WeakMap<ThreadTarget, HostFeedbackTarget>();
  const draftMessageIds = new Map<string, string>();
  const draftEditVersions = new Map<string, number>();
  const documents = new Map<number, HostDocumentState>();
  const submissions = new Map<
    string,
    {
      reviewId: string;
      reviewVersion: number;
      decision: Decision;
      drafts: { draftId: string; expectedDraftVersion: number }[];
    }
  >();
  let drafts = new Map<string, HostDraft>();
  let threads = new Map<string, HostThread>();
  let snapshot: ReviewCommentStoreSnapshot = {
    commentThreads: new Map(),
    localComments: new Map(),
    agentActivities: new Map(),
    terminalThreadIds: new Set(),
    pendingCommentCount: 0,
  };
  let submitting = new Set<string>();
  let refreshGeneration = 0;
  let startPromise: Promise<void> | undefined;
  let writes: Promise<unknown> = Promise.resolve();

  const report = (cause: unknown) => {
    if (!abort.signal.aborted)
      options.onError?.(
        cause instanceof Error ? cause : new Error(String(cause)),
      );
  };
  const notify = (next: ReviewCommentStoreSnapshot) => {
    const threadIds = new Set([
      ...snapshot.commentThreads.keys(),
      ...next.commentThreads.keys(),
    ]);
    snapshot = next;
    for (const listener of listeners) listener({ threadIds });
  };
  const uiId = (id: string) => aliases.get(id) ?? id;
  const hostThread = (id: string) =>
    threads.get(id) ??
    [...threads.values()].find((item) => uiId(item.id) === id);
  const readDocument = async (version: number) => {
    const current = options.getDocument();
    documents.set(current.reviewVersion, current);
    const retained = documents.get(version);
    if (retained) return retained;
    const { result } = await client.query(
      "document.get",
      { reviewId, reviewVersion: version },
      abort.signal,
    );
    documents.set(version, result);
    return result;
  };
  const project = async (
    id: string,
    target: HostFeedbackTarget,
    evidence?: HostSourceQuote | null,
  ) => {
    const saved = targets.get(id);
    if (saved?.version === target.reviewVersion) return saved.target;
    return projectHostFeedbackTarget(
      target,
      await readDocument(target.reviewVersion),
      options.projectGraphTarget,
      evidence,
    );
  };
  async function refreshSnapshot(): Promise<string> {
    const generation = ++refreshGeneration;
    const document = options.getDocument();
    const draftPage = await allPages((cursor) =>
      client.query(
        "drafts.list",
        { reviewId, cursor, limit: 200 },
        abort.signal,
      ),
    );
    const [threadPage, runs, feedback] = await Promise.all([
      allPages((cursor) =>
        client.query(
          "threads.list",
          { reviewId, cursor, limit: 200 },
          abort.signal,
        ),
      ),
      allPages((cursor) =>
        client.query(
          "questions.list",
          { reviewId, cursor, limit: 200 },
          abort.signal,
        ),
      ),
      allPages((cursor) =>
        client.query(
          "feedback.list",
          { reviewId, cursor, limit: 200 },
          abort.signal,
        ),
      ),
    ]);
    const commentThreads = new Map<string, ReviewCommentThreadRecord>();
    const localComments = new Map<
      string,
      ReviewCommentStoreSnapshot["localComments"] extends ReadonlyMap<
        string,
        infer T
      >
        ? T
        : never
    >();
    await Promise.all(
      threadPage.items.map(async (thread) => {
        const [messages, mapping] = await Promise.all([
          allPages(async (cursor) => {
            const page = await client.query(
              "thread.get",
              { reviewId, threadId: thread.id, cursor, limit: 200 },
              abort.signal,
            );
            return {
              result: page.result.messages,
              eventCursor: page.eventCursor,
            };
          }),
          client
            .query(
              "thread.mapping",
              {
                reviewId,
                threadId: thread.id,
                reviewVersion: document.reviewVersion,
              },
              abort.signal,
            )
            .catch((error) => {
              if (
                !(error instanceof ReviewClientError) ||
                error.detail.code !== "DEPENDENCY_UNAVAILABLE"
              )
                throw error;
              report(error);
              return {
                result: {
                  target: null,
                  evidence: null,
                  status: "missing" as const,
                },
              };
            }),
        ]);
        let target = await project(
          thread.id,
          mapping.result.target ?? thread.target,
          mapping.result.evidence ?? thread.evidence,
        );
        if (target.kind === "code") {
          const original = await projectHostFeedbackTarget(
            thread.target,
            await readDocument(thread.target.reviewVersion),
            undefined,
            thread.evidence,
          );
          if (original.kind === "code") {
            target = {
              ...target,
              original_position: original.original_position,
            };
            if (mapping.result.status === "missing")
              target.change_position = original.position;
          }
        }
        const latestRun = runs.items
          .filter((run) => run.threadId === thread.id && run.sessionId)
          .sort((left, right) =>
            right.createdAt.localeCompare(left.createdAt),
          )[0];
        const record: ReviewCommentThreadRecord = {
          threadId: uiId(thread.id),
          target,
          status: thread.status,
          messages: messages.items.map(projectMessage),
        };
        if (latestRun?.sessionId)
          record.agentSession = {
            harness: latestRun.harness,
            sessionId: latestRun.sessionId,
          };
        commentThreads.set(uiId(thread.id), record);
      }),
    );
    for (const draft of draftPage.items) {
      const target = await project(draft.id, draft.target, draft.evidence);
      const messageId = draftMessageIds.get(draft.id) ?? draft.id;
      const input: CreateReviewCommentInput = {
        threadId: draft.id,
        messageId,
        target,
        body: draft.body,
      };
      const thread: ReviewCommentThreadRecord = {
        threadId: draft.id,
        target,
        status: "open",
        messages: [
          {
            id: messageId,
            by: "You",
            at: draft.createdAt,
            body: draft.body,
            role: "reviewer",
            format: "plain",
            agentInput: false,
          },
        ],
      };
      commentThreads.set(draft.id, thread);
      localComments.set(draft.id, {
        clientStatus: submitting.has(draft.id) ? "submitting" : "draft",
        thread,
        inputs: [input],
      });
    }
    const agentActivities = new Map<
      string,
      ReviewCommentStoreSnapshot["agentActivities"] extends ReadonlyMap<
        string,
        infer T
      >
        ? T
        : never
    >();
    for (const run of [...runs.items].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    )) {
      const id = uiId(run.threadId);
      agentActivities.delete(id);
      const activity = { messageId: run.questionId, startedAt: run.createdAt };
      if (run.state === "pending" || run.state === "running")
        agentActivities.set(id, {
          ...activity,
          status: run.state === "pending" ? "starting" : "running",
        });
      else if (run.state === "failed" || run.state === "interrupted")
        agentActivities.set(id, {
          ...activity,
          status: "failed",
          error: run.error ?? "The question could not be completed.",
        });
    }
    if (!abort.signal.aborted && generation === refreshGeneration) {
      const decision = feedback.items.find(
        (item) =>
          item.reviewVersion === document.reviewVersion &&
          item.decision !== "comment",
      );
      drafts = new Map(draftPage.items.map((draft) => [draft.id, draft]));
      threads = new Map(threadPage.items.map((thread) => [thread.id, thread]));
      notify({
        ...snapshot,
        reviewDecision:
          decision && decision.decision !== "comment"
            ? {
                reviewVersion: document.reviewVersion,
                decision: decision.decision,
              }
            : null,
        commentThreads,
        localComments,
        agentActivities,
        pendingCommentCount: drafts.size,
      });
    }
    return draftPage.eventCursor;
  }
  const serialize = <T>(write: () => Promise<T>): Promise<T> => {
    const result = writes.then(write);
    writes = result.catch(report);
    return result;
  };
  const immutable = () => {
    throw new Error(
      "Posted messages cannot be edited or deleted. Add a follow-up instead.",
    );
  };
  async function removeDraft(threadId: string) {
    const draft = drafts.get(threadId);
    if (!draft) return immutable();
    await client.command("draft.delete", {
      reviewId,
      draftId: draft.id,
      expectedDraftVersion: draft.draftVersion,
    });
    await refreshSnapshot();
  }
  async function save(input: CreateReviewCommentInput) {
    const body = input.body.trim();
    if (!body) return;
    const thread = hostThread(input.threadId);
    if (thread) {
      await client.command(
        "thread.reply",
        {
          reviewId,
          threadId: thread.id,
          body,
        },
        { commandId: input.messageId },
      );
    } else {
      const existingDraft = drafts.get(input.threadId);
      // A reply to a private draft is another pending comment, not an edit
      // that silently overwrites the already saved message.
      const draftId =
        existingDraft &&
        (draftMessageIds.get(existingDraft.id) ?? existingDraft.id) !==
          input.messageId
          ? input.messageId
          : input.threadId;
      const draft = drafts.get(draftId);
      if (draft?.body === body) return;
      const document = options.getDocument();
      const target =
        draft?.target ??
        observations.get(input.target) ??
        toHostFeedbackTarget(
          input.target,
          document,
          options.resolveGraphTarget,
        );
      await client.command(
        "draft.save",
        {
          reviewId,
          draftId,
          expectedDraftVersion: draft?.draftVersion ?? null,
          target,
          body,
        },
        draft ? {} : { commandId: input.messageId },
      );
      targets.set(draftId, {
        version: target.reviewVersion,
        target: input.target,
      });
      draftMessageIds.set(draftId, input.messageId);
    }
    await refreshSnapshot();
  }
  async function askOptions() {
    const { result } = await client.query("capabilities", {}, abort.signal);
    return result.ask;
  }
  async function chooseHarness(requested?: Harness): Promise<Harness> {
    const options = await askOptions();
    const supported = options.supportedHarnesses;
    const chosen =
      requested ??
      options.defaultHarness ??
      (supported.length === 1 ? supported[0] : undefined);
    if (chosen && !supported.includes(chosen))
      throw new Error("The selected local agent is no longer available.");
    if (!chosen)
      throw new Error(
        supported.length
          ? "Choose an answering agent before asking a question."
          : "Ask is unavailable: no supported local agent is configured.",
      );
    return chosen;
  }
  const store: HostCommentStore = {
    askOptions,
    hostThreadId: (id) => hostThread(id)?.id,
    postedMessagesImmutable: true,
    repliesReopenResolvedThreads: false,
    observeTarget(target) {
      observations.set(
        target,
        toHostFeedbackTarget(
          target,
          options.getDocument(),
          options.resolveGraphTarget,
        ),
      );
    },
    observeDraft(threadId) {
      const draft = drafts.get(threadId);
      if (draft) draftEditVersions.set(threadId, draft.draftVersion);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    start() {
      return (startPromise ??= refreshSnapshot().then((after) => {
        void client
          .subscribe({
            after,
            reviewId,
            signal: abort.signal,
            onReset: refreshSnapshot,
            onEvent: async (event) => {
              if (
                /^(draft|thread|message|question|feedback|document)\./.test(
                  event.type,
                )
              )
                return refreshSnapshot();
            },
            onError: report,
          })
          .catch(report);
      }));
    },
    refresh: async () => {
      await refreshSnapshot();
    },
    dispose() {
      abort.abort();
      listeners.clear();
    },
    saveComment: (input) => serialize(() => save(input)),
    persistComment: (input) => serialize(() => save(input)),
    askAgent: (input, requestedHarness) =>
      serialize(async () => {
        if (!input.body.trim()) return;
        const harness = await chooseHarness(requestedHarness);
        const existing = hostThread(input.threadId);
        const draft = drafts.get(input.threadId);
        const target =
          existing?.target ??
          draft?.target ??
          observations.get(input.target) ??
          toHostFeedbackTarget(
            input.target,
            options.getDocument(),
            options.resolveGraphTarget,
          );
        const response = existing
          ? await client.command(
              "question.follow_up",
              {
                reviewId,
                threadId: existing.id,
                reviewVersion: options.getDocument().reviewVersion,
                body: input.body,
                harness,
              },
              { commandId: input.messageId },
            )
          : await client.command(
              "question.start",
              { reviewId, target, body: input.body, harness },
              { commandId: input.messageId },
            );
        const consumesDraft = draft?.body.trim() === input.body.trim();
        aliases.set(
          response.result.thread.id,
          draft && !consumesDraft ? input.messageId : input.threadId,
        );
        targets.set(response.result.thread.id, {
          version: target.reviewVersion,
          target: input.target,
        });
        if (draft && consumesDraft) await removeDraft(draft.id);
        else await refreshSnapshot();
      }),
    deleteLocalComment: (id) => serialize(() => removeDraft(id)),
    deleteComment: (id) => serialize(() => removeDraft(id)),
    deleteCommentMessage: (id, messageId) =>
      serialize(async () => {
        const draft = drafts.get(id);
        if (!draft || (draftMessageIds.get(id) ?? id) !== messageId)
          return immutable();
        await removeDraft(id);
      }),
    updateComment: (id, body, messageId) =>
      serialize(async () => {
        const draft = drafts.get(id);
        if (
          !draft ||
          (messageId && (draftMessageIds.get(id) ?? id) !== messageId)
        )
          return immutable();
        await client.command("draft.save", {
          reviewId,
          draftId: id,
          expectedDraftVersion: draftEditVersions.get(id) ?? draft.draftVersion,
          target: draft.target,
          body,
        });
        draftEditVersions.delete(id);
        await refreshSnapshot();
      }),
    setCommentResolved: (id, resolved) =>
      serialize(async () => {
        const thread = hostThread(id);
        if (!thread)
          throw new Error("Submit this draft before resolving its thread.");
        await client.command("thread.set_status", {
          reviewId,
          threadId: thread.id,
          expectedThreadVersion: thread.threadVersion,
          status: resolved ? "resolved" : "open",
        });
        await refreshSnapshot();
      }),
    flushPendingComments: async () => {
      await writes;
      submitting = new Set(drafts.keys());
      await refreshSnapshot();
      return [...snapshot.localComments.values()].flatMap(
        (entry) => entry.inputs,
      );
    },
    resetPendingComments() {
      submitting.clear();
      void refreshSnapshot().catch(report);
    },
    completeHumanReviewRound() {
      submitting.clear();
      void refreshSnapshot().catch(report);
    },
    terminalOpened(id) {
      notify({
        ...snapshot,
        terminalThreadIds: new Set([...snapshot.terminalThreadIds, id]),
      });
    },
    terminalClosed: async (id) => {
      const terminalThreadIds = new Set(snapshot.terminalThreadIds);
      terminalThreadIds.delete(id);
      notify({ ...snapshot, terminalThreadIds });
    },
    // Host question runs, not terminal notifications, own execution status.
    applyAgentStatus() {},
    submit: (decision, submissionId, inputs) =>
      serialize(async () => {
        let input = submissions.get(submissionId);
        if (!input) {
          const reviewVersion = options.getDocument().reviewVersion;
          // A just-written global summary can arrive with the submission.
          // Save it once through the host, then freeze the exact draft versions
          // and viewed snapshot so retries never recreate already consumed drafts.
          for (const comment of inputs ?? []) {
            const saved = snapshot.localComments.get(comment.threadId);
            if (!saved) {
              if (hostThread(comment.threadId))
                throw new Error(
                  "An already posted comment cannot be submitted as a private draft.",
                );
              await save(comment);
            } else if (
              !saved.inputs.some(
                (item) =>
                  item.messageId === comment.messageId &&
                  item.body === comment.body,
              )
            )
              throw new Error(
                "A selected draft changed. Review it before submitting.",
              );
          }
          const selected = inputs
            ? new Set(inputs.map((item) => item.threadId))
            : new Set(drafts.keys());
          input = {
            reviewId,
            reviewVersion,
            decision,
            drafts: [...selected].map((id) => {
              const draft = drafts.get(id);
              if (!draft)
                throw new Error(
                  "A selected draft changed. Refresh before submitting.",
                );
              return {
                draftId: draft.id,
                expectedDraftVersion: draft.draftVersion,
              };
            }),
          };
          submissions.set(submissionId, input);
        }
        if (input.decision !== decision)
          throw new Error(
            "A submission ID cannot be reused for a different decision.",
          );
        const { result } = await client.command("feedback.submit", input, {
          commandId: submissionId,
        });
        submitting.clear();
        await refreshSnapshot();
        return result;
      }),
  };
  return store;
}

function projectMessage(
  message: HostMessage,
): ReviewCommentThreadRecord["messages"][number] {
  const agent = message.author.kind !== "human";
  return {
    id: message.id,
    by: message.author.displayName,
    at: message.createdAt,
    body: message.body,
    role: agent ? "agent" : "reviewer",
    format: agent ? "markdown" : "plain",
    agentInput: false,
  };
}

async function allPages<T>(
  read: (cursor?: string) => Promise<{
    result: { items: T[]; nextCursor: string | null };
    eventCursor: string;
  }>,
) {
  const first = await read();
  const items = [...first.result.items];
  let cursor = first.result.nextCursor;
  while (cursor) {
    const next = await read(cursor);
    items.push(...next.result.items);
    cursor = next.result.nextCursor;
  }
  return { items, eventCursor: first.eventCursor };
}

export function toHostFeedbackTarget(
  target: ThreadTarget,
  document: HostDocumentState,
  resolveGraph?: HostCommentStoreOptions["resolveGraphTarget"],
): HostFeedbackTarget {
  const reviewVersion =
    target.kind === "code"
      ? (target.documentVersion ?? document.reviewVersion)
      : document.reviewVersion;
  if (target.kind === "document") return { kind: "document", reviewVersion };
  if (target.kind === "code") {
    const head = projectCodeTarget(target, "head");
    const base = projectCodeTarget(target, "base");
    const source = head ?? base;
    if (!source)
      throw new Error(
        "The selected code range cannot be represented on one side of the diff.",
      );
    const side = head ? "head" : "base";
    if (
      !target.commit &&
      target.documentVersion === undefined &&
      source.commit !==
        (side === "head"
          ? document.binding.headCommit
          : document.binding.baseCommit)
    )
      throw new Error(
        "The source selection belongs to an older document. Reopen it before commenting.",
      );
    const result: Extract<HostFeedbackTarget, { kind: "source" }> = {
      kind: "source",
      reviewVersion,
      range: {
        side,
        file: source.path,
        fromLine: source.span.startLine,
        toLine: source.span.endLine,
      },
    };
    if (target.commit) result.comparisonCommit = target.commit;
    return result;
  }
  if (target.kind === "graph") {
    const match =
      resolveGraph?.(target, document) ?? resolveGraphByLabel(target, document);
    if (!match)
      throw new Error("The selected diagram element is no longer available.");
    return match.item
      ? {
          kind: "diagram",
          reviewVersion,
          nodeId: match.nodeId,
          item: match.item,
        }
      : {
          kind: "node",
          reviewVersion,
          nodeId: match.nodeId,
          selection: { quote: target.element.quote },
        };
  }
  if (target.surface.type === "anchor") {
    const anchorId = target.surface.anchorId;
    const anchor = document.definitions[anchorId];
    if (anchor?.kind !== "anchor") {
      const matches = Object.values(document.nodes).flatMap((node) =>
        diagramItems(node)
          .filter((item) => item.id === anchorId)
          .map((item) => ({ nodeId: node.id, item: item.item })),
      );
      if (matches.length === 1)
        return { kind: "diagram", reviewVersion, ...matches[0]! };
      throw new Error("The selected source anchor is no longer available.");
    }
    return { kind: "source", reviewVersion, range: anchor.source };
  }
  const surface = selectionSurface(target);
  const element = surface?.closest<HTMLElement>("[data-host-node-id]");
  const nodeId = element?.dataset.hostNodeId;
  const node = nodeId ? document.nodes[nodeId] : undefined;
  const selection = selectedQuote(target, surface?.textContent ?? "");
  return node
    ? { kind: "node", reviewVersion, nodeId: node.id, selection }
    : { kind: "document", reviewVersion, selection };
}

export function projectHostFeedbackTarget(
  target: HostFeedbackTarget,
  document: HostDocumentState,
  projectGraph?: HostCommentStoreOptions["projectGraphTarget"],
  evidence?: HostSourceQuote | null,
): ThreadTarget {
  if (target.kind === "source") {
    const result: Extract<ThreadTarget, { kind: "code" }> = {
      ...buildCodeTarget({
        path: target.range.file,
        side: target.range.side,
        baseCommit:
          target.comparisonCommit && target.range.side === "base" && evidence
            ? evidence.span.commit
            : document.binding.baseCommit,
        headCommit: target.comparisonCommit ?? document.binding.headCommit,
        span: {
          startLine: target.range.fromLine,
          endLine: target.range.toLine,
        },
      }),
      documentVersion: target.reviewVersion,
    };
    if (target.comparisonCommit) result.commit = target.comparisonCommit;
    return result;
  }
  if (target.kind === "document" && !target.selection)
    return { kind: "document" };
  if (target.kind === "diagram") {
    const resolved = projectGraph?.(target, document);
    if (resolved) return resolved;
    const node = document.nodes[target.nodeId];
    const item = node
      ? diagramItems(node).find(
          (item) => diagramItemKey(item.item) === diagramItemKey(target.item),
        )
      : undefined;
    return buildGraphTarget({
      diagram:
        node && "title" in node && node.title ? node.title : target.nodeId,
      type: "node",
      path: [diagramItemKey(target.item)],
      payload: { nodeId: target.nodeId, item: target.item },
      quote: item?.label ?? diagramItemKey(target.item),
    });
  }
  const node = "nodeId" in target ? document.nodes[target.nodeId] : undefined;
  const selection = "selection" in target ? target.selection : undefined;
  const quote = selection?.quote ?? (node ? nodeText(node) : "Review document");
  const root =
    typeof globalThis.document === "undefined" ? null : globalThis.document;
  const scope =
    "nodeId" in target
      ? [
          ...(root?.querySelectorAll<HTMLElement>("[data-host-node-id]") ?? []),
        ].find((element) => element.dataset.hostNodeId === target.nodeId)
      : root?.querySelector<HTMLElement>(".review-document");
  const blocks = [
    ...(scope?.querySelectorAll<HTMLElement>(
      "[data-review-block-index], [data-review-table][data-review-row][data-review-column]",
    ) ?? []),
  ];
  const matches = blocks.flatMap((block) => {
    const text = block.textContent ?? "";
    const positions: number[] = [];
    for (
      let start = text.indexOf(quote);
      quote && start >= 0;
      start = text.indexOf(quote, start + 1)
    )
      if (
        (!selection?.prefix ||
          text.slice(0, start).endsWith(selection.prefix)) &&
        (!selection?.suffix ||
          text.slice(start + quote.length).startsWith(selection.suffix))
      )
        positions.push(start);
    return positions.map((start) => ({ block, text, start }));
  });
  if (matches.length === 1) {
    const { block, text, start } = matches[0]!;
    if (block.dataset.reviewTable !== undefined)
      return buildTableCellTarget({
        table: Number(block.dataset.reviewTable),
        row: Number(block.dataset.reviewRow),
        column: Number(block.dataset.reviewColumn),
        text,
        start,
        length: quote.length,
      });
    return buildBlockTarget({
      tag: block.dataset.reviewBlockTag ?? block.tagName.toLowerCase(),
      index: Number(block.dataset.reviewBlockIndex),
      text,
      start,
      length: quote.length,
    });
  }
  if ("nodeId" in target)
    return buildBlockTarget({
      tag: `review-node:${target.nodeId}`,
      index: 0,
      text: quote || target.nodeId,
      start: 0,
      length: (quote || target.nodeId).length,
    });
  // The old target resolver searches this retained quote conservatively and
  // marks it outdated if it is gone or ambiguous; never invent a new quote.
  return buildDocumentTextTarget({
    text: quote || node?.id || "Review document",
    start: 0,
    length: (quote || node?.id || "Review document").length,
  });
}

function selectedQuote(
  target: Extract<ThreadTarget, { kind: "text" }>,
  text: string,
): Selection {
  const { start, length, quote } = target.selection;
  return {
    quote,
    prefix: text.slice(Math.max(0, start - 128), start),
    suffix: text.slice(start + length, start + length + 128),
  };
}
function selectionSurface(
  target: Extract<ThreadTarget, { kind: "text" }>,
): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const surface = target.surface;
  if (surface.type === "block")
    return document.querySelector(
      `[data-review-block-index="${surface.index}"]`,
    );
  if (surface.type === "table-cell")
    return document.querySelector(
      `[data-review-table="${surface.table}"][data-review-row="${surface.row}"][data-review-column="${surface.column}"]`,
    );
  return null;
}
function nodeText(node: HostNode): string {
  if ("content" in node)
    return node.content
      .map((part) => ("text" in part ? part.text : "\n"))
      .join("");
  if ("text" in node) return node.text;
  if ("title" in node && node.title) return node.title;
  if (node.type === "markdown") return node.markdown;
  if (node.type === "image") return node.alt;
  return node.id;
}
function diagramItems(
  node: HostNode,
): { id: string; label?: string; item: HostDiagramItem }[] {
  if (node.type === "sequence")
    return [
      ...[
        ...new Set(
          node.messages.flatMap((message) => [
            message.fromActorId,
            message.toActorId,
          ]),
        ),
      ].map((actorId) => ({
        id: actorId,
        item: { kind: "actor" as const, actorId },
      })),
      ...node.messages.map((message) => ({
        ...message,
        item: { kind: "message" as const, messageId: message.id },
      })),
    ];
  if (node.type === "call_stack_diff")
    return [
      ...node.base.map((frame) => ({
        ...frame,
        item: {
          kind: "frame" as const,
          side: "base" as const,
          frameId: frame.id,
        },
      })),
      ...node.head.map((frame) => ({
        ...frame,
        item: {
          kind: "frame" as const,
          side: "head" as const,
          frameId: frame.id,
        },
      })),
    ];
  if (node.type === "database_lens")
    return node.useCases.flatMap((useCase) => [
      {
        id: useCase.id,
        label: useCase.label,
        item: { kind: "use_case" as const, useCaseId: useCase.id },
      },
      ...useCase.operations.map((operation) => ({
        ...operation,
        item: {
          kind: "operation" as const,
          useCaseId: useCase.id,
          operationId: operation.id,
        },
      })),
    ]);
  return [];
}
function diagramItemKey(item: HostDiagramItem): string {
  switch (item.kind) {
    case "actor":
      return `actor:${item.actorId}`;
    case "message":
      return `message:${item.messageId}`;
    case "frame":
      return `frame:${item.side}:${item.frameId}`;
    case "use_case":
      return `use_case:${item.useCaseId}`;
    case "operation":
      return `operation:${item.useCaseId}:${item.operationId}`;
    case "map_element":
      return `map_element:${item.elementId}`;
    case "map_relationship":
      return `map_relationship:${item.relationshipId}`;
  }
}
function resolveGraphByLabel(
  target: Extract<ThreadTarget, { kind: "graph" }>,
  document: HostDocumentState,
) {
  const matches = Object.values(document.nodes).filter(
    (node) =>
      node.id === target.diagram ||
      ("title" in node && node.title === target.diagram),
  );
  if (matches.length !== 1) return null;
  const node = matches[0]!;
  const items = diagramItems(node).filter(
    (item) =>
      target.element.path.includes(item.id) ||
      item.label === target.element.quote,
  );
  if (items.length === 1) return { nodeId: node.id, item: items[0]!.item };
  return { nodeId: node.id };
}
