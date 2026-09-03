import { randomUUID } from "node:crypto";

import type {
  ReviewCommentAgentSession,
  ReviewCommentMessage,
} from "@dev.fast/review-protocol";

import { reviewCommentPromptPrefix } from "../review-comment-agent";
import type { ReviewThreadsService } from "../review-threads-service";
import type {
  NativeReviewMessage,
  ObservedNativeSession,
  ReviewThreadAgentBinding,
} from "./native-session";

interface NativeMessageMirrorOptions {
  observe(binding: ReviewThreadAgentBinding): ObservedNativeSession;
  service: ReviewThreadsService;
  onError?: (cause: unknown) => void;
}

interface SessionWatcher {
  key: string;
  inReviewConversation: boolean;
  threadCursor: number;
  pipe?: Awaited<ReturnType<ObservedNativeSession["updates"]>>;
  task: Promise<void>;
}

/** Mirrors native user and final assistant messages into Review threads. */
export class NativeMessageMirror {
  readonly #observe: NativeMessageMirrorOptions["observe"];
  readonly #service: ReviewThreadsService;
  readonly #onError: (cause: unknown) => void;
  readonly #watchers = new Map<string, SessionWatcher>();
  #closed = false;

  constructor(options: NativeMessageMirrorOptions) {
    this.#observe = options.observe;
    this.#service = options.service;
    this.#onError = options.onError ?? ((cause) => console.error(cause));
  }

  start(): void {
    const snapshot = this.#service.snapshot();
    for (const [threadId, comment] of Object.entries(snapshot.comments)) {
      if (isNativeBinding(comment.agentSession)) {
        this.watch(threadId, comment.agentSession);
      }
    }
    for (const [threadId, draft] of Object.entries(snapshot.drafts)) {
      if (isNativeBinding(draft.thread.agentSession)) {
        this.watch(threadId, draft.thread.agentSession);
      }
    }
  }

  watch(threadId: string, binding: ReviewThreadAgentBinding): void {
    if (this.#closed) return;
    const key = `${binding.harness}:${binding.sessionId}`;
    if (this.#watchers.get(threadId)?.key === key) return;
    void this.#stopWatcher(threadId);
    const watcher = {
      key,
      inReviewConversation: false,
      threadCursor: 0,
      task: Promise.resolve(),
    } satisfies SessionWatcher;
    watcher.task = this.#mirror(threadId, binding, watcher).catch(
      this.#onError,
    );
    this.#watchers.set(threadId, watcher);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.allSettled(
      [...this.#watchers.keys()].map((threadId) => this.#stopWatcher(threadId)),
    );
  }

  async #mirror(
    threadId: string,
    binding: ReviewThreadAgentBinding,
    watcher: SessionWatcher,
  ): Promise<void> {
    const pipe = await this.#observe(binding).updates();
    watcher.pipe = pipe;
    try {
      for (const message of pipe.snapshot.messages) {
        if (this.#watchers.get(threadId) !== watcher) return;
        this.#apply(threadId, binding, message, watcher);
      }
      for await (const update of pipe.updates) {
        if (this.#watchers.get(threadId) !== watcher) return;
        this.#apply(threadId, binding, update.message, watcher);
      }
    } finally {
      await pipe.close();
    }
  }

  #apply(
    threadId: string,
    binding: ReviewThreadAgentBinding,
    message: NativeReviewMessage,
    watcher: SessionWatcher,
  ): void {
    if (!watcher.inReviewConversation) {
      if (
        message.role !== "user" ||
        !message.body.startsWith(reviewCommentPromptPrefix(threadId))
      ) {
        return;
      }
      watcher.inReviewConversation = true;
    }
    const thread = this.#currentThread(threadId);
    if (thread?.agentSession?.sessionId !== binding.sessionId) return;
    const body =
      message.role === "user"
        ? reviewQuestionBody(threadId, message.body)
        : message.body;
    const match = findConversationMessage(
      thread.messages,
      watcher.threadCursor,
      message.role === "assistant" ? "agent" : "reviewer",
      body,
      message.role === "user" &&
        message.body.startsWith(reviewCommentPromptPrefix(threadId)),
    );
    if (match) watcher.threadCursor = match.index + 1;
    const messageId = match?.message.id ?? randomUUID();
    this.#service.upsertAgentSessionMessage({
      mutationId: randomUUID(),
      threadId,
      messageId,
      role: message.role === "assistant" ? "agent" : "reviewer",
      ...(message.role === "assistant"
        ? { author: agentLabel(binding.harness) }
        : {}),
      body: match?.message.body ?? body,
      createdAt: message.createdAt,
      agentInput: match?.message.agentInput ?? false,
    });
    if (!match) {
      const updated = this.#currentThread(threadId);
      const index = updated?.messages.findIndex(
        (candidate) => candidate.id === messageId,
      );
      if (index !== undefined && index >= 0) watcher.threadCursor = index + 1;
    }
  }

  #currentThread(threadId: string) {
    const snapshot = this.#service.snapshot();
    return snapshot.drafts[threadId]?.thread ?? snapshot.comments[threadId];
  }

  async #stopWatcher(threadId: string): Promise<void> {
    const watcher = this.#watchers.get(threadId);
    if (!watcher) return;
    this.#watchers.delete(threadId);
    await watcher.pipe?.close();
    await watcher.task;
  }
}

function isNativeBinding(
  session: ReviewCommentAgentSession | undefined,
): session is ReviewThreadAgentBinding {
  return Boolean(session?.harness && session.sessionId);
}

function findConversationMessage(
  messages: readonly ReviewCommentMessage[],
  fromIndex: number,
  role: "reviewer" | "agent",
  body: string,
  preferAgentInput: boolean,
): { index: number; message: ReviewCommentMessage } | undefined {
  const matches = (message: ReviewCommentMessage): boolean =>
    (message.role ?? "reviewer") === role &&
    message.body.trim() === body.trim();
  if (preferAgentInput) {
    const index = messages.findIndex(
      (message, candidateIndex) =>
        candidateIndex >= fromIndex &&
        message.agentInput === true &&
        matches(message),
    );
    if (index >= 0) return { index, message: messages[index]! };
  }
  const index = messages.findIndex(
    (message, candidateIndex) =>
      candidateIndex >= fromIndex && matches(message),
  );
  return index >= 0 ? { index, message: messages[index]! } : undefined;
}

function reviewQuestionBody(threadId: string, body: string): string {
  const prefix = reviewCommentPromptPrefix(threadId);
  return body.startsWith(prefix) ? body.slice(prefix.length) : body;
}

function agentLabel(harness: ReviewThreadAgentBinding["harness"]): string {
  switch (harness) {
    case "claude-code":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "pi":
      return "Pi";
  }
}
