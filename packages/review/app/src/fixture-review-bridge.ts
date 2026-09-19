import type { JsonValue, ReviewCanvasBridge } from "@dev.fast/review-protocol";
import { act } from "react";

import type { Snapshot } from "../../src/review-api/store";
import { testReviewBridge } from "./review-session-test-utils";

/** The subset of the review API a pinned-version canvas reads while mounting. */
export interface FixtureReviewApi {
  snapshot: Snapshot;
  /** Resource id to its JSON body, or to bytes with a content type. */
  resources?: Record<string, JsonValue | FixtureBytes>;
  maps?: Record<string, JsonValue>;
}

// A lens or map routes its edges through libavoid; Vite serves the wasm from
// node_modules when a browser test names it by file URL.
export const libavoidWasmUrl = new URL(
  "../../../../node_modules/@mr_mint/elkjs-libavoid/dist/libavoid.wasm",
  import.meta.url,
).href;

export interface FixtureBytes {
  bytes: Uint8Array<ArrayBuffer>;
  type: string;
}

const isBytes = (value: JsonValue | FixtureBytes): value is FixtureBytes =>
  value instanceof Object && "bytes" in value && "type" in value;

/**
 * A bridge whose request handler answers from fixtures, so a browser test can
 * mount the JSON canvas without a store. Mount with the snapshot's version so
 * the canvas reads once instead of opening a watch stream.
 */
export function fixtureReviewBridge(api: FixtureReviewApi): ReviewCanvasBridge {
  const request = async (url: string | URL): Promise<Response> => {
    const { pathname, searchParams } = new URL(String(url));
    const route = pathname.slice(pathname.indexOf("/reviews-api") + 12);
    const id = api.snapshot.reviewId;

    if (route === `/${id}` && searchParams.get("full") === "true")
      return Response.json(api.snapshot);

    if (route === `/${id}/progress`)
      return Response.json({ files: [], diagrams: [] });

    if (route === `/${id}/diff`)
      return Response.json(searchParams.has("file") ? "" : []);

    if (route === `/${id}/commits`) return Response.json([]);

    if (route === `/${id}/history`)
      return Response.json([
        { version: api.snapshot.version, createdAt: api.snapshot.createdAt },
      ]);

    const map = /^\/[^/]+\/maps\/([^/]+)$/.exec(route);

    if (map && api.maps && Object.hasOwn(api.maps, map[1]!))
      return Response.json(api.maps[map[1]!]);

    const resource = /^\/([^/]+)\/resources\/([^/]+)$/.exec(route);

    if (
      resource &&
      resource[1] === id &&
      api.resources &&
      Object.hasOwn(api.resources, resource[2]!)
    ) {
      const value = api.resources[resource[2]!];

      return isBytes(value)
        ? new Response(new Blob([value.bytes]), {
            headers: { "content-type": value.type },
          })
        : Response.json(value);
    }

    return Response.json({ error: `No fixture for ${route}` }, { status: 404 });
  };

  return testReviewBridge(
    { wasmUrl: libavoidWasmUrl },
    {
      request,
      // A code peek asks the host for an inline editor; a placeholder proves it did.
      inlineEditors: {
        async find() {
          return { matchCount: 0 };
        },
        create: (spec) => {
          const editor = document.createElement("div");
          editor.className = "fixture-inline-editor";
          editor.dataset.path = spec.path;
          spec.container.appendChild(editor);

          return {
            height: 180,
            setActive() {},
            setCollapsed() {},
            async setFindQuery() {
              return { matchCount: 0 };
            },
            revealFindMatch() {},
            clearActiveFindMatch() {},
            clearFind() {},
            onDidChangeHeight: () => ({ dispose() {} }),
            onDidError: () => ({ dispose() {} }),
            dispose: () => {
              editor.remove();
            },
          };
        },
      },
      diffView: {
        files: async () => [],
        create: () => {
          throw new Error("Diff is not mounted by this test.");
        },
      },
    },
  );
}

/**
 * Poll while flushing React: in the act environment, updates queued by the
 * canvas's fetches only commit inside act, so a plain poll sees the first paint.
 */
export async function settled<T>(read: () => T, timeout = 10_000): Promise<T> {
  const deadline = Date.now() + timeout;
  let value = read();

  while (!value && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await act(async () => {});
    value = read();
  }

  return value;
}
