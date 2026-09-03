import { describe, expect, it } from "vitest";

import {
  type CommentAnnotationPosition,
  commentAnnotationPositionsEqual,
} from "./comment-pins";

const annotation: CommentAnnotationPosition = {
  key: "thread-1",
  threadId: "thread-1",
  targetKey: "text:1",
  kind: "comment",
  index: 2,
  status: "persisted",
  resolved: false,
  rects: [{ x: 10, y: 20, width: 120, height: 18 }],
  marker: { x: 640, y: 18 },
  anchorY: 20,
  blockRight: 632,
};

describe("commentAnnotationPositionsEqual", () => {
  it("treats a thread that was just resolved as a changed annotation", () => {
    expect(
      commentAnnotationPositionsEqual(
        [annotation],
        [{ ...annotation, resolved: true }],
      ),
    ).toBe(false);
  });

  it("matches annotations whose geometry and state agree", () => {
    expect(
      commentAnnotationPositionsEqual(
        [annotation],
        [{ ...annotation, rects: [{ ...annotation.rects[0]! }] }],
      ),
    ).toBe(true);
  });
});
