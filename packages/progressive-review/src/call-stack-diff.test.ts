import { describe, expect, it } from "vitest";

import {
  type PeekableAnchorRef,
  callStackDiffPropsSchema,
  calls,
} from "./authoring";
import {
  callStackConnectorPrefix,
  callStackEvidenceErrors,
  diffCallStacks,
  patchChangedLines,
} from "./call-stack-diff";

interface AnchorPeekProps {
  file: string;
  fromLine: number;
  toLine: number;
  graph?: "base" | "head";
}

function anchor(id: string, graph?: "base" | "head"): PeekableAnchorRef {
  const props: AnchorPeekProps = {
    file: `src/${id}.ts`,
    fromLine: 1,
    toLine: 5,
  };
  if (graph !== undefined) props.graph = graph;
  return Object.freeze({
    __kind: "db-anchor-ref",
    id,
    title: `Anchor ${id}`,
    peek: {
      __kind: "code-peek-ref",
      props,
      resolution: null,
    },
  }) as PeekableAnchorRef;
}

const reconcile = anchor("reconcile");
const auth = anchor("auth", "base");
const enqueueWork = anchor("enqueueWork");
const processItem = anchor("processItem");
const persistResult = anchor("persistResult");

describe("diffCallStacks", () => {
  it("aligns shared frames and marks removed and added frames", () => {
    const rows = diffCallStacks(
      [reconcile, auth, enqueueWork, persistResult],
      [reconcile, enqueueWork, processItem, persistResult],
    );
    expect(
      rows.map((row) => [row.change, (row.entry as PeekableAnchorRef).id]),
    ).toEqual([
      ["unchanged", "reconcile"],
      ["removed", "auth"],
      ["unchanged", "enqueueWork"],
      ["added", "processItem"],
      ["unchanged", "persistResult"],
    ]);
  });

  it("renders a shared frame from the head entry", () => {
    const headReconcile = anchor("reconcile");
    const rows = diffCallStacks([reconcile], [headReconcile]);
    expect(rows[0]!.entry).toBe(headReconcile);
  });

  it("matches a calls() hop by its child frame", () => {
    const hop = calls(enqueueWork, processItem, "via the workqueue");
    const rows = diffCallStacks([enqueueWork, hop], [enqueueWork, hop]);
    expect(rows.map((row) => row.change)).toEqual(["unchanged", "unchanged"]);
  });

  it("diffs one-sided stacks", () => {
    expect(diffCallStacks([], [reconcile]).map((row) => row.change)).toEqual([
      "added",
    ]);
    expect(diffCallStacks([auth], []).map((row) => row.change)).toEqual([
      "removed",
    ]);
  });

  it("assigns each row its own side's depth", () => {
    const rows = diffCallStacks(
      [reconcile, auth, enqueueWork],
      [reconcile, enqueueWork, processItem],
    );
    expect(rows.map((row) => [row.change, row.depth])).toEqual([
      ["unchanged", 0],
      ["removed", 1],
      ["unchanged", 1],
      ["added", 2],
    ]);
  });
});

describe("callStackConnectorPrefix", () => {
  it("draws tree-util connectors from depth transitions", () => {
    const rows = diffCallStacks(
      [reconcile, auth, enqueueWork],
      [reconcile, enqueueWork, processItem],
    );
    expect(
      rows.map((_, index) => callStackConnectorPrefix(rows, index)),
    ).toEqual(["", "├─ ", "└─ ", "   └─ "]);
  });

  it("keeps the continuation bar while a branch continues below", () => {
    const rows = diffCallStacks([reconcile, auth, persistResult], [reconcile]);
    // No second depth-1 row follows auth, so auth draws "└─" and its child
    // indents one column further.
    expect(
      rows.map((_, index) => callStackConnectorPrefix(rows, index)),
    ).toEqual(["", "└─ ", "   └─ "]);
  });
});

describe("callStackDiffPropsSchema side rules", () => {
  it("accepts the canonical shape", () => {
    const result = callStackDiffPropsSchema.safeParse({
      title: "Warm allocation",
      base: [reconcile, auth, enqueueWork],
      head: [reconcile, enqueueWork, processItem],
      children: undefined,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a base-graph anchor in the head list", () => {
    const result = callStackDiffPropsSchema.safeParse({
      base: [],
      head: [auth],
      children: undefined,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("points at base");
  });

  it("rejects a head-graph anchor that is base-only", () => {
    const result = callStackDiffPropsSchema.safeParse({
      base: [reconcile],
      head: [enqueueWork],
      children: undefined,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("removed frame");
  });

  it("rejects an empty component", () => {
    const result = callStackDiffPropsSchema.safeParse({
      base: [],
      head: [],
      children: undefined,
    });
    expect(result.success).toBe(false);
  });
});

describe("patchChangedLines", () => {
  it("collects deleted base lines and added head lines per hunk", () => {
    const patch = [
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -10,4 +10,4 @@",
      " context",
      "-removed line",
      "+added line",
      " context",
      "@@ -30,2 +30,3 @@",
      " context",
      "+second added",
      " context",
      "",
    ].join("\n");
    const lines = patchChangedLines(patch);
    expect([...lines.deleted]).toEqual([11]);
    expect([...lines.added]).toEqual([11, 31]);
  });
});

describe("callStackEvidenceErrors", () => {
  const changed = (file: string) =>
    file === "src/auth.ts"
      ? { deleted: new Set([2]), added: new Set<number>() }
      : file === "src/processItem.ts"
        ? { deleted: new Set<number>(), added: new Set([3]) }
        : null;

  it("accepts markers whose ranges intersect the change", () => {
    const rows = diffCallStacks([reconcile, auth], [reconcile, processItem]);
    expect(callStackEvidenceErrors(rows, changed)).toEqual([]);
  });

  it("rejects a removed frame over unchanged code", () => {
    const rows = diffCallStacks([reconcile, enqueueWork], [reconcile]);
    const errors = callStackEvidenceErrors(rows, changed);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"enqueueWork" renders "-"');
    expect(errors[0]).toContain("no deleted lines");
  });

  it("rejects an added frame over unchanged code", () => {
    const rows = diffCallStacks([reconcile], [reconcile, persistResult]);
    const errors = callStackEvidenceErrors(rows, changed);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"persistResult" renders "+"');
    expect(errors[0]).toContain("no added lines");
  });
});
