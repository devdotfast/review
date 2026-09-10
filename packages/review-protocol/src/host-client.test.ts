import { describe, expect, it, vi } from "vitest";

import { ReviewClient, applyHostDocumentCommit } from "./host-client.js";
import { type HostQuery, HostQuerySchema } from "./host-commands.js";
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
    documentId: reviewId,
    reviewId,
    version,
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
    documentId: reviewId,
    previousVersion: version - 1,
    version,
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
function event(version: number, cursor = `cursor-${version}`) {
  return {
    cursor,
    reviewId,
    type: "document.committed",
    payload: { reviewId, commit: patch(version) },
  };
}

function server() {
  const streams: {
    url: URL;
    controller: ReadableStreamDefaultController<Uint8Array>;
    signal: AbortSignal;
  }[] = [];
  const queries: HostQuery[] = [];
  let current = snapshot();
  const request = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    expect(new Headers(init?.headers).get("x-review-token")).toBe("secret");
    expect(url.searchParams.has("token")).toBe(false);
    if (url.pathname === "/v1/connection")
      return Response.json({
        apiVersion: 1,
        hostId: reviewId,
        workspaceId: otherId,
        principal: { id: reviewId, kind: "human", displayName: "You" },
      });
    if (url.pathname.endsWith("/queries")) {
      const envelope = HostQuerySchema.parse(JSON.parse(String(init?.body)));
      queries.push(envelope);
      return Response.json({
        ok: true,
        data: { result: current, eventCursor: `cursor-${current.version}` },
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
    expect(before.version).toBe(1);
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
      onDocument: (document) => firstVersions.push(document.version),
    });
    const two = client.watchDocument({
      reviewId,
      signal: second.signal,
      onDocument: (document) => secondVersions.push(document.version),
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
      onDocument: (document) => versions.push(document.version),
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
    expect(host.queries).toHaveLength(2);
    abort.abort();
    await watching;
  });

  it("loads historical documents without opening a working-document subscription", async () => {
    const host = server();
    const client = await host.client();
    const received: number[] = [];
    await client.watchDocument({
      reviewId,
      version: 1,
      signal: new AbortController().signal,
      onDocument: (document) => received.push(document.version),
    });
    expect(received).toEqual([1]);
    expect(host.streams).toHaveLength(0);
    expect(host.queries).toEqual([
      expect.objectContaining({
        type: "document.get",
        input: { reviewId, version: 1 },
      }),
    ]);
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
      onDocument: (document) => versions.push(document.version),
    });
    await vi.waitFor(() => expect(host.streams).toHaveLength(1));
    expect(versions).toEqual([1, 4]);
    expect(host.streams[0]!.url.searchParams.get("after")).toBe("cursor-4");
    abort.abort();
    await watching;
  });
});
