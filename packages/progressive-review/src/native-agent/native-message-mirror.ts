import { randomUUID } from "node:crypto";

import type { ReviewCommentAgentSession } from "@dev.fast/review-protocol";

import type { ReviewThreadsService } from "../review-threads-service";
import type {
  NativeReviewMessage,
  SessionRef,
  SessionSnapshot,
  SessionUpdate,
  UpdatePipe,
} from "./native-session";

interface NativeMessageMirrorOptions {
  updates(
    binding: ReviewCommentAgentSession,
  ): Promise<UpdatePipe<SessionSnapshot, SessionUpdate>>;
  service: ReviewThreadsService;
  onError?: (cause: unknown) => void;
}

interface SessionWatcher {
  key: string;
  inReviewConversation: boolean;
  pipe?: UpdatePipe<SessionSnapshot, SessionUpdate>;
  task: Promise<void>;
}

/** Mirrors native user and final assistant messages into Review threads. */
export class NativeMessageMirror {
  readonly #updates: NativeMessageMirrorOptions["updates"];
  readonly #service: ReviewThreadsService;
  readonly #onError: (cause: unknown) => void;
  readonly #watchers = new Map<string, SessionWatcher>();
  #closed = false;

  constructor(options: NativeMessageMirrorOptions) {
    this.#updates = options.updates;
    this.#service = options.service;
    this.#onError = options.onError ?? ((cause) => console.error(cause));
  }

  start(): void {
    const snapshot = this.#service.snapshot();
    for (const [threadId, comment] of Object.entries(snapshot.comments)) {
      if (comment.agentSession) {
        this.watch(threadId, comment.agentSession);
      }
    }
    for (const [threadId, draft] of Object.entries(snapshot.drafts)) {
      if (draft.thread.agentSession) {
        this.watch(threadId, draft.thread.agentSession);
      }
    }
  }

  watch(threadId: string, binding: ReviewCommentAgentSession): void {
    if (this.#closed) return;
    const key = `${binding.harness}:${binding.sessionId}:${binding.firstMessageId}`;
    if (this.#watchers.get(threadId)?.key === key) return;
    void this.#stopWatcher(threadId);
    const watcher = {
      key,
      inReviewConversation: false,
      task: Promise.resolve(),
    } satisfies SessionWatcher;
    watcher.task = this.#mirror(threadId, binding, watcher)
      .catch(this.#onError)
      .finally(() => {
        if (this.#watchers.get(threadId) === watcher)
          this.#watchers.delete(threadId);
      });
    this.#watchers.set(threadId, watcher);
  }

  async pause(threadId: string): Promise<void> {
    await this.#stopWatcher(threadId);
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
    binding: ReviewCommentAgentSession,
    watcher: SessionWatcher,
  ): Promise<void> {
    const pipe = await this.#updates(binding);
    watcher.pipe = pipe;
    try {
      if (this.#watchers.get(threadId) !== watcher) return;
      if (pipe.snapshot.sessionId !== binding.sessionId) {
        throw new Error(
          "The agent returned a different session for this Review conversation.",
        );
      }
      for (const message of pipe.snapshot.messages) {
        if (this.#watchers.get(threadId) !== watcher) return;
        this.#apply(threadId, binding, message, watcher);
      }
      for await (const update of pipe.updates) {
        if (this.#watchers.get(threadId) !== watcher) return;
        if (update.type !== "message.updated") continue;
        this.#apply(threadId, binding, update.message, watcher);
      }
      if (
        this.#watchers.get(threadId) === watcher &&
        !watcher.inReviewConversation
      ) {
        throw new Error(
          `The agent stream ended without the Review message ${binding.firstMessageId}.`,
        );
      }
    } finally {
      await pipe.close();
    }
  }

  #apply(
    threadId: string,
    binding: ReviewCommentAgentSession,
    message: NativeReviewMessage,
    watcher: SessionWatcher,
  ): void {
    if (!watcher.inReviewConversation) {
      if (message.id !== binding.firstMessageId) return;
      if (message.role !== "user") {
        throw new Error(
          "The Review conversation boundary must identify a user message.",
        );
      }
      watcher.inReviewConversation = true;
    }
    const thread = this.#currentThread(threadId);
    if (
      !thread?.agentSession ||
      thread.agentSession.harness !== binding.harness ||
      thread.agentSession.sessionId !== binding.sessionId ||
      thread.agentSession.firstMessageId !== binding.firstMessageId
    )
      return;
    const existing = thread.messages.find(
      (candidate) =>
        candidate.agentMessage?.sessionId === binding.sessionId &&
        candidate.agentMessage.messageId === message.id,
    );
    // Ask messages already exist in Review. Their native IDs are bound on
    // acceptance, so the instruction-bearing prompt is never copied back.
    if (existing?.agentInput) return;
    this.#service.upsertAgentSessionMessage({
      mutationId: randomUUID(),
      threadId,
      messageId: existing ? existing.id : randomUUID(),
      role: message.role === "assistant" ? "agent" : "reviewer",
      author: agentLabel(binding.harness),
      body: message.body,
      createdAt: message.createdAt,
      agentInput: false,
      agentMessage: { sessionId: binding.sessionId, messageId: message.id },
    });
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

function agentLabel(harness: SessionRef["harness"]): string {
  switch (harness) {
    case "claude-code":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "opencode":
      return "OpenCode";
    case "pi":
      return "Pi";
  }
}
