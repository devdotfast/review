import assert from "node:assert/strict";
import test from "node:test";

import {
  hasRenderedInlineEditors,
  waitForInlineEditorRendering,
} from "./inline-editor-smoke-readiness.mjs";

const hostedFailureSnapshot = {
  count: 2,
  lineCount: 21,
  durationCount: 1,
  nativeMultiDiffCount: 2,
  nativeDiffCount: 1,
  renderedText: ["export function smokeValue() {", ""],
  sizing: [
    { bodyHeight: 358, entryHeight: 360 },
    { bodyHeight: 358, entryHeight: 0 },
  ],
};

const renderedSnapshot = {
  count: 2,
  lineCount: 42,
  durationCount: 2,
  nativeMultiDiffCount: 2,
  nativeDiffCount: 2,
  renderedText: [
    "export function smokeValue() {",
    "export function smokeValue() {",
  ],
  sizing: [
    { bodyHeight: 358, entryHeight: 360 },
    { bodyHeight: 358, entryHeight: 360 },
  ],
};

test("hosted CI's partially initialized inline editors remain pending", () => {
  assert.equal(
    hasRenderedInlineEditors(hostedFailureSnapshot, {
      expectedCount: 2,
      expectedText: "export function smokeValue",
    }),
    false,
  );
});

test("inline editor readiness waits for every diff control to render", async () => {
  const snapshots = [hostedFailureSnapshot, renderedSnapshot];
  let reads = 0;

  const result = await waitForInlineEditorRendering({
    readSnapshot: async () =>
      snapshots[Math.min(reads++, snapshots.length - 1)],
    expectedCount: 2,
    expectedText: "export function smokeValue",
    timeoutMs: 1_000,
    intervalMs: 0,
  });

  assert.equal(result, renderedSnapshot);
  assert.equal(reads, 2);
});
