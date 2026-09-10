// @vitest-environment jsdom

import {
  type HostCheckpoint,
  type HostCommand,
  type HostCommandResults,
  HostCommandSchema,
  type HostDocumentCommit,
  type HostDocumentState,
  type HostQuery,
  type HostQueryResults,
  HostQuerySchema,
  type HostReview,
} from "@dev.fast/review-protocol";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HostCanvas } from "./host-canvas";

const reviewId = "27768987-4d4d-4c6f-885c-4bf783f44c27";
const checkpointId = "8afbc67c-089e-4d84-95d1-16d5e4710484";
const createdAt = "2026-09-10T12:00:00Z";
const binding = {
  id: reviewId,
  repositoryId: reviewId,
  selector: { kind: "snapshot" as const, ref: "main" },
  baseCommit: "a".repeat(40),
  headCommit: "a".repeat(40),
  createdAt,
};
function documentState(version = 1): HostDocumentState {
  return {
    schemaVersion: 1,
    documentId: reviewId,
    reviewId,
    version,
    roots: ["intro"],
    nodes: {
      intro: {
        id: "intro",
        type: "markdown",
        markdown: `Body version ${version}`,
      },
    },
    definitions: {},
    evidence: {},
    binding,
    contentHash: "a".repeat(64),
    createdAt,
  };
}
const checkpoint: HostCheckpoint = {
  id: checkpointId,
  reviewId,
  ordinal: 1,
  documentVersion: 1,
  bindingId: reviewId,
  title: "First checkpoint",
  description: "",
  mapVersions: { base: null, head: null },
  authorSessionId: null,
  createdBy: reviewId,
  createdAt,
};
function fixture(
  workflow: HostReview["workflow"] = "draft",
  initialDocument = documentState(),
) {
  let review: HostReview = {
    id: reviewId,
    repositoryId: reviewId,
    version: 1,
    title: "API-owned review",
    description: "",
    labels: [],
    workflow,
    documentId: reviewId,
    documentVersion: 1,
    publishedCheckpointId: null,
    authorSessionId: null,
    createdBy: reviewId,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
  };
  let working = initialDocument;
  const calls: (HostCommand | HostQuery)[] = [];
  const streams: {
    controller: ReadableStreamDefaultController<Uint8Array>;
    signal: AbortSignal;
  }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(new Headers(init?.headers).get("x-review-token")).toBe("secret");
      if (url.pathname === "/v1/connection")
        return Response.json({
          apiVersion: 1,
          hostId: reviewId,
          workspaceId: reviewId,
          principal: { id: reviewId, kind: "human", displayName: "You" },
        });
      if (url.pathname.endsWith("/events")) {
        const signal = init!.signal!;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streams.push({ controller, signal });
              signal.addEventListener(
                "abort",
                () => {
                  try {
                    controller.close();
                  } catch {
                    /* cancelled */
                  }
                },
                { once: true },
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      const request = url.pathname.endsWith("/commands")
        ? HostCommandSchema.parse(JSON.parse(String(init?.body)))
        : HostQuerySchema.parse(JSON.parse(String(init?.body)));
      calls.push(request);
      let result:
        | HostQueryResults[
            | "review.get"
            | "reviews.list"
            | "checkpoints.list"
            | "trace.get"
            | "document.get"]
        | HostCommandResults[
            | "review.reopen"
            | "review.publish"
            | "canvas.report"];
      switch (request.type) {
        case "review.get":
          result = { review };
          break;
        case "reviews.list":
          result = { items: [review], nextCursor: null };
          break;
        case "checkpoints.list":
          result = { items: [checkpoint], nextCursor: null };
          break;
        case "document.get":
          result = request.input.version
            ? documentState(request.input.version)
            : working;
          break;
        case "review.publish":
          review = {
            ...review,
            workflow: "in_review",
            version: review.version + 1,
            publishedCheckpointId: checkpoint.id,
          };
          result = checkpoint;
          break;
        case "review.reopen":
          review = {
            ...review,
            workflow: "draft",
            version: review.version + 1,
          };
          result = review;
          break;
        case "canvas.report":
          result = { accepted: true };
          break;
        case "trace.get":
          result = {
            trace: {
              id: reviewId,
              sessionId: null,
              parentTraceId: null,
              label: "Authoring note",
              version: 0,
              createdAt,
              provenance: "client_supplied",
            },
            events: [
              {
                id: checkpointId,
                traceId: reviewId,
                ordinal: 0,
                at: createdAt,
                kind: "assistant",
                text: "Checked the source",
                contentHash: "a".repeat(64),
              },
            ],
          };
          break;
        default:
          throw new Error(`Unexpected API operation: ${request.type}`);
      }
      const data = { result, eventCursor: `cursor-${working.version}` };
      if ("commandId" in request)
        return Response.json({
          ok: true,
          data: { ...data, commandId: request.commandId },
        });
      return Response.json({ ok: true, data });
    }),
  );
  return {
    calls,
    streams,
    advance(version: number) {
      const before = working;
      working = {
        ...working,
        version,
        nodes: { ...working.nodes, ...documentState(version).nodes },
      };
      const commit: HostDocumentCommit = {
        documentId: reviewId,
        previousVersion: before.version,
        version,
        contentHash: working.contentHash,
        createdAt,
        changedNodes: working.nodes,
        removedNodeIds: [],
        changedDefinitions: {},
        removedDefinitionIds: [],
        changedEvidence: {},
        removedEvidenceIds: [],
        roots: working.roots,
        binding,
        diagnostics: [],
      };
      const event = {
        cursor: `cursor-${version}`,
        reviewId,
        type: "document.committed",
        payload: { reviewId, commit },
      };
      for (const stream of streams)
        if (!stream.signal.aborted)
          stream.controller.enqueue(
            new TextEncoder().encode(
              `id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`,
            ),
          );
    },
  };
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute("open");
    },
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(review = true) {
  const openReview = vi.fn<(reviewId: string, title?: string) => void>();
  await act(async () => {
    root.render(
      <HostCanvas
        content={{
          kind: "host",
          connection: { serverUrl: "http://localhost:4000", token: "secret" },
          reviewId: review ? reviewId : undefined,
          openReview,
          showHome() {},
        }}
      />,
    );
  });
  return openReview;
}
function button(label: string) {
  const found = Array.from(container.querySelectorAll("button")).find(
    (item) => item.textContent === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("native JSON canvas API integration", () => {
  it("keeps Welcome, Settings and Tutorial reachable from the API-owned home", async () => {
    const host = fixture();
    const openWelcome = vi.fn<() => void>();
    const openSettings = vi.fn<() => void>();
    const openTutorial = vi.fn<() => void>();
    await act(async () =>
      root.render(
        <HostCanvas
          content={{
            kind: "host",
            connection: { serverUrl: "http://localhost:4000", token: "secret" },
            openReview() {},
            showHome() {},
            openWelcome,
            openSettings,
            openTutorial,
          }}
        />,
      ),
    );
    await act(async () => {
      button("Welcome").click();
      button("Settings").click();
      button("Tutorial").click();
    });
    expect(openWelcome).toHaveBeenCalledOnce();
    expect(openSettings).toHaveBeenCalledOnce();
    expect(openTutorial).toHaveBeenCalledOnce();
    expect(host.calls.some((call) => call.type === "reviews.list")).toBe(true);
  });
  it("fetches shared retained resources once and preserves collapsed sections through unrelated live changes", async () => {
    const initial = documentState();
    initial.nodes.section = {
      id: "section",
      type: "section",
      title: "Details",
      defaultCollapsed: false,
      children: ["intro"],
    };
    initial.nodes.firstQuote = {
      id: "firstQuote",
      type: "trace_quote",
      traceId: reviewId,
      eventId: checkpointId,
      text: "Checked the source",
    };
    initial.nodes.secondQuote = {
      ...initial.nodes.firstQuote,
      id: "secondQuote",
    };
    initial.roots = ["section", "firstQuote", "secondQuote"];
    const host = fixture("draft", initial);
    await render();
    expect(container.querySelectorAll(".host-document-trace")).toHaveLength(2);
    expect(host.calls.filter((call) => call.type === "trace.get")).toHaveLength(
      1,
    );
    const toggle = container.querySelector<HTMLButtonElement>(
      ".host-document-section button",
    )!;
    act(() => toggle.click());
    await act(async () => host.advance(2));
    expect(container.querySelector(".host-document-section button")).toBe(
      toggle,
    );
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelectorAll(".host-document-trace")).toHaveLength(2);
    expect(host.calls.filter((call) => call.type === "trace.get")).toHaveLength(
      1,
    );
  });

  it("opens host reviews from the API list without legacy review records", async () => {
    fixture();
    const openReview = await render(false);
    expect(container.textContent).toContain("API-owned review");
    act(() => button("API-owned review").click());
    expect(openReview).toHaveBeenCalledWith(reviewId, "API-owned review");
  });

  it("renders atomic live updates, freezes a checkpoint, then returns to the latest live version", async () => {
    const host = fixture();
    await render();
    expect(container.textContent).toContain("Body version 1");
    await act(async () => host.advance(2));
    expect(container.textContent).toContain("Body version 2");
    const select = container.querySelector("select")!;
    await act(async () => {
      select.value = checkpointId;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.textContent).toContain("Body version 1");
    expect(button("Publish checkpoint").disabled).toBe(true);
    expect(host.streams.every((stream) => stream.signal.aborted)).toBe(true);
    await act(async () => host.advance(3));
    expect(container.textContent).not.toContain("Body version 3");
    await act(async () => {
      select.value = "";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.textContent).toContain("Body version 3");
  });

  it("sends reopen and publication commands with current optimistic versions", async () => {
    const host = fixture("closed");
    await render();
    await act(async () => button("Reopen review").click());
    await settle();
    expect(host.calls).toContainEqual(
      expect.objectContaining({
        type: "review.reopen",
        input: { reviewId, expectedVersion: 1 },
      }),
    );
    await act(async () => button("Publish checkpoint").click());
    await settle();
    expect(host.calls).toContainEqual(
      expect.objectContaining({
        type: "review.publish",
        input: {
          reviewId,
          expectedDocumentVersion: 1,
          expectedReviewVersion: 2,
          mapVersions: { base: null, head: null },
        },
      }),
    );
    expect(container.textContent).toContain("Published checkpoint 1");
  });
});
