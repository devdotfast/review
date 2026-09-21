import { describe, expect, it } from "vitest";

import { type PeekableAnchorRef, calls } from "./authoring";
import { callStackFrames, frameIdentity, frameName } from "./call-stack-frames";
import { selectSource } from "./lens-selection";

const anchor = (id: string): PeekableAnchorRef => ({
  __kind: "db-anchor-ref",
  id,
  title: `Anchor ${id}`,
  peek: selectSource({
    side: "head",
    file: `src/${id}.ts`,
    fromLine: 1,
    toLine: 5,
  }),
});

describe("callStackFrames", () => {
  it("turns anchors into frames keyed by anchor id", () => {
    expect(callStackFrames([anchor("reconcile")])).toEqual([
      {
        id: "reconcile",
        key: "reconcile",
        source: {
          file: "src/reconcile.ts",
          start: { side: "head", line: 1 },
          end: { side: "head", line: 5 },
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
      file: "src/a.ts",
      start: { side: "head", line: 3 },
      end: { side: "head", line: 4 },
    } as const;

    expect(frameIdentity({ id: "x", key: "moved", source })).toBe("moved");
    expect(frameIdentity({ id: "x", source })).toBe(frameIdentity({ source }));
    expect(frameIdentity({ source })).not.toBe(
      frameIdentity({ source: { ...source, end: { side: "head", line: 5 } } }),
    );
    expect(frameName({ id: "x", source })).toBe("x");
    expect(frameName({ source })).toBe("a.ts");
  });
});
