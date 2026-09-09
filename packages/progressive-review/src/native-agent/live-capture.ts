import { randomUUID } from "node:crypto";

import { AsyncQueue } from "./async-queue";
import type {
  LaunchInput,
  NativeReviewMessage,
  SessionUpdate,
  SessionUpdateStream,
} from "./native-session";

/** One live observer, shared across terminal launches for the same conversation. */
export class LiveCapture {
  #queue = new AsyncQueue<SessionUpdate>();

  get queue(): AsyncQueue<SessionUpdate> {
    return this.#queue;
  }
  #promptId: string | undefined;
  #launchId: string | undefined;
  #interrupted = false;
  #subscribed = false;
  #seen = new Set<string>();

  launch(prompt: LaunchInput["prompt"]): string {
    if (this.#queue.isClosed) {
      this.#queue = new AsyncQueue<SessionUpdate>();
      this.#subscribed = false;
      this.#seen.clear();
    }
    this.#launchId = randomUUID();
    this.#promptId = prompt?.id;
    this.#interrupted = false;
    return this.#launchId;
  }

  accepts(launchId: string): boolean {
    return (
      !this.#queue.isClosed && !this.#interrupted && launchId === this.#launchId
    );
  }

  message(message: NativeReviewMessage): void {
    if (this.#queue.isClosed || this.#interrupted || this.#seen.has(message.id))
      return;
    this.#seen.add(message.id);
    const id =
      message.role === "user" && this.#promptId ? this.#promptId : message.id;
    if (message.role === "user") this.#promptId = undefined;
    this.queue.push({ type: "message.updated", message: { ...message, id } });
  }

  status(
    status: "running" | "idle" | "interrupted" | "failed",
    error?: string,
  ): void {
    if (this.#queue.isClosed || this.#interrupted) return;
    const update: SessionUpdate = { type: "status.changed", status };
    if (error !== undefined) update.error = error;
    this.queue.push(update);
  }

  interrupt(): void {
    this.status("interrupted");
    this.#interrupted = true;
    this.#promptId = undefined;
  }

  subscribe(): SessionUpdateStream {
    if (this.#subscribed)
      throw new Error("This session already has a message subscriber.");
    this.#subscribed = true;
    const queue = this.#queue;
    return {
      updates: queue,
      close: async () => {
        queue.close();
        if (this.#queue === queue) this.#subscribed = false;
      },
    };
  }
}
