import { afterEach, expect, it, vi } from "vitest";

import {
  createBrowserReviewDefinitionSession,
  runWithCodePeekResolutionSlot,
} from "./review-definition-runtime";
import { defineSoftwareModel } from "./software-map/model";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("bounds concurrent SSR CodePeek requests to the running server", async () => {
  let active = 0;
  let maximumActive = 0;

  await Promise.all(
    Array.from({ length: 24 }, (_, index) =>
      runWithCodePeekResolutionSlot(async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return index;
      }),
    ),
  );

  expect(maximumActive).toBe(8);
});

it("supports map-free working-tree review documents", async () => {
  const session = createBrowserReviewDefinitionSession({
    routePath: "/",
    softwareMap: null,
    baseSoftwareMap: null,
  });
  session.begin();
  await expect(session.ready()).resolves.toBeUndefined();
});

it("resolves authoring peeks through the running review server during SSR", async () => {
  const sourceId = "source-range:src/example.ts:1-1";
  const fetchMock = vi.fn<typeof fetch>(async () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          ok: true,
          snapshot: {
            roots: [{ kind: "source", sourceId }],
            resolved: {
              [sourceId]: {
                source: {
                  id: sourceId,
                  name: "example.ts L1-L1",
                  kind: "source-range",
                  file: "src/example.ts",
                  line: 1,
                  endLine: 1,
                },
                lines: [[{ t: "export function example() {}", k: "t" }]],
              },
            },
          },
          diff: {
            orientation: "head",
            files: [
              {
                path: "src/example.ts",
                status: "modified",
                additions: 1,
                deletions: 1,
                patch:
                  "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-export function example() {}\n+export function example() { return true; }",
              },
            ],
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  const softwareMap = defineSoftwareModel({ systems: {} });
  const session = createBrowserReviewDefinitionSession({
    routePath: "/",
    softwareMap,
    baseSoftwareMap: softwareMap,
    requestOrigin: "http://localhost:5620/",
    requestToken: "ssr-secret",
  });

  session.defineAnchors({
    greeting: {
      title: "Greeting",
      peek: { file: "src/example.ts", fromLine: 1, toLine: 3 },
    },
  });
  await session.ready();

  expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
    "http://localhost:5620/__progressive-review/code-peek/resolve",
  );
  expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
    includeDiff: false,
    includeDiffSummary: true,
  });
  expect(
    new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("x-review-token"),
  ).toBe("ssr-secret");
});

it("leaves authoring peeks unresolved in the client for lazy loading", async () => {
  const fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
  const softwareMap = defineSoftwareModel({ systems: {} });
  const session = createBrowserReviewDefinitionSession({
    routePath: "/",
    softwareMap,
    baseSoftwareMap: softwareMap,
    resolveCodePeeks: false,
  });

  const anchors = session.defineAnchors({
    greeting: {
      title: "Greeting",
      peek: { file: "src/example.ts", fromLine: 1, toLine: 3 },
    },
  });

  await expect(session.ready()).resolves.toBeUndefined();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(anchors.greeting.peek.resolution).toBeNull();
  expect(Object.isFrozen(anchors.greeting.peek)).toBe(false);
});

it("creates a browser definition session without materialized software maps", async () => {
  const session = createBrowserReviewDefinitionSession({
    routePath: "/",
    softwareMap: null,
    baseSoftwareMap: null,
    resolveCodePeeks: false,
  });

  session.defineAnchors({
    greeting: {
      title: "Greeting",
      peek: { file: "src/example.ts", fromLine: 1, toLine: 3 },
    },
  });

  await expect(session.ready()).resolves.toBeUndefined();
});

it("resolves peeks from the bundle's embedded resolutions without a request", async () => {
  const sourceId = "source-range:src/example.ts:3-4";
  const resolution = {
    snapshot: {
      roots: [{ kind: "source", sourceId }],
      resolved: {
        [sourceId]: {
          source: {
            id: sourceId,
            name: "example.ts L3-L4",
            kind: "source-range",
            file: "src/example.ts",
            line: 3,
            endLine: 4,
          },
          lines: [
            [{ t: "const a = 1;", k: "t" }],
            [{ t: "const b = 2;", k: "t" }],
          ],
        },
      },
    },
  };
  vi.stubGlobal("__reviewEmbeddedCodePeeks", {
    "/": { "head|src/example.ts|3|4": resolution },
  });
  const fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);

  const session = createBrowserReviewDefinitionSession({
    routePath: "/",
    softwareMap: null,
    baseSoftwareMap: null,
  });
  session.begin();
  const anchors = session.defineAnchors({
    example: {
      title: "Example",
      peek: { file: "src/example.ts", fromLine: 3, toLine: 4 },
    },
  });
  await expect(session.ready()).resolves.toBeUndefined();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(anchors.example.peek?.resolution).toEqual(resolution);
});

it("fails a peek the published bundle does not carry", async () => {
  vi.stubGlobal("__reviewEmbeddedCodePeeks", { "/": {} });
  const session = createBrowserReviewDefinitionSession({
    routePath: "/",
    softwareMap: null,
    baseSoftwareMap: null,
  });
  session.begin();
  session.defineAnchors({
    example: {
      title: "Example",
      peek: { file: "src/example.ts", fromLine: 3, toLine: 4 },
    },
  });
  await expect(session.ready()).rejects.toThrow(/not in the published bundle/);
});
