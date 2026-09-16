import { describe, expect, it } from "vitest";

import { type PeekableAnchorRef, calls } from "./authoring";
import { callStackFrames, frameIdentity, frameName } from "./call-stack-frames";

const anchor = (id: string): PeekableAnchorRef => ({
  __kind: "db-anchor-ref",
  id,
  title: `Anchor ${id}`,
  peek: { side: "head", file: `src/${id}.ts`, fromLine: 1, toLine: 5 },
});

describe("callStackFrames", () => {
  it("turns anchors into frames keyed by anchor id", () => {
    expect(callStackFrames([anchor("reconcile")])).toEqual([
      {
        id: "reconcile",
        key: "reconcile",
        source: {
          side: "head",
          file: "src/reconcile.ts",
          fromLine: 1,
          toLine: 5,
        },
        label: "Anchor reconcile",
      },
    ]);
  });

  it("turns a calls() hop into its child frame with the relationship", () => {
    const [withReason, withoutReason] = callStackFrames([
      calls(anchor("enqueue"), anchor("process"), "via the workqueue"),
      calls(anchor("process"), anchor("persist")),
    ]);

    expect(withReason).toMatchObject({
      id: "process",
      via: { kind: "call", reason: "via the workqueue" },
    });
    expect(withoutReason).toMatchObject({
      id: "persist",
      via: { kind: "call", reason: "asserted" },
    });
  });
});

describe("frame identity and name", () => {
  it("prefers the explicit key and falls back to the source range", () => {
    const source = {
      side: "head",
      file: "src/a.ts",
      fromLine: 3,
      toLine: 4,
    } as const;

    expect(frameIdentity({ id: "x", key: "moved", source })).toBe("moved");
    expect(frameIdentity({ id: "x", source })).toBe("src/a.ts:3-4");
    expect(frameName({ id: "x", source })).toBe("x");
    expect(frameName({ source })).toBe("a.ts");
  });
});
