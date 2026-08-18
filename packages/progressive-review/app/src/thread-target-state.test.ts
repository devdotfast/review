import { describe, expect, it } from "vitest";

import {
  buildAnchorTextTarget,
  buildBlockTarget,
  buildCodeTarget,
  buildDocumentTextTarget,
  buildGraphTarget,
  buildTableCellTarget,
} from "./target-fingerprint";
import {
  type LiveThreadTargetModel,
  resolveTargetState,
} from "./thread-target-state";

function live(
  input: Partial<LiveThreadTargetModel> = {},
): LiveThreadTargetModel {
  return {
    blocks: [],
    documentText: null,
    tableCells: [],
    anchors: new Map(),
    diagrams: new Map(),
    ...input,
  };
}

describe("resolveTargetState", () => {
  it("derives an outdated code state from a failed change position", () => {
    const target = buildCodeTarget({
      path: "src/example.ts",
      side: "head",
      baseCommit: "0".repeat(40),
      headCommit: "1".repeat(40),
      span: { startLine: 3, endLine: 4 },
    });
    expect(
      resolveTargetState(
        {
          target: {
            ...target,
            change_position: {
              ...target.position,
              head_sha: "2".repeat(40),
            },
          },
        },
        live(),
      ),
    ).toEqual({ state: "outdated", reason: "edited" });
  });

  it("attaches a document target unconditionally", () => {
    const target = { kind: "document" } as const;
    expect(resolveTargetState({ target }, live())).toEqual({
      state: "attached",
      target,
    });
  });

  it("attaches and relocates a selection spanning document blocks", () => {
    const target = buildDocumentTextTarget({
      text: "First paragraph. Next paragraph.",
      start: 6,
      length: 15,
    });
    expect(
      resolveTargetState(
        { target },
        live({
          documentText: "Introduction. First paragraph. Next paragraph.",
        }),
      ),
    ).toMatchObject({
      state: "attached",
      target: { selection: { start: 20, quote: "paragraph. Next" } },
    });
  });

  it("marks a changed document selection outdated when its quote is ambiguous", () => {
    const target = buildDocumentTextTarget({
      text: "First selected phrase. Tail.",
      start: 6,
      length: 15,
    });
    expect(
      resolveTargetState(
        { target },
        live({
          documentText:
            "Changed selected phrase. Another selected phrase. Tail.",
        }),
      ),
    ).toEqual({ state: "outdated", reason: "edited" });
  });

  it("attaches an unchanged block selection", () => {
    const target = buildBlockTarget({
      tag: "p",
      index: 0,
      text: "Before selected text after",
      start: 7,
      length: 13,
    });
    expect(
      resolveTargetState(
        { target },
        live({
          blocks: [{ tag: "p", index: 0, text: "Before selected text after" }],
        }),
      ),
    ).toMatchObject({ state: "attached" });
  });

  it("marks an edited selection outdated", () => {
    const target = buildTableCellTarget({
      table: 0,
      row: 1,
      column: 0,
      text: "old value",
      start: 0,
      length: 3,
    });
    expect(
      resolveTargetState(
        { target },
        live({
          tableCells: [{ table: 0, row: 1, column: 0, text: "new value" }],
        }),
      ),
    ).toEqual({ state: "outdated", reason: "edited" });
  });

  it("marks a missing surface outdated", () => {
    const target = buildTableCellTarget({
      table: 0,
      row: 1,
      column: 0,
      text: "value",
      start: 0,
      length: 5,
    });
    expect(resolveTargetState({ target }, live())).toEqual({
      state: "outdated",
      reason: "gone",
    });
  });

  it("relocates a block by a unique block hash", () => {
    const target = buildBlockTarget({
      tag: "p",
      index: -1,
      text: "Selected sentence.",
      start: 0,
      length: 18,
    });
    const state = resolveTargetState(
      { target },
      live({
        blocks: [
          { tag: "p", index: 0, text: "Inserted paragraph." },
          { tag: "p", index: 1, text: "Selected sentence." },
        ],
      }),
    );
    expect(state).toMatchObject({
      state: "attached",
      target: { surface: { index: 1 } },
    });
  });

  it("invalidates a block when text outside the selection changes", () => {
    const target = buildBlockTarget({
      tag: "p",
      index: 0,
      text: "Old introduction. Keep this sentence.",
      start: 18,
      length: 19,
    });
    const state = resolveTargetState(
      { target },
      live({
        blocks: [
          {
            tag: "p",
            index: 0,
            text: "A new introduction. Keep this sentence.",
          },
        ],
      }),
    );
    expect(state).toEqual({ state: "outdated", reason: "edited" });
  });

  it("invalidates a block when only its whitespace changes", () => {
    const target = buildBlockTarget({
      tag: "pre",
      index: 0,
      text: "first()\n  second()",
      start: 0,
      length: 18,
    });

    expect(
      resolveTargetState(
        { target },
        live({
          blocks: [{ tag: "pre", index: 0, text: "first()\n    second()" }],
        }),
      ),
    ).toEqual({ state: "outdated", reason: "edited" });
  });

  it("refuses an ambiguous block relocation", () => {
    const target = buildBlockTarget({
      tag: "p",
      index: -1,
      text: "Repeated paragraph.",
      start: 0,
      length: 19,
    });
    expect(
      resolveTargetState(
        { target },
        live({
          blocks: [
            { tag: "p", index: 0, text: "Repeated paragraph." },
            { tag: "p", index: 1, text: "Repeated paragraph." },
          ],
        }),
      ),
    ).toEqual({ state: "outdated", reason: "edited" });
  });

  it("validates title and detail selections independently without a mounted panel", () => {
    const titleTarget = buildAnchorTextTarget({
      anchorId: "runtime",
      field: "title",
      text: "Runtime",
    });
    const detailTarget = buildAnchorTextTarget({
      anchorId: "runtime",
      field: "detail",
      text: "Starts the server",
    });
    const anchors = new Map([
      [
        "runtime",
        { anchorId: "runtime", title: "Runtime", detail: "Starts the server" },
      ],
    ]);
    expect(
      resolveTargetState({ target: titleTarget }, live({ anchors })),
    ).toMatchObject({ state: "attached" });
    expect(
      resolveTargetState({ target: detailTarget }, live({ anchors })),
    ).toMatchObject({ state: "attached" });
  });

  it("does not outdate a detail selection when only the title changes", () => {
    const target = buildAnchorTextTarget({
      anchorId: "runtime",
      field: "detail",
      text: "Starts the server",
    });
    expect(
      resolveTargetState(
        { target },
        live({
          anchors: new Map([
            [
              "runtime",
              {
                anchorId: "runtime",
                title: "A renamed runtime",
                detail: "Starts the server",
              },
            ],
          ]),
        }),
      ),
    ).toMatchObject({ state: "attached" });
  });

  it("marks a removed detail selection gone", () => {
    const target = buildAnchorTextTarget({
      anchorId: "runtime",
      field: "detail",
      text: "Starts the server",
    });
    expect(
      resolveTargetState(
        { target },
        live({
          anchors: new Map([
            ["runtime", { anchorId: "runtime", title: "Runtime" }],
          ]),
        }),
      ),
    ).toEqual({ state: "outdated", reason: "gone" });
  });

  it("attaches a canonical code target without anchor provenance", () => {
    const target = buildCodeTarget({
      path: "src/review.ts",
      side: "base",
      baseCommit: "base-commit",
      headCommit: "head-commit",
      span: { startLine: 8, endLine: 10 },
    });
    expect(resolveTargetState({ target }, live())).toEqual({
      state: "attached",
      target,
    });
  });

  it("checks graph payload hashes against registered diagram inputs", () => {
    const target = buildGraphTarget({
      diagram: "Request flow",
      type: "edge",
      path: ["Browser→Worker"],
      payload: { from: "Browser", to: "Worker", label: "Send" },
      quote: "Send",
    });
    const edited = buildGraphTarget({
      diagram: "Request flow",
      type: "edge",
      path: ["Browser→Worker"],
      payload: { from: "Browser", to: "Worker", label: "Dispatch" },
      quote: "Dispatch",
    });
    expect(
      resolveTargetState(
        { target },
        live({
          diagrams: new Map([
            ["Request flow", { label: "Request flow", elements: [edited] }],
          ]),
        }),
      ),
    ).toEqual({ state: "outdated", reason: "edited" });
  });
});
