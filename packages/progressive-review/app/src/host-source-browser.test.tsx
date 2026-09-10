// @vitest-environment jsdom
import {
  type HostDocumentState,
  type HostQuery,
  HostQuerySchema,
  type JsonValue,
  ReviewClient,
  type ReviewHostSourceBridge,
} from "@dev.fast/review-protocol";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HostSourceBrowser } from "./host-source-browser";

const id = "109b9649-0d32-49a9-9773-cdb518e92a32";
const at = "2026-09-10T12:00:00Z";
const state: HostDocumentState = {
  schemaVersion: 1,
  documentId: id,
  reviewId: id,
  version: 7,
  roots: [],
  nodes: {},
  definitions: {},
  evidence: {},
  contentHash: "a".repeat(64),
  createdAt: at,
  binding: {
    id,
    repositoryId: id,
    selector: { kind: "range", baseRef: "base", headRef: "head" },
    baseCommit: "b".repeat(40),
    headCommit: "c".repeat(40),
    createdAt: at,
  },
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function fixture(respond: (request: HostQuery) => JsonValue) {
  const requests: HostQuery[] = [];
  const client = await ReviewClient.connect({
    serverUrl: "http://127.0.0.1:58211",
    token: "test-credential",
    fetch: async (url, init) => {
      if (String(url).endsWith("/connection"))
        return Response.json({
          apiVersion: 1,
          hostId: id,
          workspaceId: id,
          principal: { id, kind: "human", displayName: "Reader" },
        });
      const request = HostQuerySchema.parse(JSON.parse(String(init?.body)));
      requests.push(request);
      try {
        return Response.json({
          ok: true,
          data: { result: respond(request), eventCursor: "cursor" },
        });
      } catch {
        return Response.json(
          {
            ok: false,
            error: {
              code: "DEPENDENCY_UNAVAILABLE",
              retryable: true,
              diagnostics: [],
              message: "Pinned source is unavailable.",
            },
          },
          { status: 503 },
        );
      }
    },
  });
  return { client, requests };
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === label,
  );
  if (!button) throw new Error(`Button ${label} missing`);
  await act(async () => button.click());
}

