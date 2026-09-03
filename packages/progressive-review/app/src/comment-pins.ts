import type { CommentThreadView } from "./review-context";

export const PROSE_BLOCK_SELECTOR = "[data-review-block-index]";
export const ANNOTATION_CONTAINER_SELECTOR =
  ".review-annotations, .review-margin-threads, .thread-popover";

export type CommentAnnotationStatus = CommentThreadView["clientStatus"];

export interface CommentHighlightRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * One annotated thread target in the document. Prose targets carry the
 * client rects of the annotated range (rendered as highlights); element
 * targets carry only a marker position. `anchorY` aligns the thread's
 * margin card with its anchor; `marker` is the compact-width affordance at
 * the line's (or element's) edge. Resolved threads keep their marker (drawn
 * quiet) but show their highlight only while focused.
 */
export interface CommentAnnotationPosition {
  key: string;
  threadId: string;
  targetKey: string;
  kind: "comment";
  index: number;
  status: CommentAnnotationStatus;
  resolved: boolean;
  rects: CommentHighlightRect[];
  marker: { x: number; y: number } | null;
  anchorY: number | null;
  blockRight: number | null;
}

/** True when node is review-document content (inside article, not inside the annotation layer). */
export function isDocumentContent(node: Node, article: HTMLElement): boolean {
  if (!article.contains(node)) return false;
  const element = node instanceof Element ? node : node.parentElement;
  return !element?.closest(ANNOTATION_CONTAINER_SELECTOR);
}

export function commentAnnotationPositionsEqual(
  left: readonly CommentAnnotationPosition[],
  right: readonly CommentAnnotationPosition[],
): boolean {
  return (
    left.length === right.length &&
    left.every((annotation, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        annotation.key === other.key &&
        annotation.threadId === other.threadId &&
        annotation.targetKey === other.targetKey &&
        annotation.index === other.index &&
        annotation.status === other.status &&
        annotation.resolved === other.resolved &&
        annotation.marker?.x === other.marker?.x &&
        annotation.marker?.y === other.marker?.y &&
        annotation.anchorY === other.anchorY &&
        annotation.blockRight === other.blockRight &&
        commentHighlightRectsEqual(annotation.rects, other.rects)
      );
    })
  );
}

function commentHighlightRectsEqual(
  left: readonly CommentHighlightRect[],
  right: readonly CommentHighlightRect[],
): boolean {
  return (
    left.length === right.length &&
    left.every((rect, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        rect.x === other.x &&
        rect.y === other.y &&
        rect.width === other.width &&
        rect.height === other.height
      );
    })
  );
}
