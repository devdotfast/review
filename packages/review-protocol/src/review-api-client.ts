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

/** A non-2xx reply; the status tells a caller whether retrying can help. */
export class ReviewApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ReviewApiError";
  }
}

/** Shared by the canvas and thin agent clients; no filesystem or SQL access. */
export class ReviewApiClient {
  constructor(
    readonly connection: { serverUrl: string; token: string },
    private readonly request: (
      url: string,
      init?: RequestInit,
    ) => Promise<Response> = (url, init) => fetch(url, init),
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
    reviewId: string | null,
    signal: AbortSignal,
  ): AsyncGenerator<T> {
    const response = await this.response(
      reviewId === null ? "/watch" : `/${encodeURIComponent(reviewId)}/watch`,
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
          // SAFETY: the authenticated host serializes the requested review snapshot.
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
    let delay = 1000;
    while (!signal.aborted) {
      try {
        for await (const next of this.watch<T>(reviewId, signal)) {
          delay = 1000;
          await accept(next);
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

      if (!signal.aborted)
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
          };

          const timer = setTimeout(done, delay);
          signal.addEventListener("abort", done, { once: true });
        });
      delay = Math.min(delay * 2, 30_000);
    }
  }
}
