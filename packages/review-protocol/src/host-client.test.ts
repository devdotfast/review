import { describe, expect, it, vi } from "vitest";

import type { HostActivitySnapshot } from "./host-activity.js";
import type { HostReviewCommit, HostReviewWithSnapshot } from "./host-api.js";
import { ReviewClient, applyHostDocumentCommit } from "./host-client.js";
import { type HostQuery, HostQueryBodySchema } from "./host-commands.js";
import type { HostDocumentCommit, HostDocumentState } from "./host-document.js";

const reviewId = "27768987-4d4d-4c6f-885c-4bf783f44c27";
const otherId = "8afbc67c-089e-4d84-95d1-16d5e4710484";
const createdAt = "2026-09-10T12:00:00Z";
const binding = {
  id: reviewId,
  repositoryId: reviewId,
  selector: { kind: "snapshot" as const, ref: "main" },
  baseCommit: "a".repeat(40),
  headCommit: "a".repeat(40),
  createdAt,
};
function snapshot(version = 1): HostDocumentState {
  return {
    schemaVersion: 1,
    reviewId,
    reviewVersion: version,
    roots: ["intro"],
    nodes: {
      intro: { id: "intro", type: "markdown", markdown: `Version ${version}` },
    },
    definitions: {},
    evidence: {},
    binding,
    contentHash: "a".repeat(64),
    createdAt,
  };
}
function patch(version = 2): HostDocumentCommit {
  return {
    reviewId,
    previousReviewVersion: version - 1,
    reviewVersion: version,
    changedNodes: snapshot(version).nodes,
    removedNodeIds: [],
    changedDefinitions: {},
    removedDefinitionIds: [],
    changedEvidence: {},
    removedEvidenceIds: [],
    roots: ["intro"],
    binding,
    contentHash: "b".repeat(64),
    createdAt,
    diagnostics: [],
  };
}
function review(document = snapshot()): HostReviewWithSnapshot {
  return {
    review: {
      id: reviewId,
      repositoryId: reviewId,
      latestReviewVersion: document.reviewVersion,
      stateVersion: 0,
      state: "open",
      deletedAt: null,
      createdAt,
      createdBy: reviewId,
    },
    snapshot: {
      reviewId,
      reviewVersion: document.reviewVersion,
      title: `Review ${document.reviewVersion}`,
      description: "",
      labels: [],
      binding,
      mapVersions: { base: null, head: null },
      createdAt,
      createdBy: reviewId,
      restoredFromReviewVersion: null,
    },
  };
}
function event(version: number, cursor = `cursor-${version}`) {
  return {
    cursor,
    reviewId,
    type: "review.committed",
    payload: reviewCommit(version),
  };
}
function reviewCommit(version: number): HostReviewCommit {
  return {
    reviewId,
    previousReviewVersion: version - 1,
    reviewVersion: version,
    snapshot: review(snapshot(version)).snapshot,
    documentDelta: patch(version),
    diagnostics: [],
  };
}

