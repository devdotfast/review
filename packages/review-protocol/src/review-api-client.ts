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
}

export interface ReviewSourceEntry {
  path: string;
  kind: "file" | "directory";
}

type Subscription = { reviewId: string | null };

type Request = (url: string, init?: RequestInit) => Promise<Response>;

const defaultRequest: Request = (url, init) => fetch(url, init);

/** A non-2xx reply; the status tells a caller whether retrying can help. */
export class ReviewApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ReviewApiError";
  }
}

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
      throw new ReviewApiError(
        body?.error ?? `Review request failed (${response.status}).`,
        response.status,
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
  ): AsyncGenerator<T> {
    const response = await this.response(
      Array.isArray(reviewId)
        ? `/watch?subscriptions=${encodeURIComponent(JSON.stringify(reviewId))}`
        : reviewId === null
          ? "/watch"
          : `/${encodeURIComponent(reviewId)}/watch`,
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
      { reviewId },
      signal,
      // SAFETY: this listener requests the review whose snapshot type is T.
      (value) => accept(value as T),
      disconnected,
    );
  }
}

type Result = { value?: JsonValue; error?: string } | null;

type Listener = {
  subscription: Subscription;
  signal: AbortSignal;
  accept(value: JsonValue | undefined): void | Promise<void>;
  disconnected(cause: unknown): void;
  /** The newest undelivered result; replaced rather than queued while a render runs. */
  queued?: Exclude<Result, null>;
  draining?: boolean;
};

// Tabs mounting in separate frames share one replacement stream.
const restartDelayMs = 20;

const retryDelayMs = 1000;

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };

    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

function report(listener: Listener, cause: unknown) {
  if (listener.signal.aborted) return;

  try {
    listener.disconnected(cause);
  } catch {
    // One tab's handler must not take the shared stream down for the others.
  }
}

class LiveConnection {
  private readonly listeners = new Set<Listener>();
  private abort = new AbortController();
  private active = false;
  private scheduled: ReturnType<typeof setTimeout> | undefined;
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
    const listener: Listener = { subscription, signal, accept, disconnected };
    this.listeners.add(listener);
    this.restart();

    return new Promise<void>((resolve) => {
      const stop = () => {
        signal.removeEventListener("abort", stop);
        this.listeners.delete(listener);

        if (this.listeners.size) this.restart();
        else {
          clearTimeout(this.scheduled);
          this.scheduled = undefined;
          this.abort.abort();
          this.active = false;
          this.empty();
        }

        resolve();
      };

      signal.addEventListener("abort", stop, { once: true });

      if (signal.aborted) stop();
    });
  }

  /** The first tab connects at once; later tabs share one replacement stream. */
  private restart() {
    if (this.scheduled) return;

    if (!this.active) {
      this.reconnect();

      return;
    }

    this.scheduled = setTimeout(() => {
      this.scheduled = undefined;
      this.reconnect();
    }, restartDelayMs);
  }

  private reconnect() {
    this.abort.abort();
    this.abort = new AbortController();
    const listeners = [...this.listeners];
    this.active = listeners.length > 0;

    if (this.active) void this.run(listeners, this.abort.signal);
  }

  private async run(listeners: Listener[], signal: AbortSignal) {
    const disconnected = (cause: unknown) =>
      listeners.forEach((listener) => report(listener, cause));

    let delay = 1000;

    while (!signal.aborted) {
      try {
        for await (const results of this.client.watch<Result[]>(
          listeners.map((item) => item.subscription),
          signal,
        )) {
          if (signal.aborted) break;
          delay = 1000;

          listeners.forEach((listener, index) => {
            const result = results[index];

            // null marks a subscription unchanged since the previous line.
            if (result) this.deliver(listener, result);
          });
        }

        if (!signal.aborted) disconnected(new Error("Connection closed."));
      } catch (error) {
        if (!signal.aborted) disconnected(error);
        if (
          error instanceof ReviewApiError &&
          [401, 403, 404].includes(error.status)
        )
          return;
      }

      if (!signal.aborted) await sleep(delay, signal);
      delay = Math.min(delay * 2, 30_000);
    }
  }

  /** Renders never block the stream: a slow tab only delays its own newest state. */
  private deliver(listener: Listener, result: Exclude<Result, null>) {
    listener.queued = result;

    if (listener.draining) return;
    listener.draining = true;

    void (async () => {
      while (listener.queued && !listener.signal.aborted) {
        const next = listener.queued;
        listener.queued = undefined;

        if (next.error) {
          report(listener, new Error(next.error));
          continue;
        }

        try {
          await listener.accept(next.value);
        } catch (error) {
          report(listener, error);
          // Retry the same snapshot after the delay unless a newer one arrived.
          await sleep(retryDelayMs, listener.signal);
          listener.queued ??= next;
        }
      }

      listener.draining = false;
    })();
  }
}
