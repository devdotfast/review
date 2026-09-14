import assert from "node:assert/strict";
import test from "node:test";

import { Event } from "../../base/common/event.js";
import type { EditorInput } from "../../workbench/common/editor/editorInput.js";
import type { ReviewCanvasEditorTarget } from "../browser/parts/canvas/reviewCanvasEditorInput.js";

test("closing a review closes its host canvas, pinned source tabs and registered editors without closing other reviews", async () => {
  const { ReviewCanvasEditorTabsService } = await import("./reviewCanvasEditorTabsService.js");
  const opened = new Set<EditorInput>();
  const closed: EditorInput[] = [];
  const group = { id: 1, contains: (input: EditorInput) => opened.has(input) };
  const service = new ReviewCanvasEditorTabsService(
    { createInstance: (_constructor: unknown, target: ReviewCanvasEditorTarget) => ({ target, isDisposed: () => false, updateHostTitle() {} }) } as never,
    { onDidCloseEditor: Event.None, openEditor: async (input: EditorInput) => { opened.add(input); }, closeEditors: async (entries: {editor: EditorInput}[]) => { for (const {editor} of entries) { closed.push(editor); opened.delete(editor); } } } as never,
    { groups: [group], mainPart: { activeGroup: group } } as never,
    { reviews: [] } as never,
  );
  try {
    const first = await service.openHostReview("review-one", true);
    const historicalCanvas = await service.openHostReview("review-one", true, "Earlier version", 0);
    assert.notEqual(historicalCanvas, first);
    assert.equal(await service.openHostReview("review-one", true, "Earlier version", 0), historicalCanvas);
    assert.equal(await service.openHostReview("review-one", true), first);
    const historicalSource = await service.openHostSource("review-one", 2);
    const currentSource = await service.openHostSource("review-one", 3);
    const other = await service.openHostReview("review-one-extra", true);
    const otherSource = await service.openHostSource("review-one-extra", 2);
    const nativeFile = {} as EditorInput;
    opened.add(nativeFile);
    service.registerReviewEditor("review-one", nativeFile);
    await service.closeReview("review-one");
    assert.deepEqual(new Set(closed), new Set([first, historicalCanvas, historicalSource, currentSource, nativeFile]));
    assert.deepEqual(opened, new Set([other, otherSource]));
    assert.notEqual(await service.openHostReview("review-one", true), first);
    assert.notEqual(await service.openHostSource("review-one", 2), historicalSource);
  } finally { service.dispose(); }
});
