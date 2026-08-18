import { describe, expect, it } from "vitest";

import type { AnchorRef } from "../../src/authoring";
import {
  type CommentDraftTarget,
  buildLineCommentsForAnchor,
  commentDraftTargetForSurface,
  createAstLineCommentTarget,
  createBaseAstLineCommentDraftTarget,
  isGlobalCommentDraft,
  selectCommentsForAnchor,
} from "./review-context";
import { buildCodeTarget } from "./target-fingerprint";

describe("comment draft surface routing", () => {
  const panelDraft: CommentDraftTarget = {
    threadId: "draft-thread",
    messageId: "draft-message",
    target: { kind: "document" },
    body: "",
    draftSurface: "panel",
  };

  it("routes a panel-owned draft only to panel hosts", () => {
    expect(commentDraftTargetForSurface(panelDraft, "panel")).toBe(panelDraft);
    expect(commentDraftTargetForSurface(panelDraft, "document")).toBeNull();
  });

  it("does not route a missing draft to either host", () => {
    expect(commentDraftTargetForSurface(null, "panel")).toBeNull();
    expect(commentDraftTargetForSurface(null, "document")).toBeNull();
  });

  it("identifies only whole-document drafts as global comments", () => {
    expect(
      isGlobalCommentDraft({ ...panelDraft, draftSurface: "document" }),
    ).toBe(true);
    expect(isGlobalCommentDraft(panelDraft)).toBe(false);
    expect(
      isGlobalCommentDraft({
        ...panelDraft,
        draftSurface: "document",
        target: {
          kind: "text",
          surface: { type: "block", tag: "p", index: 0, blockHash: "abc" },
          selection: { start: 0, length: 2, hash: "def", quote: "hi" },
        },
      }),
    ).toBe(false);
  });
});

