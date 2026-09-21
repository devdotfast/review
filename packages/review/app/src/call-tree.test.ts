import { expect, it } from "vitest";

import { call_stack_diff } from "../../src/review-api/blocks/call_stack_diff";
import { callTreeStops } from "./call-tree";
import { diffSections } from "./diff-sections";

it("keeps separate calls into the same file as separate sections and combines matched base/head evidence", () => {
  const source = {
    file: "shared.ts",
    start: { side: "head" as const, line: 5 },
    end: { side: "head" as const, line: 20 },
  };

  const block = call_stack_diff.schema.parse({
    type: "call_stack_diff",
    id: "calls",
    title: "Request",
    head: [
      { key: "root", label: "handle", source: source },
      { key: "first", parentKey: "root", label: "read", source: source },
      { key: "second", parentKey: "root", label: "write", source: source },
    ],
    base: [
      {
        key: "first",
        source: {
          ...source,
          start: { side: "base", line: 5 },
          end: { side: "base", line: 20 },
        },
      },
    ],
  });

  call_stack_diff.check(block);
  const stops = callTreeStops(block);
  expect(stops.map((stop) => [stop.label, stop.depth])).toEqual([
    ["handle", 0],
    ["read", 1],
    ["write", 1],
  ]);
  expect(stops[1].sources.map((source) => source.start.side)).toEqual([
    "head",
    "base",
  ]);
  expect(stops[1].last).toBe(false);
  expect(stops[2].last).toBe(true);
  const sections = diffSections(block);
  expect(new Set(sections.map((section) => section.id)).size).toBe(3);
  expect(
    sections.every((section) => section.sources[0].file === "shared.ts"),
  ).toBe(true);
});

it("rejects a parent reference that would create a cyclic call tree", () => {
  const block = call_stack_diff.schema.parse({
    type: "call_stack_diff",
    title: "Cycle",
    base: [],
    head: [
      {
        key: "self",
        parentKey: "self",
        source: {
          file: "a.ts",
          start: { side: "head", line: 1 },
          end: { side: "head", line: 3 },
        },
      },
    ],
  });

  expect(() => call_stack_diff.check(block)).toThrow("earlier frame");
});

it("keeps supporting source ranges in the owning frame without adding call edges", () => {
  const source = {
    file: "view.ts",
    start: { side: "head" as const, line: 10 },
    end: { side: "head" as const, line: 20 },
  };
  const fields = {
    ...source,
    start: { side: "head" as const, line: 2 },
    end: { side: "head" as const, line: 5 },
  };
  const stops = callTreeStops({
    type: "call_stack_diff",
    id: "tree",
    title: "Create view",
    base: [],
    head: [
      {
        key: "view",
        parentKey: null,
        source: source,
        contextSources: [fields],
      },
    ],
  });
  expect(stops).toHaveLength(1);
  expect(stops[0].sources).toEqual([source, fields]);
  expect(stops[0].parentId).toBeUndefined();
});
