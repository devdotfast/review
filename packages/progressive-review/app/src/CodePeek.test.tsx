// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";

import type {
  ReviewInlineEditorSpec,
  ReviewVerbRequest,
} from "@dev.fast/review-protocol";
import { type ReactNode, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PeekableAnchorRef } from "../../src/authoring";
import {
  CodePeek,
  CodePeekCard,
  CodePeekGroup,
  ReviewCodePeek,
  codePeekSubject,
  validatedCodePeekInputFromRef,
} from "./CodePeek";
import {
  type ReviewSession,
  ReviewSessionProvider,
} from "./host/review-session";
import { testCodePeekResolution } from "./review-definition-test-utils";
import { ReviewDiffFilesProvider } from "./review-diff-files-context";
import { testReviewSession } from "./review-session-test-utils";

let root: ReturnType<typeof createRoot> | undefined;
let posted: ReviewVerbRequest[] = [];
let created: ReviewInlineEditorSpec[] = [];
let disposed: ReviewInlineEditorSpec[] = [];
let session: ReviewSession;

beforeEach(() => {
  (
    globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  posted = [];
  created = [];
  disposed = [];
  session = createTestSession();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CodePeek native editor", () => {
  it("renders one native editor per resolved file in a grouped side peek", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_request, init) => {
        const request = JSON.parse(String(init?.body)) as {
          root: {
            kind: "range";
            file: string;
            fromLine: number;
            toLine: number;
          };
        };
        const { file, fromLine, toLine } = request.root;
        const sourceId = `source-range:${file}:${fromLine}-${toLine}`;
        const snapshot = {
          roots: [{ kind: "source", sourceId }],
          resolved: {
            [sourceId]: {
              source: {
                id: sourceId,
                name: `${path.basename(file)} L${fromLine}-L${toLine}`,
                kind: "source-range",
                file,
                line: fromLine,
                endLine: toLine,
              },
              lines: [],
            },
          },
        };
        return new Response(
          JSON.stringify({
            ok: true,
            snapshot,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      renderWithSession(
        <CodePeekGroup
          peeks={[
            {
              file: "src/current.ts",
              fromLine: 20,
              toLine: 24,
              graph: "head",
            },
            {
              file: "src/current.ts",
              fromLine: 80,
              toLine: 82,
              graph: "head",
            },
            {
              file: "src/current.ts",
              fromLine: 50,
              toLine: 50,
              graph: "base",
            },
            {
              file: "src/other.ts",
              fromLine: 4,
              toLine: 4,
              graph: "head",
            },
          ]}
        />,
      );
    });

    await vi.waitFor(() => expect(created).toHaveLength(2));
    expect(created).toMatchObject([
      {
        path: "src/current.ts",
        side: "head",
        ranges: [
          { startLine: 20, endLine: 24 },
          { startLine: 80, endLine: 82 },
          { startLine: 50, endLine: 50, side: "base" },
        ],
        heightMode: "content",
        commentsEnabled: true,
      },
      {
        path: "src/other.ts",
        ranges: [{ startLine: 4, endLine: 4 }],
        heightMode: "content",
        commentsEnabled: true,
      },
    ]);
  });

  it("lets the software-map sidebar scroll one content-height diff feed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              snapshot: { roots: [], resolved: {} },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      renderWithSession(
        <CodePeek
          file="src/current.ts"
          fromLine={20}
          toLine={24}
          graph="head"
        />,
      );
    });

    await vi.waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatchObject({
      path: "src/current.ts",
      ranges: [{ startLine: 20, endLine: 24 }],
      heightMode: "content",
    });
  });

  it("does not create an inline editor before a range resolves", () => {
    const input = validatedCodePeekInputFromRef({
      __kind: "code-peek-ref",
      props: {
        file: "src/current.ts",
        fromLine: 20,
        toLine: 20,
        graph: "head",
      },
      resolution: { snapshot: { roots: [], resolved: {} } },
    });

    expect(codePeekSubject(input, null)).toBeUndefined();
  });

  it("mounts each editor without a React header and opens from the native action", async () => {
    const input = validatedCodePeekInputFromRef({
      __kind: "code-peek-ref",
      props: {
        file: "src/previous.ts",
        fromLine: 7,
        toLine: 9,
        graph: "base",
      },
      resolution: { snapshot: { roots: [], resolved: {} } },
    });
    const secondInput = validatedCodePeekInputFromRef({
      __kind: "code-peek-ref",
      props: {
        file: "src/current.ts",
        fromLine: 20,
        toLine: 20,
        graph: "head",
      },
      resolution: { snapshot: { roots: [], resolved: {} } },
    });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () =>
      renderWithSession(
        <>
          <CodePeekCard input={input} />
          <CodePeekCard input={secondInput} />
        </>,
      ),
    );
    expect(created).toMatchObject([
      {
        path: "src/previous.ts",
        side: "base",
        title: "src/previous.ts:7-9",
        heightMode: "capped",
        commentsEnabled: false,
      },
      {
        path: "src/current.ts",
        side: "head",
        title: "src/current.ts:20",
        heightMode: "capped",
        commentsEnabled: false,
      },
    ]);
    expect(
      [...container.querySelectorAll("[data-review-inline-editor]")].every(
        (placeholder) =>
          placeholder.querySelector(".fixture-inline-editor") !== null,
      ),
    ).toBe(true);

    expect(container.querySelector(".code-peek-card")).toBeNull();
    expect(typeof created[0]?.onDidOpen).toBe("function");

    await act(async () => {
      created[0]?.onDidOpen?.();
    });

    expect(posted.at(-1)).toEqual({
      name: "reveal",
      args: {
        path: "src/previous.ts",
        startLine: 7,
        endLine: 9,
        side: "base",
        highlight: true,
        preserveFocus: false,
      },
    });
  });

  it("enables native comments only for an authored CodePeek", async () => {
    const anchor: PeekableAnchorRef = {
      __kind: "db-anchor-ref",
      id: "authored-code",
      title: "Authored code",
      peek: {
        __kind: "code-peek-ref",
        props: {
          file: "src/example.ts",
          fromLine: 1,
          toLine: 3,
          graph: "head",
        },
        resolution: testCodePeekResolution(),
      },
    };
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () =>
      renderWithSession(<ReviewCodePeek anchor={anchor} />),
    );

    expect(created).toHaveLength(1);
    expect(created[0]?.commentsEnabled).toBe(true);
  });

  it("separates consecutive code peeks in document flow", () => {
    const styles = readFileSync(
      path.resolve(process.cwd(), "app/src/styles.css"),
      "utf8",
    );

    expect(styles).toMatch(
      /\.review-document\s*>\s*\.code-peek\s*\+\s*\.code-peek,\s*\.review-section-body\s*>\s*\.code-peek\s*\+\s*\.code-peek\s*\{[^}]*margin-block-start:\s*14px;/s,
    );
  });

  it("gives range side peeks a source title and content height policy", async () => {
    const input = validatedCodePeekInputFromRef({
      __kind: "code-peek-ref",
      props: { file: "src/example.ts", fromLine: 1, toLine: 3, graph: "head" },
      resolution: testCodePeekResolution(),
    });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () =>
      renderWithSession(<CodePeekCard input={input} heightMode="content" />),
    );

    expect(created[0]).toMatchObject({
      path: "src/example.ts",
      ranges: [{ startLine: 1, endLine: 3 }],
      title: "src/example.ts:1-3",
      heightMode: "content",
    });
  });

  it("disposes every prior editor while rapidly retargeting one inline surface", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    for (let index = 0; index < 50; index += 1) {
      const input = validatedCodePeekInputFromRef({
        __kind: "code-peek-ref",
        props: {
          file: `src/target-${index}.ts`,
          fromLine: index + 1,
          toLine: index + 1,
          graph: "head",
        },
        resolution: { snapshot: { roots: [], resolved: {} } },
      });
      await act(async () => renderWithSession(<CodePeekCard input={input} />));
    }

    expect(created).toHaveLength(50);
    expect(disposed).toHaveLength(49);
    expect(
      container.querySelectorAll(
        "[data-review-inline-editor] > .fixture-inline-editor",
      ),
    ).toHaveLength(1);

    await act(async () => root!.unmount());
    root = undefined;
    expect(disposed).toHaveLength(50);
  });

  it("uses symbol-local counts without losing shared file metadata", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              files: [
                {
                  path: "src/current.ts",
                  previousPath: "src/previous.ts",
                  status: "renamed",
                  additions: 8,
                  deletions: 3,
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const input = validatedCodePeekInputFromRef({
      __kind: "code-peek-ref",
      props: {
        file: "src/previous.ts",
        fromLine: 7,
        toLine: 9,
        graph: "base",
      },
      resolution: {
        snapshot: { roots: [], resolved: {} },
        diff: {
          orientation: "base",
          files: [
            {
              path: "src/current.ts",
              previousPath: "src/previous.ts",
              status: "renamed",
              additions: 1,
              deletions: 1,
              patch: "",
            },
          ],
        },
      },
    });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      renderWithSession(
        <ReviewDiffFilesProvider documentKey="review">
          <CodePeekCard input={input} />
        </ReviewDiffFilesProvider>,
      );
      await Promise.resolve();
    });

    expect(container.querySelector(".code-peek-card")).toBeNull();
    expect(created[0]?.diffStats).toEqual({ additions: 1, deletions: 1 });
  });

  it("keeps a resolved inline editor neutral when diff metadata fails", async () => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => {
        throw new Error("diff metadata unavailable");
      }),
    );
    const input = validatedCodePeekInputFromRef({
      __kind: "code-peek-ref",
      props: {
        file: "src/current.ts",
        fromLine: 20,
        toLine: 20,
        graph: "head",
      },
      resolution: { snapshot: { roots: [], resolved: {} } },
    });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      renderWithSession(
        <ReviewDiffFilesProvider documentKey="review">
          <CodePeekCard input={input} />
        </ReviewDiffFilesProvider>,
      );
      await Promise.resolve();
    });

    expect(container.querySelector(".code-peek-card")).toBeNull();
    expect(created[0]?.diffStats).toBeUndefined();
    expect(typeof created[0]?.onDidOpen).toBe("function");
    expect(
      container.querySelector("[data-review-inline-editor]"),
    ).not.toBeNull();
  });

  it("recreates a native editor when the Review session changes", async () => {
    const input = validatedCodePeekInputFromRef({
      __kind: "code-peek-ref",
      props: {
        file: "src/current.ts",
        fromLine: 20,
        toLine: 20,
        graph: "head",
      },
      resolution: { snapshot: { roots: [], resolved: {} } },
    });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => renderWithSession(<CodePeekCard input={input} />));
    expect(created).toHaveLength(1);

    session = createTestSession("next-session");
    await act(async () => renderWithSession(<CodePeekCard input={input} />));

    expect(disposed).toHaveLength(1);
    expect(created).toHaveLength(2);
  });
});

function renderWithSession(node: ReactNode) {
  root!.render(
    <ReviewSessionProvider session={session}>{node}</ReviewSessionProvider>,
  );
}

function createTestSession(sessionId = "test"): ReviewSession {
  return testReviewSession(
    {
      sessionUrl: "http://127.0.0.1:5570/sessions/test",
      routePath: "/",
      sessionId,
      token: "",
    },
    {
      diffView: {
        create: () => {
          throw new Error("unused test diff view");
        },
      },
      inlineEditors: {
        async find() {
          return { matchCount: 0 };
        },
        create: (spec) => {
          created.push(spec);
          const editor = document.createElement("div");
          editor.className = "fixture-inline-editor";
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
              disposed.push(spec);
              editor.remove();
            },
          };
        },
      },
      post: async (request) => {
        posted.push(request);
        return { ok: true };
      },
      subscribe: () => ({ dispose() {} }),
      currentTheme: () => "dark",
      onDidChangeTheme: () => ({ dispose() {} }),
      ready() {},
    },
  );
}
