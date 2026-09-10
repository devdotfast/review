// @vitest-environment jsdom

import type {
  HostDocumentState,
  HostMapVersion,
  HostNode,
  ReviewHostSourceBridge,
  ReviewInlineEditorHandle,
} from "@dev.fast/review-protocol";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type HostDocumentResources,
  hostDatabaseSnapshot,
  hostMapSnapshot,
  hostSequence,
} from "./host-document-components";
import { HostDocumentRenderer } from "./host-document-renderer";

const hash = "a".repeat(64);
const commit = "b".repeat(40);
let root: Root;
let container: HTMLDivElement;

function nativePeekBridge() {
  const errors: ((message: string) => void)[] = [];
  const dispose = vi.fn<() => void>();
  const createPeek = vi.fn<ReviewHostSourceBridge["createPeek"]>((spec) => {
    const input = document.createElement("textarea");
    input.value = "Native selected source";
    spec.container.append(input);
    const handle: ReviewInlineEditorHandle = {
      height: 180,
      dispose,
      setActive() {},
      setCollapsed() {},
      onDidChangeHeight: () => ({ dispose() {} }),
      onDidError: (listener) => {
        errors.push(listener);
        return { dispose() {} };
      },
      setFindQuery: async () => ({ matchCount: 0 }),
      revealFindMatch() {},
      clearActiveFindMatch() {},
      clearFind() {},
    };
    return handle;
  });
  return {
    bridge: { open: async () => {}, createPeek },
    createPeek,
    dispose,
    errors,
  };
}

function documentState(nodes: HostNode[]): HostDocumentState {
  return {
    schemaVersion: 1,
    documentId: "document-one",
    reviewId: "review-one",
    version: 1,
    roots: nodes.map((node) => node.id),
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
    definitions: {
      source: {
        kind: "anchor",
        title: "Verified implementation",
        source: { side: "head", file: "src/main.ts", fromLine: 40, toLine: 42 },
      },
    },
    evidence: {
      source: {
        span: {
          repositoryId: "repository-one",
          commit,
          blob: commit,
          file: "src/main.ts",
          fromLine: 40,
          toLine: 42,
        },
        text: "export function answer() {\n  return 42;\n}",
        sha256: hash,
      },
    },
    binding: {
      id: "binding-one",
      repositoryId: "repository-one",
      selector: { kind: "range", baseRef: commit, headRef: commit },
      baseCommit: commit,
      headCommit: commit,
      createdAt: "2026-09-10T00:00:00Z",
    },
    contentHash: hash,
    createdAt: "2026-09-10T00:00:00Z",
  };
}

