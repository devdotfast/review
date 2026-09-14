// @vitest-environment jsdom

import {
  HOST_CAPABILITY_LIMITS,
  type HostActivitySnapshot,
  type HostCommand,
  type HostCommandResults,
  HostCommandSchema,
  type HostDocumentCommit,
  type HostDocumentState,
  type HostFeedbackSubmission,
  type HostQuery,
  type HostQueryResults,
  HostQuerySchema,
  type HostReviewCommit,
  type HostReviewState,
  type HostReviewVersionHeader,
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
    reviewId,
    reviewVersion: version,
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
const checkpoint: HostReviewVersionHeader = {
  reviewId,
  reviewVersion: 1,
  binding,
  title: "API-owned review",
  description: "",
  mapVersions: { base: null, head: null },
  labels: [],
  restoredFromReviewVersion: null,
  createdBy: reviewId,
  createdAt,
};
function fixture(
  state: HostReviewState["state"] = "open",
  initialDocument = documentState(),
  activityEnabled = false,
  feedback: HostFeedbackSubmission[] = [],
) {
  let review: HostReviewState = {
    id: reviewId,
    repositoryId: reviewId,
    stateVersion: 0,
    state,
    latestReviewVersion: initialDocument.reviewVersion,
    createdBy: reviewId,
    createdAt,
    deletedAt: null,
  };
  let working = initialDocument;
  const calls: (HostCommand | HostQuery)[] = [];
  const streams: {
    activity: boolean;
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
          ok: true,
          data: {
            apiVersion: 1,
            hostId: reviewId,
            workspaceId: reviewId,
            principal: { id: reviewId, kind: "human", displayName: "You" },
          },
        });
      if (url.pathname.endsWith("/events")) {
        const signal = init!.signal!;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streams.push({
                controller,
                signal,
                activity: url.searchParams.get("activity") === "1",
              });
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
      if (url.pathname.startsWith("/telemetry/"))
        return Response.json({ ok: true });
      const envelope = {
        ...JSON.parse(String(init?.body)),
        apiVersion: 1,
        hostId: reviewId,
        workspaceId: reviewId,
        clientId: reviewId,
      };
      const request = url.pathname.endsWith("/commands")
        ? HostCommandSchema.parse(envelope)
        : HostQuerySchema.parse(envelope);
      calls.push(request);
      let result:
        | HostQueryResults[keyof HostQueryResults]
        | HostCommandResults[keyof HostCommandResults];
      switch (request.type) {
        case "capabilities":
          result = {
            apiVersions: [1],
            documentSchemaVersions: [1],
            nodeTypes: ["markdown"],
            limits: HOST_CAPABILITY_LIMITS,
            commands: [],
            queries: activityEnabled ? ["authoring.get"] : [],
            ask: {
              defaultHarness: null,
              supportedHarnesses: [],
              isolation: "trusted_local",
            },
          };
          break;
        case "repositories.list":
          result = {
            items: [{ id: reviewId, vcs: "git", displayName: "Example" }],
            nextCursor: null,
          };
          break;
        case "attention.get":
          result = {
            reviewId,
            principalId: reviewId,
            lastViewedAt: null,
            lastViewedReviewVersion: null,
            pinned: false,
            attentionVersion: 1,
          };
          break;
        case "attention.update":
          result = {
            reviewId,
            principalId: reviewId,
            attentionVersion: request.input.expectedAttentionVersion + 1,
            lastViewedReviewVersion:
              request.input.lastViewedReviewVersion ?? null,
            lastViewedAt: createdAt,
            pinned: request.input.pinned ?? false,
          };
          break;
        case "drafts.list":
        case "threads.list":
        case "questions.list":
        case "source.commits":
        case "source.diff":
          result = { items: [], nextCursor: null };
          break;
        case "feedback.list":
          result = { items: feedback, nextCursor: null };
          break;
        case "review.get":
          result = {
            review,
            snapshot: {
              ...checkpoint,
              reviewVersion:
                request.input.reviewVersion ?? working.reviewVersion,
            },
          };
          break;
        case "reviews.list":
          result = {
            items: [
              {
                review,
                snapshot: {
                  ...checkpoint,
                  reviewVersion: working.reviewVersion,
                },
              },
            ],
            nextCursor: null,
          };
          break;
        case "review.history":
          result = {
            items: [{ ...checkpoint, reason: "document" }],
            nextCursor: null,
          };
          break;
        case "document.get":
          result =
            request.input.reviewVersion !== undefined &&
            request.input.reviewVersion !== working.reviewVersion
              ? documentState(request.input.reviewVersion)
              : working;
          break;
        case "review.reopen":
          review = {
            ...review,
            state: "open",
            stateVersion: review.stateVersion + 1,
          };
          result = review;
          break;
        case "trace.get":
          result = {
            trace: {
              id: reviewId,
              label: "Authoring note",
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
      const data = { result, eventCursor: `cursor-${working.reviewVersion}` };
      if ("commandId" in request)
        return Response.json({
          ok: true,
          data: { ...data, commandId: request.commandId },
        });
      return Response.json({ ok: true, data });
    }),
  );
  return {
    activity(snapshot: HostActivitySnapshot) {
      for (const stream of streams)
        if (!stream.signal.aborted && stream.activity)
          stream.controller.enqueue(
            new TextEncoder().encode(
              `event: authoring.activity\ndata: ${JSON.stringify(snapshot)}\n\n`,
            ),
          );
    },
    calls,
    streams,
    trash() {
      review = {
        ...review,
        stateVersion: review.stateVersion + 1,
        deletedAt: createdAt,
      };
      const event = {
        cursor: `trash-${review.stateVersion}`,
        reviewId,
        type: "review.state_changed",
        payload: { review },
      };
      for (const stream of streams)
        if (!stream.signal.aborted)
          stream.controller.enqueue(
            new TextEncoder().encode(
              `id: ${event.cursor}\ndata: ${JSON.stringify(event)}\n\n`,
            ),
          );
    },
    advance(version: number) {
      const before = working;
      working = {
        ...working,
        reviewVersion: version,
        nodes: { ...working.nodes, ...documentState(version).nodes },
      };
      const commit: HostDocumentCommit = {
        reviewId,
        previousReviewVersion: before.reviewVersion,
        reviewVersion: version,
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
      review = { ...review, latestReviewVersion: version };
      const reviewCommit: HostReviewCommit = {
        reviewId,
        previousReviewVersion: before.reviewVersion,
        reviewVersion: version,
        snapshot: { ...checkpoint, reviewVersion: version },
        documentDelta: commit,
        diagnostics: [],
      };
      const event = {
        cursor: `cursor-${version}`,
        reviewId,
        type: "review.committed",
        payload: reviewCommit,
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
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }),
  });
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

async function render(
  review = true,
  setDocumentVersion?: (version: number) => void,
  closeReview?: (reviewId: string) => Promise<void>,
) {
  const openReview = vi.fn<(reviewId: string, title?: string) => void>();
  await act(async () => {
    root.render(
      <HostCanvas
        content={{
          kind: "host",
          connection: { serverUrl: "http://localhost:4000", token: "secret" },
          reviewId: review ? reviewId : undefined,
          openReview,
          closeReview,
          showHome() {},
          source: {
            setDocumentVersion,
            open: async () => {},
            createPeek: () => {
              throw new Error("Unused peek");
            },
            inlineEditors: {
              create: () => {
                throw new Error("Unused source editor");
              },
              find: async () => ({ matchCount: 0 }),
            },
            diffView: {
              create: () => {
                throw new Error("Unused diff view");
              },
              files: async () => [],
            },
          },
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
  it("shows closed rather than approved when closing has no approval decision", async () => {
    fixture("closed");
    await render();
    await settle();
    expect(container.querySelector(".review-baton-chip")?.textContent).toBe(
      "closed",
    );
    expect(container.querySelector(".topbar-new-ask-button")).toBeNull();
    expect(container.querySelector(".review-corner-action")).toBeNull();
  });

  it("shows an exact-version approval without ending review, and removes it when a newer version arrives", async () => {
    const host = fixture("open", documentState(), false, [
      {
        id: crypto.randomUUID(),
        reviewId,
        reviewVersion: 1,
        decision: "approve",
        createdBy: reviewId,
        createdAt,
        messageIds: [],
        threadIds: [],
      },
    ]);
    await render();
    await settle();
    expect(container.querySelector(".review-baton-chip")?.textContent).toBe(
      "approved · v1",
    );
    expect(container.querySelector(".topbar-new-ask-button")).not.toBeNull();
    await act(async () => host.advance(2));
    await settle();
    expect(container.querySelector(".review-baton-chip")).toBeNull();
  });

  it("does not display an old approval on restored identical canvas content", async () => {
    fixture("open", { ...documentState(1), reviewVersion: 3 }, false, [
      {
        id: crypto.randomUUID(),
        reviewId,
        reviewVersion: 1,
        decision: "approve",
        createdBy: reviewId,
        createdAt,
        messageIds: [],
        threadIds: [],
      },
    ]);
    await render();
    await settle();
    expect(container.textContent).toContain("Body version 1");
    expect(container.querySelector(".review-baton-chip")).toBeNull();
  });
  it("shows host activity without changing content, and hides it on historical checkpoints", async () => {
    const host = fixture("open", documentState(), true);
    await render();
    const active = {
      reviewId,
      workingCount: 1,
      unknownCount: 0,
    };
    await act(async () => host.activity(active));
    expect(container.textContent).toContain("Agent working…");
    expect(container.textContent).toContain("Body version 1");
    await act(async () => host.activity({ ...active, workingCount: 0 }));
    expect(container.textContent).not.toContain("Agent working…");
    await act(async () => host.activity(active));
    await act(async () => host.advance(2));
    expect(container.textContent).toContain("Agent working…");
    expect(container.textContent).toContain("Body version 2");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Version history"]')!
        .click(),
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click(),
    );
    expect(container.textContent).toContain("older version");
    expect(container.textContent).not.toContain("Agent working…");
    await act(async () => host.activity(active));
    expect(container.textContent).not.toContain("Agent working…");
  });

  it("closes the matching native review tabs after another client moves the review to trash", async () => {
    const host = fixture();
    const closeReview = vi.fn<(id: string) => Promise<void>>(async () => {});
    await render(true, undefined, closeReview);
    expect(closeReview).not.toHaveBeenCalled();
    await act(async () => host.trash());
    await settle();
    expect(closeReview).toHaveBeenCalledExactlyOnceWith(reviewId);
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
    const host = fixture("open", initial);
    await render();
    expect(
      container.querySelectorAll(".review-trace-quote-container"),
    ).toHaveLength(2);
    expect(host.calls.filter((call) => call.type === "trace.get")).toHaveLength(
      1,
    );
    const toggle = container.querySelector<HTMLButtonElement>(
      ".review-section-toggle",
    )!;
    act(() => toggle.click());
    await act(async () => host.advance(2));
    expect(container.querySelector(".review-section-toggle")).toBe(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(
      container.querySelectorAll(".review-trace-quote-container"),
    ).toHaveLength(2);
    expect(host.calls.filter((call) => call.type === "trace.get")).toHaveLength(
      1,
    );
  });

  it("opens host reviews from the API list without legacy review records", async () => {
    fixture();
    const openReview = await render(false);
    expect(container.textContent).toContain("API-owned review");
    act(() =>
      container.querySelector<HTMLButtonElement>(".review-home-card")!.click(),
    );
    expect(openReview).toHaveBeenCalledWith(reviewId, "API-owned review");
  });

  it("renders atomic live updates, freezes a checkpoint, then returns to the latest live version", async () => {
    const host = fixture();
    const observeSourceVersion = vi.fn<(version: number) => void>();
    await render(true, observeSourceVersion);
    expect(container.textContent).toContain("Body version 1");
    await act(async () => host.advance(2));
    expect(container.textContent).toContain("Body version 2");
    const history = container.querySelector<HTMLButtonElement>(
      '[aria-label="Version history"]',
    )!;
    await act(async () => history.click());
    observeSourceVersion.mockClear();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click();
    });
    expect(container.textContent).toContain("Body version 1");
    expect(container.textContent).toContain("older version");
    // A transient render with the live document would point native sources
    // and comment targets at version 2 under the historical checkpoint.
    expect(
      observeSourceVersion.mock.calls.map(([version]) => version),
    ).not.toContain(2);
    expect(observeSourceVersion).toHaveBeenCalledWith(1);

    await act(async () => host.advance(3));
    expect(container.textContent).not.toContain("Body version 3");
    observeSourceVersion.mockClear();
    await act(async () => {
      button("Back to latest").click();
    });
    expect(container.textContent).toContain("Body version 3");
    expect(
      observeSourceVersion.mock.calls.map(([version]) => version),
    ).not.toContain(1);
    expect(observeSourceVersion).toHaveBeenCalledWith(3);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
