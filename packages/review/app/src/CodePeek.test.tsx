// @vitest-environment jsdom

import type {
  ReviewInlineEditorSpec,
  ReviewVerbRequest,
} from "@dev.fast/review-protocol";
import { type ReactNode, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CodePeek,
  CodePeekCard,
  CodePeekGroup,
  validatedCodePeekInputFromRef,
} from "./CodePeek";
import {
  type ReviewSession,
  ReviewSessionProvider,
} from "./host/review-session";
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
  it("renders one native editor per authored file in a grouped side peek", async () => {
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
              fromLine: 22,
              toLine: 23,
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

    expect(created).toHaveLength(2);
    expect(created).toMatchObject([
      {
        path: "src/current.ts",
        side: "head",
        countRanges: [
          { startLine: 20, endLine: 24, side: "head" },
          { startLine: 22, endLine: 23, side: "head" },
          { startLine: 80, endLine: 82, side: "head" },
          { startLine: 50, endLine: 50, side: "base" },
        ],
        ranges: [
          { startLine: 20, endLine: 24 },
          { startLine: 80, endLine: 82 },
          { startLine: 50, endLine: 50, side: "base" },
        ],
        heightMode: "content",
      },
      {
        path: "src/other.ts",
        ranges: [{ startLine: 4, endLine: 4 }],
        heightMode: "content",
      },
    ]);
  });

  it("lets the software-map sidebar scroll one content-height diff feed", async () => {
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

  it("mounts each editor without a React header and opens from the native action", async () => {
    const input = validatedCodePeekInputFromRef({
      side: "base",
      file: "src/previous.ts",
      fromLine: 7,
      toLine: 9,
    });

    const secondInput = validatedCodePeekInputFromRef({
      side: "head",
      file: "src/current.ts",
      fromLine: 20,
      toLine: 20,
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
      },
      {
        path: "src/current.ts",
        side: "head",
        title: "src/current.ts:20",
        heightMode: "capped",
      },
    ]);
    expect(
      [...container.querySelectorAll("[data-review-inline-editor]")].every(
        (placeholder) =>
          placeholder.querySelector(".fixture-inline-editor") !== null,
      ),
    ).toBe(true);

    expect(container.querySelector(".code-peek-card")).toBeNull();
    expect(created[0]?.onDidOpen).toBeTypeOf("function");

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

  it("gives range side peeks a source title and content height policy", async () => {
    const input = validatedCodePeekInputFromRef({
      side: "head",
      file: "src/example.ts",
      fromLine: 1,
      toLine: 3,
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
        side: "head",
        file: `src/target-${index}.ts`,
        fromLine: index + 1,
        toLine: index + 1,
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

  it("recreates a native editor when the Review session changes", async () => {
    const input = validatedCodePeekInputFromRef({
      side: "head",
      file: "src/current.ts",
      fromLine: 20,
      toLine: 20,
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
      currentDiffLayout: () => "split",
      async setDiffLayout() {},
      onDidChangeDiffLayout: () => ({ dispose() {} }),
      ready() {},
    },
  );
}