function render(
  document: HostDocumentState,
  props: {
    onSourceOpen?: (anchorId: string) => void;
    onError?: (nodeId: string, error: Error) => void;
    resources?: HostDocumentResources;
    source?: ReviewHostSourceBridge;
  } = {},
) {
  act(() =>
    root.render(<HostDocumentRenderer document={document} {...props} />),
  );
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

function richDocument(nodes: HostNode[]): HostDocumentState {
  const state = documentState(nodes);
  state.definitions.worker = { kind: "actor", label: "Worker" };
  state.definitions.peer = { kind: "actor", label: "Worker" };
  state.definitions.database = {
    kind: "store",
    label: "Records",
    storage: "relational",
    collections: {
      users: {
        label: "Users",
        fields: {
          id: {
            label: "Identifier",
            dataType: "integer",
            nullable: false,
            primaryKey: true,
          },
        },
      },
    },
  };
  return state;
}

describe("host rich nodes", () => {
  it("keeps repeated sequence labels and reused evidence distinct by message ID", () => {
    const node: Extract<HostNode, { type: "sequence" }> = {
      id: "sequence",
      type: "sequence",
      title: "Repeated title",
      messages: [
        {
          id: "first",
          fromActorId: "worker",
          toActorId: "peer",
          label: "Send",
          style: "call",
          evidence: { kind: "anchor", anchorId: "source" },
        },
        {
          id: "second",
          fromActorId: "worker",
          toActorId: "peer",
          label: "Send",
          style: "return",
          evidence: { kind: "anchor", anchorId: "source" },
        },
      ],
    };
    const state = richDocument([node]);
    const sequence = hostSequence(node, state);
    expect(sequence.messages.map((message) => message.id)).toEqual([
      "first",
      "second",
    ]);
    expect(sequence.messages.map((message) => message.anchor.id)).toEqual([
      "source",
      "source",
    ]);
    expect(sequence.participants).toHaveLength(2);
    expect(sequence.messages[1]?.style).toBe("return");
    expect(() =>
      hostSequence(
        { ...node, messages: [node.messages[0]!, node.messages[0]!] },
        state,
      ),
    ).toThrow("duplicated");
  });

  it("mounts the existing sequence visual without a legacy review session", () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const state = richDocument([
      {
        id: "sequence",
        type: "sequence",
        title: "Flow",
        messages: [
          {
            id: "first",
            fromActorId: "worker",
            toActorId: "peer",
            label: "Send",
            style: "call",
            evidence: { kind: "anchor", anchorId: "source" },
          },
          {
            id: "second",
            fromActorId: "worker",
            toActorId: "peer",
            label: "Send",
            style: "async",
            evidence: { kind: "anchor", anchorId: "source" },
          },
        ],
      },
    ]);
    const onSourceOpen = vi.fn<(anchorId: string) => void>();
    render(state, { onSourceOpen });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(
      container.querySelector(".sequence-diagram .react-flow"),
    ).not.toBeNull();
    act(() =>
      container
        .querySelector<HTMLButtonElement>(".diagram-tour-button")
        ?.click(),
    );
    expect(onSourceOpen).toHaveBeenCalledWith("source");
    expect(
      container.querySelector(".host-document-graph-evidence pre")?.textContent,
    ).toContain("return 42");
  });

  it("uses operation identity, retains read/write direction, and permits repeated use-case labels", () => {
    const node: Extract<HostNode, { type: "database_lens" }> = {
      id: "lens",
      type: "database_lens",
      title: "Storage",
      storeIds: ["database"],
      useCases: [
        {
          id: "read",
          label: "Access",
          operations: [
            {
              id: "load",
              kind: "read",
              store: {
                storeId: "database",
                collectionId: "users",
                fieldId: "id",
              },
              actorId: "worker",
              label: "Access",
              anchorId: "source",
            },
          ],
        },
        {
          id: "write",
          label: "Access",
          operations: [
            {
              id: "save",
              kind: "write",
              store: { storeId: "database", collectionId: "users" },
              actorId: "worker",
              label: "Access",
              anchorId: "source",
            },
          ],
        },
      ],
    };
    const state = richDocument([node]);
    expect(
      hostDatabaseSnapshot(node, state, "read").relationships,
    ).toMatchObject([
      { id: "load", from: "database", to: "worker", semanticKind: "read" },
    ]);
    expect(
      hostDatabaseSnapshot(node, state, "write").relationships,
    ).toMatchObject([
      { id: "save", from: "worker", to: "database", semanticKind: "write" },
    ]);
    const combined = {
      ...node,
      useCases: [
        {
          id: "both",
          label: "Access",
          operations: [
            ...node.useCases[0]!.operations,
            ...node.useCases[1]!.operations,
          ],
        },
      ],
    };
    expect(
      new Set(
        hostDatabaseSnapshot(combined, state).relationships?.map(
          (edge) => edge.id,
        ),
      ).size,
    ).toBe(2);
    expect(
      hostDatabaseSnapshot(node, state).nodes?.find(
        (item) => item.id === "database",
      )?.dataStoreSchemaSections?.[0]?.rows,
    ).toMatchObject([{ id: "id", primaryKey: true }]);
  });

  it("shows shared-ID call-stack reordering as movement, without false additions or deletions", () => {
    const node: Extract<HostNode, { type: "call_stack_diff" }> = {
      id: "stack",
      type: "call_stack_diff",
      title: "Calls",
      base: [
        { id: "first", anchorId: "source", label: "First" },
        { id: "second", anchorId: "source", label: "Second" },
      ],
      head: [
        { id: "second", anchorId: "source", label: "Second" },
        { id: "first", anchorId: "source", label: "First" },
      ],
    };
    const onSourceOpen = vi.fn<(anchorId: string) => void>();
    render(richDocument([node]), { onSourceOpen });
    expect(container.querySelectorAll(".call-stack-row")).toHaveLength(2);
    expect(
      container.querySelectorAll(".call-stack-added, .call-stack-removed"),
    ).toHaveLength(0);
    expect(container.textContent).toContain("moved");
    act(() =>
      container.querySelector<HTMLButtonElement>(".call-stack-row")?.click(),
    );
    expect(onSourceOpen).toHaveBeenCalledWith("source");
  });

  it("preserves exact map identity and projects nested endpoints when a group is collapsed", () => {
    const map: HostMapVersion = {
      id: "map-version",
      mapId: "map",
      repositoryId: "repository-one",
      commit,
      revision: 1,
      contentHash: hash,
      createdAt: "2026-09-10T00:00:00Z",
      schemaVersion: 1,
      elements: {
        system: {
          id: "system",
          parentId: null,
          label: "Service",
          description: "Boundary",
          kind: "system",
          source: [],
        },
        child: {
          id: "child",
          parentId: "system",
          label: "Worker",
          description: "Inside",
          kind: "component",
          source: [],
        },
        external: {
          id: "external",
          parentId: null,
          label: "Worker",
          description: "Outside",
          kind: "component",
          source: [],
        },
      },
      relationships: {
        call: {
          id: "call",
          fromId: "child",
          toId: "external",
          kind: "semantic",
          label: "Request",
          explanation: "Network request",
        },
      },
    };
    const expanded = hostMapSnapshot(map, "child");
    const collapsed = hostMapSnapshot(map, "child", new Set(["system"]));
    expect(expanded.view).toBe(map.id);
    expect(expanded.nodes).toHaveLength(3);
    expect(collapsed.nodes).toHaveLength(2);
    expect(collapsed.selectedNodeId).toBe("system");
    expect(collapsed.relationships).toMatchObject([
      { id: "call", from: "system", to: "external" },
    ]);
  });

  it("renders retained trace text and isolates missing or mismatched excerpts", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const state = richDocument([
      {
        id: "trace",
        type: "trace_quote",
        traceId: "trace-one",
        eventId: "event-one",
        text: "Look at the source",
      },
      {
        id: "bad",
        type: "trace_quote",
        traceId: "trace-one",
        eventId: "missing",
        text: "Invented",
      },
    ]);
    render(state, {
      resources: {
        traces: {
          "trace-one": {
            id: "trace-one",
            provenance: "client_supplied",
            label: "Authoring note",
            events: {
              "event-one": {
                id: "event-one",
                role: "agent",
                text: "Look at the source before changing it.",
              },
            },
          },
        },
      },
    });
    expect(container.querySelectorAll(".host-document-trace")).toHaveLength(1);
    expect(
      container.querySelector(".host-document-trace pre")?.textContent,
    ).toBe("Look at the source");
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(container.textContent).toContain("Provided trace excerpt");
  });

  it.each([
    ["A hello\n  world statement.", "hello world"],
    ["A hello world statement.", " hello\tworld "],
  ])(
    "renders whitespace-normalized evidence without changing the authored quotation",
    (text, quotation) => {
      const state = richDocument([
        {
          id: "trace",
          type: "trace_quote",
          traceId: "trace-one",
          eventId: "event-one",
          text: quotation,
        },
      ]);
      const onError = vi.fn<(nodeId: string, error: Error) => void>();
      render(state, {
        onError,
        resources: {
          traces: {
            "trace-one": {
              id: "trace-one",
              provenance: "client_supplied",
              label: "Authoring note",
              events: { "event-one": { id: "event-one", text } },
            },
          },
        },
      });
      expect(
        container.querySelector(".host-document-trace pre")?.textContent,
      ).toBe(quotation);
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(onError).not.toHaveBeenCalled();
    },
  );

  it("keeps resource loading separate from failure and preserves existing section state when the resource arrives", () => {
    const state = richDocument([
      {
        id: "section",
        type: "section",
        title: "Details",
        defaultCollapsed: false,
        children: ["detail"],
      },
      { id: "detail", type: "markdown", markdown: "Hidden details" },
      {
        id: "trace",
        type: "trace_quote",
        traceId: "trace-one",
        eventId: "event-one",
        text: "Retained quotation",
      },
    ]);
    state.roots = ["section", "trace"];
    const onError = vi.fn<(nodeId: string, error: Error) => void>();
    render(state, {
      resources: { pending: new Set(["trace:trace-one"]) },
      onError,
    });
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "Loading trace…",
    );
    expect(onError).not.toHaveBeenCalled();
    const toggle = container.querySelector<HTMLButtonElement>(
      ".host-document-section button",
    )!;
    act(() => toggle.click());
    render(state, {
      resources: {
        traces: {
          "trace-one": {
            id: "trace-one",
            provenance: "client_supplied",
            label: "Authoring note",
            events: {
              "event-one": { id: "event-one", text: "Retained quotation" },
            },
          },
        },
      },
      onError,
    });
    expect(container.querySelector(".host-document-section button")).toBe(
      toggle,
    );
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(
      container.querySelector(".host-document-trace pre")?.textContent,
    ).toBe("Retained quotation");
    expect(onError).not.toHaveBeenCalled();
  });

  it("creates only owned image URLs and revokes them when the document releases the image", () => {
    const create = vi
      .fn<typeof URL.createObjectURL>()
      .mockReturnValue("blob:owned-image");
    const revoke = vi.fn<typeof URL.revokeObjectURL>();
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL = create;
        static revokeObjectURL = revoke;
      },
    );
    const state = richDocument([
      {
        id: "image",
        type: "image",
        assetId: "image-one",
        alt: "Diagram",
        caption: "An owned asset",
      },
    ]);
    render(state, {
      resources: {
        images: {
          "image-one": {
            id: "image-one",
            mimeType: "image/png",
            bytes: new Uint8Array([137, 80, 78, 71]),
          },
        },
      },
    });
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "blob:owned-image",
    );
    expect(container.querySelector("img")?.getAttribute("alt")).toBe("Diagram");
    expect(create).toHaveBeenCalledWith(expect.any(Blob));
    render({ ...state, version: 2, roots: [], nodes: {} });
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:owned-image");
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("host document renderer", () => {
  it("preserves a native source editor across unrelated commits and replaces it only when evidence changes", () => {
    const native = nativePeekBridge();
    const state = documentState([
      {
        id: "peek",
        type: "code_peek",
        anchorId: "source",
        caption: "Explanation",
      },
    ]);
    render(state, { source: native.bridge });
    const editor = container.querySelector("textarea")!;
    editor.setSelectionRange(2, 7);
    render({ ...state, version: 2 }, { source: native.bridge });
    expect(native.createPeek).toHaveBeenCalledTimes(1);
    expect(native.createPeek.mock.calls[0][0].target.documentVersion).toBe(1);
    expect(container.querySelector("textarea")).toBe(editor);
    expect(editor.selectionStart).toBe(2);
    expect(container.textContent).toContain("Explanation");
    const next = structuredClone(state);
    next.version = 3;
    next.evidence.source.sha256 = "d".repeat(64);
    render(next, { source: native.bridge });
    expect(native.createPeek).toHaveBeenCalledTimes(2);
    expect(native.dispose).toHaveBeenCalledOnce();
  });

  it("rebinds the native source target when identical bytes move to another file or side", () => {
    const native = nativePeekBridge();
    const state = documentState([
      { id: "peek", type: "code_peek", anchorId: "source" },
    ]);
    render(state, { source: native.bridge });
    const next = structuredClone(state);
    next.version = 2;
    const anchor = next.definitions.source;
    if (anchor.kind !== "anchor") throw new Error("Expected source anchor");
    anchor.source.file = "src/identical-copy.ts";
    next.evidence.source.span.file = anchor.source.file;
    render(next, { source: native.bridge });
    expect(native.createPeek).toHaveBeenCalledTimes(2);
    expect(native.createPeek.mock.lastCall?.[0].target).toEqual({
      reviewId: next.reviewId,
      documentVersion: 2,
      range: anchor.source,
    });

    anchor.source.side = "base";
    next.version = 3;
    render(next, { source: native.bridge });
    expect(native.createPeek).toHaveBeenCalledTimes(3);
    expect(native.createPeek.mock.lastCall?.[0].target.range.side).toBe("base");
    anchor.title = "Updated source label";
    next.version = 4;
    render(next, { source: native.bridge });
    expect(native.createPeek).toHaveBeenCalledTimes(4);
    expect(native.createPeek.mock.lastCall?.[0].title).toBe(
      "Updated source label",
    );
    render({ ...next, version: 5 }, { source: native.bridge });
    expect(native.createPeek).toHaveBeenCalledTimes(4);
    expect(native.dispose).toHaveBeenCalledTimes(3);
  });

  it("keeps retained source readable if the native API-backed editor fails", () => {
    const native = nativePeekBridge();
    const state = documentState([
      { id: "peek", type: "code_peek", anchorId: "source" },
    ]);
    render(state, { source: native.bridge });
    act(() => native.errors[0]("Repository unavailable"));
    expect(container.textContent).toContain("Showing the retained excerpt");
    expect(container.querySelector("pre")?.textContent).toContain("return 42");
    expect(container.querySelectorAll("#review-source-peek")).toHaveLength(1);
    expect(native.dispose).toHaveBeenCalledOnce();
  });
  it("renders GFM without executing HTML, custom protocols, or image requests", () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    render(
      documentState([
        {
          id: "prose",
          type: "markdown",
          markdown: [
            "###### Small heading",
            "",
            "~~old~~ **new** [safe][docs] [unsafe](javascript:alert%281%29)",
            "",
            "[docs]: https://example.com/docs",
            "",
            "- [x] checked",
            "",
            "| Name | Value |",
            "| :--- | ---: |",
            "| Answer | 42 |",
            "",
            "<script>globalThis.compromised = true</script>",
            "",
            "![private](https://example.com/tracker.png)",
          ].join("\n"),
        },
      ]),
    );

    expect(container.querySelector("h6")?.textContent).toBe("Small heading");
    expect(container.querySelector("del")?.textContent).toBe("old");
    expect(container.querySelector("strong")?.textContent).toBe("new");
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "https://example.com/docs",
    );
    expect(container.querySelectorAll("a")).toHaveLength(1);
    expect(container.querySelector<HTMLInputElement>("input")?.checked).toBe(
      true,
    );
    expect(container.querySelectorAll("tbody td")).toHaveLength(2);
    expect(
      container.querySelector("tbody td:last-child")?.getAttribute("style"),
    ).toContain("right");
    expect(container.querySelector("script, img")).toBeNull();
    expect(container.textContent).toContain(
      "<script>globalThis.compromised = true</script>",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("renders retained source with no repository access and opens typed source links", () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    const onSourceOpen = vi.fn<(anchorId: string) => void>();
    render(
      documentState([
        {
          id: "title",
          type: "heading",
          level: 1,
          content: [{ type: "text", text: "Implementation" }],
        },
        {
          id: "intro",
          type: "paragraph",
          content: [
            { type: "text", text: "Read ", marks: ["emphasis"] },
            {
              type: "anchor_link",
              anchorId: "source",
              text: "the implementation",
            },
            { type: "break" },
            { type: "code", text: "answer()" },
          ],
        },
        {
          id: "peek",
          type: "code_peek",
          anchorId: "source",
          caption: "Pinned evidence",
        },
        {
          id: "example",
          type: "code",
          language: "ts",
          text: "const result = answer();",
          caption: "Illustrative",
        },
        { id: "end", type: "divider" },
      ]),
      { onSourceOpen },
    );

    expect(
      container.querySelector(".host-document-code-peek pre")?.textContent,
    ).toBe("export function answer() {\n  return 42;\n}");
    expect(container.textContent).toContain("src/main.ts:40–42");
    expect(container.textContent).toContain("Pinned evidence");
    expect(container.querySelector("hr")).not.toBeNull();
    act(() => container.querySelector<HTMLButtonElement>("p button")?.click());
    expect(onSourceOpen).toHaveBeenCalledExactlyOnceWith("source");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves collapsed sections and unaffected DOM across atomic document updates", () => {
    const state = documentState([
      {
        id: "section",
        type: "section",
        title: "Details",
        defaultCollapsed: true,
        children: ["child"],
      },
      {
        id: "stable",
        type: "paragraph",
        content: [{ type: "text", text: "Reader selection" }],
      },
    ]);
    state.nodes.child = {
      id: "child",
      type: "paragraph",
      content: [{ type: "text", text: "Hidden detail" }],
    };
    render(state);
    const button = container.querySelector<HTMLButtonElement>("h2 button")!;
    const stable = container.querySelector('[data-node-id="stable"] p')!;
    expect(button.getAttribute("aria-expanded")).toBe("false");
    act(() => button.click());

    const next = structuredClone(state);
    next.version++;
    next.nodes.section = {
      ...(next.nodes.section as Extract<HostNode, { type: "section" }>),
      title: "Updated details",
    };
    next.nodes.child = {
      id: "child",
      type: "paragraph",
      content: [{ type: "text", text: "New detail" }],
    };
    next.roots.reverse();
    render(next);
    expect(container.querySelector('[data-node-id="stable"] p')).toBe(stable);
    expect(container.querySelector("h2 button")).toBe(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector("#review-section-section")).toHaveProperty(
      "hidden",
      false,
    );
    expect(container.textContent).toContain("New detail");

    // Reparenting changes React ancestry, but document-scoped UI state follows
    // stable node identity rather than a display title or array position.
    const moved = structuredClone(next);
    moved.version++;
    moved.nodes.callout = {
      id: "callout",
      type: "callout",
      tone: "info",
      title: "Note",
      children: ["section"],
    };
    moved.roots = ["stable", "callout"];
    render(moved);
    expect(
      container.querySelector("h2 button")?.getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("isolates missing evidence to its node and recovers when evidence arrives", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onError = vi.fn<(nodeId: string, error: Error) => void>();
    const state = documentState([
      { id: "broken", type: "code_peek", anchorId: "source" },
      {
        id: "good",
        type: "paragraph",
        content: [{ type: "text", text: "Still readable" }],
      },
    ]);
    const quote = state.evidence.source!;
    delete state.evidence.source;
    render(state, { onError });
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(container.textContent).toContain("Still readable");
    expect(onError).toHaveBeenCalledWith("broken", expect.any(Error));
    render({ ...state, version: 2, evidence: { source: quote } }, { onError });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector("pre")?.textContent).toBe(quote.text);
  });

  it("animates only changed nodes, using opacity, and respects reduced motion", () => {
    const state = documentState([
      {
        id: "first",
        type: "paragraph",
        content: [{ type: "text", text: "One" }],
      },
      {
        id: "second",
        type: "paragraph",
        content: [{ type: "text", text: "Two" }],
      },
    ]);
    render(state);
    const first = container.querySelector<HTMLElement>(
      '[data-node-id="first"] > .host-document-node-content',
    )!;
    const second = container.querySelector<HTMLElement>(
      '[data-node-id="second"] > .host-document-node-content',
    )!;
    const animateFirst = vi.fn<HTMLElement["animate"]>();
    const animateSecond = vi.fn<HTMLElement["animate"]>();
    first.animate = animateFirst;
    second.animate = animateSecond;
    const next = structuredClone(state);
    next.version++;
    next.nodes.first = {
      id: "first",
      type: "paragraph",
      content: [{ type: "text", text: "Changed" }],
    };
    render(next);
    expect(animateFirst).toHaveBeenCalledWith(
      [{ opacity: 0.35 }, { opacity: 1 }],
      { duration: 320, easing: "ease-out" },
    );
    expect(animateSecond).not.toHaveBeenCalled();

    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    animateFirst.mockClear();
    render({
      ...next,
      version: 3,
      nodes: { ...next.nodes, first: state.nodes.first! },
    });
    expect(animateFirst).not.toHaveBeenCalled();
  });
});
