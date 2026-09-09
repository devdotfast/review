import type { ReviewThreadsService } from "../review-threads-service";
import type {
  SessionRef,
  SessionUpdate,
  SessionUpdateStream,
} from "./native-session";

interface NativeMessageMirrorOptions {
  updates(binding: SessionRef): Promise<SessionUpdateStream>;
  service: ReviewThreadsService;
  onStatus(
    threadId: string,
    update: Extract<SessionUpdate, { type: "status.changed" }>,
  ): void;
  onError?: (cause: unknown) => void;
}

/** Persists only messages captured during the Review interaction. */
export class NativeMessageMirror {
  readonly #options: NativeMessageMirrorOptions;
  readonly #watchers = new Map<
    string,
    { binding: SessionRef; pipe: SessionUpdateStream; task: Promise<void> }
  >();

  constructor(options: NativeMessageMirrorOptions) {
    this.#options = options;
  }

  async watch(threadId: string, binding: SessionRef): Promise<void> {
    const existing = this.#watchers.get(threadId);
    if (existing) {
      if (
        existing.binding.sessionId !== binding.sessionId ||
        existing.binding.harness !== binding.harness
      )
        throw new Error(
          "The comment already observes a different native session.",
        );
      return;
    }
    const pipe = await this.#options.updates(binding);
    const watcher = { binding, pipe, task: Promise.resolve() };
    this.#watchers.set(threadId, watcher);
    watcher.task = (async () => {
      for await (const update of pipe.updates) {
        if (this.#watchers.get(threadId) !== watcher) return;
        if (update.type === "status.changed") {
          this.#options.onStatus(threadId, update);
          continue;
        }
        const message = update.message;
        const snapshot = this.#options.service.snapshot();
        const thread =
          snapshot.drafts[threadId]?.thread ?? snapshot.comments[threadId];
        if (!thread || thread.agentSession?.sessionId !== binding.sessionId)
          return;
        // The submitted Ask already exists. Its Review ID travels through capture.
        if (thread.messages.some((item) => item.id === message.id)) continue;
        this.#options.service.upsertAgentSessionMessage({
          mutationId: message.id,
          threadId,
          messageId: message.id,
          role: message.role === "assistant" ? "agent" : "reviewer",
          author: binding.harness,
          body: message.body,
          createdAt: message.createdAt,
          agentInput: false,
        });
      }
    })()
      .catch((cause) => {
        this.#options.onStatus(threadId, {
          type: "status.changed",
          status: "failed",
          error: String(cause),
        });
        this.#options.onError?.(cause);
      })
      .finally(() => {
        if (this.#watchers.get(threadId) === watcher)
          this.#watchers.delete(threadId);
      });
  }

  async close(): Promise<void> {
    const watchers = [...this.#watchers.values()];
    this.#watchers.clear();
    await Promise.all(
      watchers.map(async (watcher) => {
        await watcher.pipe.close();
        await watcher.task;
      }),
    );
  }
}