function server() {
  const streams: {
    url: URL;
    controller: ReadableStreamDefaultController<Uint8Array>;
    signal: AbortSignal;
  }[] = [];
  const queries: { type: string; input: unknown }[] = [];
  let current = snapshot();
  const request = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    expect(new Headers(init?.headers).get("x-review-token")).toBe("secret");
    expect(url.searchParams.has("token")).toBe(false);
    if (url.pathname === "/v1/connection")
      return Response.json({
        ok: true,
        data: {
          apiVersion: 1,
          hostId: reviewId,
          workspaceId: otherId,
          principal: { id: reviewId, kind: "human", displayName: "You" },
        },
      });
    if (url.pathname.endsWith("/queries")) {
      const envelope = HostQueryBodySchema.parse(
        JSON.parse(String(init?.body)),
      );
      queries.push(envelope);
      return Response.json({
        ok: true,
        data: {
          result: envelope.type === "review.get" ? review(current) : current,
          eventCursor: `cursor-${current.reviewVersion}`,
        },
      });
    }
    if (!init?.signal) throw new Error("A stream requires cancellation.");
    const signal = init.signal;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          streams.push({ url, controller, signal });
          signal.addEventListener(
            "abort",
            () => {
              try {
                controller.close();
              } catch {
                /* Already cancelled. */
              }
            },
            { once: true },
          );
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  });
  return {
    streams,
    queries,
    request,
    setSnapshot(document: HostDocumentState) {
      current = document;
    },
    async client(requestOverride: typeof fetch = request) {
      return ReviewClient.connect({
        serverUrl: "http://localhost:4000",
        token: "secret",
        fetch: requestOverride,
        reconnectDelayMs: 1,
      });
    },
    send(index: number, value: ReturnType<typeof event>, fragmented = false) {
      const bytes = new TextEncoder().encode(
        `: heartbeat\r\n\r\nid: ${value.cursor}\r\ndata: ${JSON.stringify(value)}\r\n\r\n`,
      );
      const controller = streams[index]!.controller;
      if (fragmented)
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      else controller.enqueue(bytes);
    },
  };
}

