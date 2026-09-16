import type { Snapshot } from "./store.js";

/** Shared by the canvas and thin agent clients; no filesystem or SQL access. */
export class ReviewApiClient {
  constructor(
    readonly connection: { serverUrl: string; token: string },
    private readonly request: (
      url: string,
      init?: RequestInit,
    ) => Promise<Response> = fetch,
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
        body?.error ?? `Review request failed (${response.status}).`,
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
  async *watch(
    reviewId: string,
    signal: AbortSignal,
  ): AsyncGenerator<Snapshot> {
    const response = await this.response(
      `/${encodeURIComponent(reviewId)}/watch`,
      { signal },
    );

    const reader = response
      .body!.pipeThrough(new TextDecoderStream())
      .getReader();

    let pending = "";

    try {
      while (true) {
        const { value, done } = await reader.read();

        if (done) return;
        pending += value;
        let end: number;

        while ((end = pending.indexOf("\n")) !== -1) {
          // SAFETY: the authenticated host serializes the requested review snapshot.
          yield JSON.parse(pending.slice(0, end)) as Snapshot;
          pending = pending.slice(end + 1);
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
