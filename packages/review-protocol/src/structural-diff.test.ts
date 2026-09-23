import { decodeStructuralDiffEvent } from "@dev.fast/diffr";
import type { JsonValue } from "@dev.fast/json";
import { expect, test } from "vitest";

import { decodeReviewStructuralDiffEvent } from "./structural-diff.js";

const file = { rhs: { path: "a.ts", oid: "1", mode: "100644" } };

const text = {
  type: "text",
  structural_changes: { base: [], head: [[0, 1]] },
  rhs: {
    text: "hello\n",
    regions: [
      {
        id: 1,
        fold_state_id: 1,
        start: { line: 0, column: 0 },
        end: { line: 1, column: 0 },
        kind: "fold",
        children: [
          {
            id: 2,
            fold_state_id: 1,
            start: { line: 0, column: 0 },
            end: { line: 1, column: 0 },
            kind: "leaf",
            alignment_id: 0,
          },
        ],
      },
    ],
  },
  stats: {
    textual: { added: 1, removed: 0 },
    visible: { added: 0, removed: 0 },
  },
};

const event = { type: "file", file, diff: text };

const decode = (value: JsonValue) =>
  decodeStructuralDiffEvent(JSON.stringify(value));

test("decodes recursive regions with omitted serde defaults and unknown additive fields", () => {
  expect(decode({ ...event, future: 123 })).toEqual(event);
});

test.each<JsonValue>([
  { type: "file", file },
  { ...event, error: { code: "bad", message: "bad" } },
  { ...event, file: {} },
  {
    ...event,
    diff: {
      ...text,
      rhs: { text: "a", regions: [{ kind: "fold", children: [null] }] },
    },
  },
  { ...event, diff: { type: "binary", rhs: { size: -1 } } },
  { type: "complete", succeeded: 0.1, failed: 0 },
  { type: "start", version: 3, files: [] },
])("rejects malformed nested protocol data", (value) => {
  expect(() => decode(value)).toThrow("Malformed diffr protocol record.");
});

test("keeps host transport errors distinct from diffr file errors", () => {
  const error = JSON.stringify({ type: "error", message: "launch failed" });
  expect(decodeReviewStructuralDiffEvent(error)).toEqual({
    type: "error",
    message: "launch failed",
  });
  expect(() => decodeStructuralDiffEvent(error)).toThrow(
    "Malformed diffr protocol record.",
  );
});

test.each<JsonValue>([
  null,
  { base: [], head: [[4, 4]] },
  {
    base: [],
    head: [
      [0, 2],
      [1, 3],
    ],
  },
  { base: [[-1, 2]], head: [] },
])(
  "rejects unavailable or invalid structural coverage instead of reporting zero",
  (structural_changes) => {
    expect(() =>
      decode({ ...event, diff: { ...text, structural_changes } }),
    ).toThrow("Malformed diffr protocol record.");
  },
);
