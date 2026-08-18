import { createGitLabTextDiffPosition } from "@dev.fast/review-protocol";
import { describe, expect, it } from "vitest";

import type {
  AnchorRef,
  CodePeekProps,
  CodePeekResolution,
} from "../../src/authoring";
import type { ReviewCommentThreadRecord } from "../../src/types";
import { buildCodeTarget } from "./target-fingerprint";
import {
  anchorTargetRecords,
  buildThreadTargetIndex,
} from "./thread-target-index";

describe("canonical code thread projection", () => {
  it("returns one stored thread through overlapping range anchors", () => {
    const resolution = runtimeResolution();
    const anchors: AnchorRef[] = [
      reviewAnchor(
        "full-range",
        { file: "src/runtime.ts", fromLine: 40, toLine: 42 },
        resolution,
      ),
      reviewAnchor(
        "range",
        { file: "src/runtime.ts", fromLine: 40, toLine: 42 },
        resolution,
      ),
      reviewAnchor(
        "single-line",
        { file: "src/runtime.ts", fromLine: 41, toLine: 41 },
        resolution,
      ),
    ];
    const thread: ReviewCommentThreadRecord = {
      threadId: "shared-thread",
      target: buildCodeTarget({
        path: "src/runtime.ts",
        side: "head",
        baseCommit: "base-commit",
        headCommit: "head-commit",
        span: { startLine: 41, endLine: 41 },
      }),
      status: "open",
      messages: [],
    };
    const unrelated = Array.from({ length: 50 }, (_, index) => ({
      ...thread,
      threadId: `other-${index}`,
      target: buildCodeTarget({
        path: `src/other-${index}.ts`,
        side: "head",
        baseCommit: "base-commit",
        headCommit: "head-commit",
        span: { startLine: 1, endLine: 1 },
      }),
    }));
    const index = buildThreadTargetIndex([thread, ...unrelated]);
    const commits = { baseRef: "base-commit", headRef: "head-commit" };

    expect(
      anchors.map((anchor) => anchorTargetRecords(index, anchor, commits)),
    ).toEqual([[thread], [thread], [thread]]);
  });

  it("indexes one cross-side target under both resources without duplicates", () => {
    const resolution = runtimeResolution();
    resolution.diff = {
      baseRef: "base-commit",
      headRef: "head-commit",
      orientation: "head",
      files: [
        {
          path: "src/runtime.ts",
          status: "modified",
          additions: 3,
          deletions: 2,
          patch: [
            "@@ -40,2 +40,3 @@",
            "-old one",
            "-old two",
            "+new one",
            "+new two",
            "+new three",
          ].join("\n"),
        },
      ],
    };
    const position = createGitLabTextDiffPosition({
      base_sha: "base-commit",
      start_sha: "base-commit",
      head_sha: "head-commit",
      old_path: "src/runtime.ts",
      new_path: "src/runtime.ts",
      start: { old_line: 40, new_line: null },
      end: { old_line: null, new_line: 42 },
    });
    const thread: ReviewCommentThreadRecord = {
      threadId: "cross-side",
      target: {
        kind: "code",
        original_position: position,
        position,
      },
      status: "open",
      messages: [],
    };
    const anchor = reviewAnchor(
      "cross-side",
      { file: "src/runtime.ts", fromLine: 40, toLine: 42 },
      resolution,
    );

    expect(
      anchorTargetRecords(buildThreadTargetIndex([thread]), anchor, {
        baseRef: "base-commit",
        headRef: "head-commit",
      }),
    ).toEqual([thread]);
  });
});

function reviewAnchor(
  id: string,
  props: CodePeekProps,
  resolution: CodePeekResolution,
): AnchorRef {
  return {
    __kind: "db-anchor-ref",
    id,
    title: id,
    peek: {
      __kind: "code-peek-ref",
      props,
      resolution,
    },
  };
}

function runtimeResolution(): CodePeekResolution {
  const sourceId = "source-range:src/runtime.ts:40-42";
  return {
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
  };
}