describe("anchor comment plumbing", () => {
  it("finds code threads by canonical identity", () => {
    const anchor = runtimeAnchor();
    const codeTarget = buildCodeTarget({
      path: "src/runtime.ts",
      side: "head",
      baseCommit: "base-commit",
      headCommit: "head-commit",
      span: { startLine: 41, endLine: 41 },
    });
    const otherTarget = buildCodeTarget({
      path: "src/other.ts",
      side: "head",
      baseCommit: "base-commit",
      headCommit: "head-commit",
      span: { startLine: 41, endLine: 41 },
    });
    const comments = selectCommentsForAnchor(
      [
        {
          threadId: "code-thread",
          target: codeTarget,
          status: "open",
          messages: [
            {
              id: "message-1",
              by: "Reviewer",
              at: "2026-01-01T00:00:00.000Z",
              body: "Check this code.",
              agentInput: false,
            },
          ],
        },
        {
          threadId: "other-thread",
          target: otherTarget,
          status: "open",
          messages: [],
        },
      ],
      new Map(),
      anchor,
      { baseRef: "base-commit", headRef: "head-commit" },
    );

    expect(comments).toMatchObject([
      { threadId: "code-thread", clientStatus: "persisted" },
    ]);
  });

  it("shows a base-side thread in a diff CodePeek for the same file", () => {
    const anchor = runtimeAnchor();
    if (!anchor.peek?.resolution) throw new Error("Expected a resolved peek.");
    anchor.peek.resolution.diff = {
      baseRef: "base-commit",
      headRef: "head-commit",
      orientation: "head",
      files: [
        {
          path: "src/runtime.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
        },
      ],
    };
    const target = buildCodeTarget({
      path: "src/runtime.ts",
      side: "base",
      baseCommit: "base-commit",
      headCommit: "head-commit",
      span: { startLine: 400, endLine: 400 },
    });

    expect(
      selectCommentsForAnchor(
        [
          {
            threadId: "base-thread",
            target,
            status: "open",
            messages: [],
          },
        ],
        new Map(),
        anchor,
        { baseRef: "base-commit", headRef: "head-commit" },
      ),
    ).toMatchObject([{ threadId: "base-thread" }]);
  });

  it("creates an inclusive multi-line repository code target", () => {
    const anchor = runtimeAnchor();

    expect(
      createAstLineCommentTarget(
        anchor,
        { fromLine: 41, toLine: 42 },
        { baseRef: "base-commit", headRef: "head-commit" },
      ),
    ).toMatchObject({
      title: "src/runtime.ts:L41-L42",
      target: {
        kind: "code",
        original_position: {
          base_sha: "base-commit",
          start_sha: "base-commit",
          head_sha: "head-commit",
          old_path: "src/runtime.ts",
          new_path: "src/runtime.ts",
          position_type: "text",
          line_range: {
            start: { type: "new", old_line: null, new_line: 41 },
            end: { type: "new", old_line: null, new_line: 42 },
          },
        },
        position: {
          base_sha: "base-commit",
          start_sha: "base-commit",
          head_sha: "head-commit",
          old_path: "src/runtime.ts",
          new_path: "src/runtime.ts",
          position_type: "text",
          line_range: {
            start: { type: "new", old_line: null, new_line: 41 },
            end: { type: "new", old_line: null, new_line: 42 },
          },
        },
      },
    });
  });

  it("builds a deleted-line target from base source only when submitted", async () => {
    const anchor: AnchorRef = {
      __kind: "db-anchor-ref",
      id: "runtime",
      title: "Runtime",
      peek: {
        __kind: "code-peek-ref",
        props: { file: "src/example.ts", fromLine: 1, toLine: 3 },
        resolution: null,
      },
    };
    let resolveCount = 0;
    const draft = createBaseAstLineCommentDraftTarget(
      anchor,
      { fromLine: 40, toLine: 41, side: "deletions" },
      "base-commit",
      "head-commit",
      async () => {
        resolveCount += 1;
        return {
          text: "one\ntwo\nthree",
          file: "src/runtime.ts",
          fromLine: 40,
        };
      },
    );

    expect(resolveCount).toBe(0);
    expect(draft.panelRange).toEqual({
      fromLine: 40,
      toLine: 41,
      side: "deletions",
    });
    await expect(draft.resolveTarget?.()).resolves.toMatchObject({
      kind: "code",
      original_position: {
        base_sha: "base-commit",
        start_sha: "base-commit",
        head_sha: "head-commit",
        old_path: "src/runtime.ts",
        new_path: "src/runtime.ts",
        position_type: "text",
        line_range: {
          start: { type: "old", old_line: 40, new_line: null },
          end: { type: "old", old_line: 41, new_line: null },
        },
      },
      position: {
        base_sha: "base-commit",
        start_sha: "base-commit",
        head_sha: "head-commit",
        old_path: "src/runtime.ts",
        new_path: "src/runtime.ts",
        position_type: "text",
        line_range: {
          start: { type: "old", old_line: 40, new_line: null },
          end: { type: "old", old_line: 41, new_line: null },
        },
      },
    });
    expect(resolveCount).toBe(1);
  });

  it("reports authored code comments by their content line", () => {
    const anchor = runtimeAnchor();
    const target = buildCodeTarget({
      path: "src/runtime.ts",
      side: "head",
      baseCommit: "base-commit",
      headCommit: "head-commit",
      span: { startLine: 41, endLine: 41 },
    });

    expect(
      buildLineCommentsForAnchor(
        anchor,
        [
          {
            threadId: "thread-1",
            target,
            status: "open",
            messages: [
              {
                id: "message-1",
                by: "Reviewer",
                at: "2026-01-01T00:00:00.000Z",
                body: "Check the response.",
                agentInput: false,
              },
            ],
          },
        ],
        { baseRef: "base-commit", headRef: "head-commit" },
      ),
    ).toEqual([
      {
        rootIndex: 0,
        path: [],
        file: "src/runtime.ts",
        line: 41,
        count: 1,
      },
    ]);
  });
});

function runtimeAnchor(): AnchorRef {
  const sourceId = "source-range:src/runtime.ts:40-42";
  return {
    __kind: "db-anchor-ref",
    id: "runtime",
    title: "Runtime",
    peek: {
      __kind: "code-peek-ref",
      props: { file: "src/example.ts", fromLine: 1, toLine: 3 },
      resolution: {
        snapshot: {
          roots: [{ kind: "source", sourceId }],
          resolved: {
            [sourceId]: {
              source: {
                id: sourceId,
                name: "runtime.ts L40-L42",
                kind: "source-range",
                file: "src/runtime.ts",
                line: 40,
                endLine: 42,
              },
              lines: [
                [{ t: "one", k: "t" }],
                [{ t: "two", k: "t" }],
                [{ t: "three", k: "t" }],
              ],
            },
          },
        },
      },
    },
  };
}