describe("canonical Review client", () => {
  it("delivers metadata-only and canvas edits as complete matching review versions", async () => {
    const host = server();
    const client = await host.client();
    const abort = new AbortController();
    const received: {
      version: number;
      documentVersion: number;
      title: string;
      text: unknown;
    }[] = [];
    const watching = client.watchReview({
      reviewId,
      signal: abort.signal,
      onReview(value) {
        received.push({
          version: value.snapshot.reviewVersion,
          documentVersion: value.document.reviewVersion,
          title: value.snapshot.title,
          text: value.document.nodes.intro,
        });
      },
    });
    try {
      await vi.waitFor(() => expect(host.streams).toHaveLength(1));
      const metadata = event(2);
      metadata.payload.documentDelta = null;
      host.send(0, metadata);
      await vi.waitFor(() => expect(received).toHaveLength(2));
      expect(received[1]).toMatchObject({
        version: 2,
        documentVersion: 2,
        title: "Review 2",
        text: { markdown: "Version 1" },
      });
      host.send(0, event(3));
      await vi.waitFor(() => expect(received).toHaveLength(3));
      expect(received[2]).toMatchObject({
        version: 3,
        documentVersion: 3,
        title: "Review 3",
        text: { markdown: "Version 3" },
      });
      expect(host.queries).toEqual([
        { type: "review.get", input: { reviewId } },
        { type: "document.get", input: { reviewId, reviewVersion: 1 } },
      ]);
    } finally {
      abort.abort();
      await watching;
    }
  });

  it.each([false, true])(
    "rejects oversized multibyte event frames before processing them (terminated: %s)",
    async (terminated) => {
      const host = server();
      const client = await host.client();
      const abort = new AbortController();
      const onError = vi.fn<(error: Error) => void>(() => abort.abort());
      const onEvent = vi.fn<() => void>();
      const watching = client.subscribe({
        after: "cursor-1",
        reviewId,
        signal: abort.signal,
        onEvent,
        onReset: async () => "cursor-1",
        onError,
      });
      try {
        await vi.waitFor(() => expect(host.streams).toHaveLength(1));
        // This is below the limit in characters, but above it in UTF-8 bytes.
        const bytes = new TextEncoder().encode(
          `: ${"é".repeat(600_000)}${terminated ? "\r\n\r\n" : ""}`,
        );
        host.streams[0]!.controller.enqueue(bytes.slice(0, 3));
        host.streams[0]!.controller.enqueue(bytes.slice(3));
        await vi.waitFor(() =>
          expect(onError).toHaveBeenCalledWith(
            expect.objectContaining({
              message: "An event frame exceeds the client size limit.",
            }),
          ),
        );
        expect(onEvent).not.toHaveBeenCalled();
      } finally {
        abort.abort();
        await watching;
      }
    },
  );

  it("marks activity unknown after 45 seconds without a complete frame, with heartbeats extending that deadline", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    let watching: Promise<void> | undefined;
    try {
      const host = server();
      const client = await host.client();
      const activity =
        vi.fn<(activity: HostActivitySnapshot | undefined) => void>();
      const onError = vi.fn<(error: Error) => void>(() => abort.abort());
      watching = client.watchDocument({
        reviewId,
        signal: abort.signal,
        onDocument() {},
        onActivity: activity,
        onError,
      });
      await vi.waitFor(() => expect(host.streams).toHaveLength(1));
      await vi.advanceTimersByTimeAsync(44_000);
      host.streams[0]!.controller.enqueue(
        new TextEncoder().encode(": heartbeat\n\n"),
      );
      await vi.advanceTimersByTimeAsync(44_000);
      expect(onError).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      await watching;
      expect(onError).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "The Review event stream stopped responding.",
        }),
      );
      expect(activity).toHaveBeenLastCalledWith(undefined);
    } finally {
      abort.abort();
      await watching;
      vi.useRealTimers();
    }
  });

  it("receives transient activity without moving the document cursor, and refreshes it after reconnect", async () => {
    const host = server();
    const client = await host.client();
    const abort = new AbortController();
    const activity = vi.fn<(value: HostActivitySnapshot | undefined) => void>();
    const versions: number[] = [];
    const watching = client.watchDocument({
      reviewId,
      signal: abort.signal,
      onDocument: (document) => versions.push(document.reviewVersion),
      onActivity: activity,
    });
    try {
      await vi.waitFor(() => expect(host.streams).toHaveLength(1));
      expect(host.streams[0]!.url.searchParams.get("activity")).toBe("1");
      const active = {
        reviewId,
        workingCount: 1,
        unknownCount: 0,
      };
      host.streams[0]!.controller.enqueue(
        new TextEncoder().encode(
          `event: authoring.activity\ndata: ${JSON.stringify(active)}\n\n`,
        ),
      );
      await vi.waitFor(() => expect(activity).toHaveBeenLastCalledWith(active));
      expect(versions).toEqual([1]);
      host.send(0, event(2));
      await vi.waitFor(() => expect(versions).toEqual([1, 2]));
      host.streams[0]!.controller.close();
      await vi.waitFor(() => expect(host.streams).toHaveLength(2));
      expect(activity).toHaveBeenLastCalledWith(undefined);
      expect(host.streams[1]!.url.searchParams.get("after")).toBe("cursor-2");
      const ended = { ...active, workingCount: 0 };
      host.streams[1]!.controller.enqueue(
        new TextEncoder().encode(
          `event: authoring.activity\ndata: ${JSON.stringify(ended)}\n\n`,
        ),
      );
      await vi.waitFor(() => expect(activity).toHaveBeenLastCalledWith(ended));
      expect(versions).toEqual([1, 2]);
    } finally {
      abort.abort();
      await watching;
    }
  });

  it("does not deliver activity for another review", async () => {
    const host = server();
    const client = await host.client();
    const abort = new AbortController();
    const activity = vi.fn<(value: HostActivitySnapshot | undefined) => void>();
    const onError = vi.fn<(error: Error) => void>(() => abort.abort());
    const watching = client.watchDocument({
      reviewId,
      signal: abort.signal,
      onDocument() {},
      onActivity: activity,
      onError,
    });
    await vi.waitFor(() => expect(host.streams).toHaveLength(1));
    host.streams[0]!.controller.enqueue(
      new TextEncoder().encode(
        `event: authoring.activity\ndata: ${JSON.stringify({ reviewId: otherId, workingCount: 1, unknownCount: 0 })}\n\n`,
      ),
    );
    await watching;
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "The activity belongs to a different review.",
      }),
    );
    expect(activity.mock.calls.every(([value]) => value === undefined)).toBe(
      true,
    );
  });

  it("applies definitions, evidence, tree order and removal as one validated state", () => {
    const before = snapshot();
    const commit = patch();
    commit.changedNodes = {
      replacement: { id: "replacement", type: "code_peek", anchorId: "source" },
    };
    commit.removedNodeIds = ["intro"];
    commit.roots = ["replacement"];
    commit.changedDefinitions = {
      source: {
        kind: "anchor",
        title: "Source",
        source: { side: "head", file: "main.ts", fromLine: 1, toLine: 1 },
      },
    };
    commit.changedEvidence = {
      source: {
        text: "return 1",
        sha256: "a".repeat(64),
        span: {
          repositoryId: reviewId,
          commit: binding.headCommit,
          blob: binding.headCommit,
          file: "main.ts",
          fromLine: 1,
          toLine: 1,
        },
      },
    };
    const after = applyHostDocumentCommit(before, commit);
    expect(after.nodes.intro).toBeUndefined();
    expect(after.roots).toEqual(["replacement"]);
    expect(after.evidence.source?.text).toBe("return 1");
    expect(before.nodes.intro).toBeDefined();
    expect(() =>
      applyHostDocumentCommit(before, { ...commit, roots: ["missing"] }),
    ).toThrow("Node missing does not exist");
    expect(before.reviewVersion).toBe(1);
  });

  it("keeps two streams independent, parses fragmented SSE, deduplicates replay and cancels separately", async () => {
    const host = server();
    const client = await host.client();
    const first = new AbortController();
    const second = new AbortController();
    const firstVersions: number[] = [];
    const secondVersions: number[] = [];
    const one = client.watchDocument({
      reviewId,
      signal: first.signal,
      onDocument: (document) => firstVersions.push(document.reviewVersion),
    });
    const two = client.watchDocument({
      reviewId,
      signal: second.signal,
      onDocument: (document) => secondVersions.push(document.reviewVersion),
    });
    await vi.waitFor(() => expect(host.streams).toHaveLength(2));
    host.send(0, event(2), true);
    host.send(0, event(2));
    await vi.waitFor(() => expect(firstVersions).toEqual([1, 2]));
    expect(secondVersions).toEqual([1]);
    first.abort();
    await one;
    host.send(1, event(2));
    await vi.waitFor(() => expect(secondVersions).toEqual([1, 2]));
    second.abort();
    await two;
  });

  it("reconnects from its cursor and refetches a snapshot on a version gap without publishing partial state", async () => {
    const host = server();
    const client = await host.client();
    const abort = new AbortController();
    const versions: number[] = [];
    const watching = client.watchDocument({
      reviewId,
      signal: abort.signal,
      onDocument: (document) => versions.push(document.reviewVersion),
    });
    await vi.waitFor(() => expect(host.streams).toHaveLength(1));
    host.send(0, event(2));
    await vi.waitFor(() => expect(versions).toEqual([1, 2]));
    host.streams[0]!.controller.close();
    await vi.waitFor(() => expect(host.streams).toHaveLength(2));
    expect(host.streams[1]!.url.searchParams.get("after")).toBe("cursor-2");
    host.setSnapshot(snapshot(5));
    host.send(1, event(4));
    host.send(1, event(5));
    await vi.waitFor(() => expect(versions).toEqual([1, 2, 5]));
    await vi.waitFor(() => expect(host.streams).toHaveLength(3));
    expect(host.streams[2]!.url.searchParams.get("after")).toBe("cursor-5");
    expect(host.queries).toHaveLength(4);
    abort.abort();
    await watching;
  });

  it("keeps historical material fixed while following the latest-version pointer", async () => {
    const host = server();
    const client = await host.client();
    const received: number[] = [];
    const abort = new AbortController();
    const watching = client.watchDocument({
      reviewId,
      reviewVersion: 1,
      signal: abort.signal,
      onDocument: (document) => received.push(document.reviewVersion),
    });
    await vi.waitFor(() => expect(host.streams).toHaveLength(1));
    host.send(0, event(2));
    await vi.waitFor(() => expect(received).toEqual([1, 1]));
    expect(host.queries).toEqual([
      expect.objectContaining({
        type: "review.get",
        input: { reviewId, reviewVersion: 1 },
      }),
      expect.objectContaining({
        type: "document.get",
        input: { reviewId, reviewVersion: 1 },
      }),
    ]);
    abort.abort();
    await watching;
  });

  it.each(["future.material_changed", "constructor", "toString"])(
    "refreshes authoritative state for an unknown event named %s",
    async (type) => {
      const host = server();
      const client = await host.client();
      const abort = new AbortController();
      const versions: number[] = [];
      const errors: Error[] = [];
      const watching = client.watchDocument({
        reviewId,
        signal: abort.signal,
        onDocument: (document) => versions.push(document.reviewVersion),
        onError: (error) => errors.push(error),
      });
      try {
        await vi.waitFor(() => expect(host.streams).toHaveLength(1));
        host.setSnapshot(snapshot(5));
        host.send(0, { ...event(2), type });
        await vi.waitFor(() => expect(versions).toEqual([1, 5]));
        expect(errors).toEqual([]);
        await vi.waitFor(() => expect(host.streams).toHaveLength(2));
        expect(host.streams[1]!.url.searchParams.get("after")).toBe("cursor-5");
      } finally {
        abort.abort();
        await watching;
      }
    },
  );

  it("retries a transient snapshot reset failure after cursor expiry instead of losing the subscription", async () => {
    const host = server();
    let resets = 0;
    const errors: Error[] = [];
    const client = await host.client(async (input, init) => {
      if (String(input).includes("/events") && resets < 2)
        return Response.json(
          {
            ok: false,
            error: {
              code: "CURSOR_EXPIRED",
              message: "Refresh",
              retryable: false,
              diagnostics: [],
            },
          },
          { status: 409 },
        );
      return host.request(input, init);
    });
    const abort = new AbortController();
    const watching = client.subscribe({
      after: "cursor-old",
      reviewId,
      signal: abort.signal,
      onEvent() {},
      async onReset() {
        resets++;
        if (resets === 1) throw new Error("Temporary snapshot network failure");
        return "cursor-new";
      },
      onError: (error) => errors.push(error),
    });
    try {
      await vi.waitFor(() => expect(host.streams).toHaveLength(1));
      expect(resets).toBe(2);
      expect(errors.map((error) => error.message)).toEqual([
        "Temporary snapshot network failure",
      ]);
      expect(host.streams[0]!.url.searchParams.get("after")).toBe("cursor-new");
    } finally {
      abort.abort();
      await watching;
    }
  });

  it("recovers an expired cursor with a new atomic snapshot before reconnecting", async () => {
    const host = server();
    let expired = false;
    const client = await host.client(async (input, init) => {
      if (String(input).includes("/events") && !expired) {
        expired = true;
        host.setSnapshot(snapshot(4));
        return Response.json(
          {
            ok: false,
            error: {
              code: "CURSOR_EXPIRED",
              message: "Read a new snapshot.",
              retryable: false,
              diagnostics: [],
            },
          },
          { status: 409 },
        );
      }
      return host.request(input, init);
    });
    const abort = new AbortController();
    const versions: number[] = [];
    const watching = client.watchDocument({
      reviewId,
      signal: abort.signal,
      onDocument: (document) => versions.push(document.reviewVersion),
    });
    await vi.waitFor(() => expect(host.streams).toHaveLength(1));
    expect(versions).toEqual([1, 4]);
    expect(host.streams[0]!.url.searchParams.get("after")).toBe("cursor-4");
    abort.abort();
    await watching;
  });
});
