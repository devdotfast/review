import type { JsonValue } from "@dev.fast/json";

/** List metadata only: document contents and repository paths stay on the host. */
export interface ReviewApiSummary {
  reviewId: string;
  version: number;
  title: string;
  pins: { repositoryId: string; base: string; head: string };
  createdAt: string;
  repositoryName: string;
  viewedAt: string | null;
  dismissedAt: string | null;
  commentCount: number;
  decision: "approve" | "request-changes" | null;
}

export interface ReviewSourceEntry {
  path: string;
  kind: "file" | "directory";
}

type Subscription = { reviewId: string | null; part: "document" | "feedback" };

type Request = (url: string, init?: RequestInit) => Promise<Response>;

const defaultRequest: Request = (url, init) => fetch(url, init);

// One live connection per transport/server, shared by mounted canvases.
const liveConnections = new WeakMap<Request, Map<string, LiveConnection>>();

/** Shared by the canvas and thin agent clients; no filesystem or SQL access. */
export class ReviewApiClient {
  constructor(
    readonly connection: { serverUrl: string; token: string },
    private readonly request: Request = defaultRequest,
  ) {}
  async response(route: string, init?: RequestInit) {
    const headers = new Headers(init?.headers);
    headers.set("x-review-token", this.connection.token);

    if (init?.body) headers.set("content-type", "application/json");

    const response = await this.request(
      `${this.connection.serverUrl}/reviews-api${route}`,
      { ...init, headers },
    );

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error(
        (body?.error ?? `Review request failed (${response.status}).`) +
          (body?.issues ? `\n${JSON.stringify(body.issues)}` : ""),
      );
    }

    return response;
  }
  async read<T>(route: string, signal?: AbortSignal): Promise<T> {
    return (await this.response(route, { signal })).json();
  }
  async post<T>(
    route: string,
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- JSON transport boundary; the selected host route parses its input schema.
    input: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    return (
      await this.response(route, {
        method: "POST",
        body: JSON.stringify(input),
        signal,
      })
    ).json();
  }
  async *watch<T = unknown>(
    reviewId: string | null | Subscription[],
    signal: AbortSignal,
    part: "document" | "feedback" = "document",
  ): AsyncGenerator<T> {
    const response = await this.response(
      Array.isArray(reviewId)
        ? `/watch?subscriptions=${encodeURIComponent(JSON.stringify(reviewId))}`
        : reviewId === null
          ? "/watch"
          : `/${encodeURIComponent(reviewId)}/${part === "feedback" ? "feedback/" : ""}watch`,
      { signal },
    );

    const reader = response
      .body!.pipeThrough(new TextDecoderStream())
      .getReader();

    const cancel = () => {
      void reader.cancel().catch(() => {});
    };

    signal.addEventListener("abort", cancel, { once: true });

    if (signal.aborted) cancel();
    let pending = "";

    try {
      while (true) {
        const { value, done } = await reader.read();

        if (done) return;
        pending += value;
        let end: number;

        while ((end = pending.indexOf("\n")) !== -1) {
          // SAFETY: the authenticated host serializes the snapshot type requested by this caller.
          yield JSON.parse(pending.slice(0, end)) as T;
          pending = pending.slice(end + 1);
        }
      }
    } finally {
      signal.removeEventListener("abort", cancel);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  async follow<T>(
    reviewId: string | null,
    signal: AbortSignal,
    part: "document" | "feedback",
    accept: (snapshot: T) => void | Promise<void>,
    disconnected: (cause: unknown) => void,
  ) {
    if (signal.aborted) return;
    let connections = liveConnections.get(this.request);

    if (!connections)
      liveConnections.set(this.request, (connections = new Map()));

    const key = JSON.stringify([
      this.connection.serverUrl,
      this.connection.token,
    ]);

    let live = connections.get(key);

    if (!live) {
      live = new LiveConnection(this, () => connections.delete(key));
      connections.set(key, live);
    }

    return live.add(
      { reviewId, part },
      signal,
      // SAFETY: this listener requests the review/part whose snapshot type is T.
      (value) => accept(value as T),
      disconnected,
    );
  }
}

type Listener = {
  subscription: Subscription;
  accept(value: JsonValue | undefined): void | Promise<void>;
  disconnected(cause: unknown): void;
};

class LiveConnection {
  private readonly listeners = new Set<Listener>();
  private abort = new AbortController();
  private running = Promise.resolve();
  constructor(
    private readonly client: ReviewApiClient,
    private readonly empty: () => void,
  ) {}

  add(
    subscription: Subscription,
    signal: AbortSignal,
    accept: Listener["accept"],
    disconnected: Listener["disconnected"],
  ) {
    const listener = { subscription, accept, disconnected };
    this.listeners.add(listener);
    this.restart();

    return new Promise<void>((resolve) => {
      const stop = () => {
        signal.removeEventListener("abort", stop);
        this.listeners.delete(listener);
        this.restart();

        if (!this.listeners.size) this.empty();
        resolve();
      };

      signal.addEventListener("abort", stop, { once: true });

      if (signal.aborted) stop();
    });
  }

  private restart() {
    this.abort.abort();
    this.abort = new AbortController();
    const { signal } = this.abort;
    const listeners = [...this.listeners];
    // Finish an in-flight render before delivering a replacement stream's state.
    this.running = this.running.then(async () => {
      if (listeners.length && !signal.aborted)
        await this.run(listeners, signal);
    });
  }

  private async run(listeners: Listener[], signal: AbortSignal) {
    const disconnected = (cause: unknown) =>
      listeners.forEach((listener) => listener.disconnected(cause));

    while (!signal.aborted) {
      try {
        for await (const values of this.client.watch<
          Array<{ value?: JsonValue; error?: string }>
        >(
          listeners.map((item) => item.subscription),
          signal,
        )) {
          if (signal.aborted) break;
          await Promise.all(
            listeners.map(async (listener, index) => {
              const result = values[index]!;

              try {
                if (result.error) throw new Error(result.error);
                await listener.accept(result.value);
              } catch (error) {
                if (!signal.aborted) listener.disconnected(error);
              }
            }),
          );
        }

        if (!signal.aborted) disconnected(new Error("Connection closed."));
      } catch (error) {
        if (!signal.aborted) disconnected(error);
      }

      if (!signal.aborted)
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
          };

          const timer = setTimeout(done, 1000);
          signal.addEventListener("abort", done, { once: true });
        });
    }
  }
}