describe("API-backed pinned source browser", () => {
  it("resets revision-bound pagination without leaving the selected directory on a live update", async () => {
    const f = await fixture((request): JsonValue => {
      if (request.type !== "source.tree") throw new Error("Unexpected query");
      const { directory, documentVersion, cursor } = request.input;
      if (!directory)
        return {
          items: [{ path: "src", kind: "directory", objectId: "a".repeat(40) }],
          nextCursor: null,
        };
      if (cursor && cursor !== `page-two-v${documentVersion}`)
        throw new Error("Cursor belongs to another document version");
      return {
        items: [
          {
            path: `src/${cursor ? "last" : "first"}-v${documentVersion}.ts`,
            kind: "file",
            objectId: "a".repeat(40),
            byteLength: 20,
          },
        ],
        nextCursor: cursor ? null : `page-two-v${documentVersion}`,
      };
    });
    await act(async () =>
      root.render(<HostSourceBrowser client={f.client} document={state} />),
    );
    await click("src/");
    await click("Next page");
    expect(container.textContent).toContain("last-v7.ts");

    await act(async () =>
      root.render(
        <HostSourceBrowser
          client={f.client}
          document={{ ...state, version: 8 }}
        />,
      ),
    );
    expect(container.textContent).toContain("first-v8.ts");
    expect(container.querySelector("[role=alert]")).toBeNull();
    const updatedRequests = f.requests.filter(
      (request) =>
        request.type === "source.tree" && request.input.documentVersion === 8,
    );
    expect(updatedRequests).toHaveLength(1);
    expect(updatedRequests[0]).toMatchObject({
      type: "source.tree",
      input: { directory: "src", side: "head" },
    });
    expect(updatedRequests[0]!.input).not.toHaveProperty("cursor");
    await click("Next page");
    expect(container.textContent).toContain("last-v8.ts");
  });

  it("opens nested files at the observed version without following symlinks", async () => {
    const f = await fixture((request): JsonValue => {
      if (request.type !== "source.tree") throw new Error("Unexpected query");
      return {
        items: request.input.directory
          ? [
              {
                path: "src/file.ts",
                kind: "file",
                objectId: "a".repeat(40),
                byteLength: 18,
              },
              {
                path: "src/private-link",
                kind: "symlink",
                objectId: "a".repeat(40),
              },
            ]
          : [{ path: "src", kind: "directory", objectId: "a".repeat(40) }],
        nextCursor: null,
      };
    });
    const open = vi.fn<ReviewHostSourceBridge["open"]>(async () => {});
    await act(async () =>
      root.render(
        <HostSourceBrowser
          client={f.client}
          document={state}
          source={{
            open,
            createPeek: () => {
              throw new Error("Unused");
            },
          }}
        />,
      ),
    );
    await click("src/");
    expect(container.textContent).toContain(
      "private-link · symlink (not followed)",
    );
    await click("file.ts");
    expect(open).toHaveBeenCalledWith({
      reviewId: id,
      documentVersion: 7,
      range: { side: "head", file: "src/file.ts", fromLine: 1, toLine: 1 },
    });
    expect(f.requests.at(-1)).toMatchObject({
      type: "source.tree",
      input: { documentVersion: 7, directory: "src" },
    });
    const select = container.querySelector("select")!;
    await act(async () => {
      select.value = "base";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(f.requests.at(-1)).toMatchObject({
      type: "source.tree",
      input: { side: "base", documentVersion: 7 },
    });
    expect(f.requests.at(-1)!.input).not.toHaveProperty("directory");
  });

  it("uses renamed base paths and displays pinned commit history", async () => {
    const f = await fixture((request): JsonValue => {
      if (request.type === "source.tree")
        return { items: [], nextCursor: null };
      if (request.type === "source.diff")
        return {
          items: [
            {
              path: "new.ts",
              previousPath: "old.ts",
              status: "renamed",
              binary: false,
              additions: 2,
              deletions: 1,
            },
          ],
          nextCursor: null,
        };
      if (request.type === "source.commits")
        return {
          items: [
            {
              oid: "c".repeat(40),
              parents: ["b".repeat(40)],
              subject: "Move source file",
              author: "A reviewer",
              at,
            },
          ],
          nextCursor: null,
        };
      throw new Error("Unexpected query");
    });
    const open = vi.fn<ReviewHostSourceBridge["open"]>(async () => {});
    await act(async () =>
      root.render(
        <HostSourceBrowser
          client={f.client}
          document={state}
          source={{
            open,
            createPeek: () => {
              throw new Error("Unused");
            },
          }}
        />,
      ),
    );
    await click("Changes");
    expect(container.textContent).toContain("old.ts → new.ts");
    await click("Base");
    expect(open).toHaveBeenLastCalledWith(
      expect.objectContaining({
        range: expect.objectContaining({ side: "base", file: "old.ts" }),
      }),
    );
    await click("Head");
    expect(open).toHaveBeenLastCalledWith(
      expect.objectContaining({
        range: expect.objectContaining({ side: "head", file: "new.ts" }),
      }),
    );
    await click("Commits");
    expect(container.textContent).toContain("Move source file");
    expect(f.requests.at(-1)).toMatchObject({
      type: "source.commits",
      input: { documentVersion: 7 },
    });
  });

  it("renders source text inertly without a native bridge and recovers an unavailable query", async () => {
    let available = false;
    const f = await fixture((request): JsonValue => {
      if (!available) throw new Error("Offline");
      if (request.type === "source.tree")
        return {
          items: [
            {
              path: "file.html",
              kind: "file",
              objectId: "a".repeat(40),
              byteLength: 50,
            },
          ],
          nextCursor: null,
        };
      if (request.type === "source.file")
        return {
          repositoryId: id,
          commit: state.binding.headCommit,
          blob: "a".repeat(40),
          file: "file.html",
          text: "<script>window.leaked = true</script>",
          sha256: "a".repeat(64),
        };
      throw new Error("Unexpected query");
    });
    await act(async () =>
      root.render(<HostSourceBrowser client={f.client} document={state} />),
    );
    expect(container.querySelector("[role=alert]")?.textContent).toContain(
      "Pinned source is unavailable",
    );
    available = true;
    await click("Retry source read");
    await click("file.html");
    expect(container.querySelector("pre")?.textContent).toContain("<script>");
    expect(container.querySelector("script")).toBeNull();
  });
});
