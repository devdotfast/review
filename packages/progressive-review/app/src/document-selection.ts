import type { ThreadTarget } from "../../src/types";
import { isDocumentContent } from "./comment-pins";
import { reviewDocumentSelection } from "./review-document-text";
import {
  buildBlockTarget,
  buildDocumentTextTarget,
  buildTableCellTarget,
} from "./target-fingerprint";

export interface SelectionTarget {
  /** Article-relative coords of the chip. `.review-canvas-root` sets
   *  `contain: layout`, which makes it the containing block for fixed
   *  descendants, so viewport coords land the chip on top of the selection.
   *  The chip is absolute inside `.review-document` instead. */
  x: number;
  y: number;
  /** Viewport coords of the selection itself, used to anchor the draft card. */
  anchorX: number;
  anchorY: number;
  target: ThreadTarget;
  quote: string;
}

/** Chip box, used to keep it clear of the selection and inside its container. */
export const CHIP_HEIGHT = 30;
export const CHIP_HALF_WIDTH = 48;
export const CHIP_GAP = 8;

/**
 * Places the chip clear of a selection, in the coordinate space of `container`.
 * Above the selection, or below it when there is no room. `.review-canvas-root`
 * sets `contain: layout`, so raw viewport coords from `getBoundingClientRect`
 * drop the chip on top of the text it belongs to.
 */
export interface ChipPosition {
  x: number;
  y: number;
}

export function chipPositionClearOf(
  selectionRect: DOMRect,
  containerRect: { left: number; top: number; width: number },
): ChipPosition {
  const centerX = selectionRect.left + selectionRect.width / 2;
  const above = selectionRect.top - containerRect.top - CHIP_HEIGHT - CHIP_GAP;
  return {
    x: Math.min(
      Math.max(centerX - containerRect.left, CHIP_HALF_WIDTH),
      Math.max(containerRect.width - CHIP_HALF_WIDTH, CHIP_HALF_WIDTH),
    ),
    y: above >= 0 ? above : selectionRect.bottom - containerRect.top + CHIP_GAP,
  };
}

export function observeDocumentSelection(
  article: HTMLElement,
  onTargetChange: (target: SelectionTarget | null) => void,
): () => void {
  const document = article.ownerDocument;
  const update = () =>
    onTargetChange(documentSelectionTarget(document.getSelection(), article));
  document.addEventListener("selectionchange", update);
  return () => document.removeEventListener("selectionchange", update);
}

export function documentSelectionTarget(
  selection: Selection | null,
  article: HTMLElement,
): SelectionTarget | null {
  const exactText = selection?.toString() ?? "";
  if (
    !selection ||
    selection.isCollapsed ||
    selection.rangeCount === 0 ||
    exactText.length === 0
  ) {
    return null;
  }
  const range = selection.getRangeAt(0);
  if (
    !selection.anchorNode ||
    !selection.focusNode ||
    !isDocumentContent(selection.anchorNode, article) ||
    !isDocumentContent(selection.focusNode, article) ||
    closestCommentTarget(range.commonAncestorContainer)
  ) {
    return null;
  }
  const target = targetForRange(range, article, exactText);
  if (!target) return null;
  const rect = range.getBoundingClientRect();
  return {
    ...chipPositionClearOf(rect, article.getBoundingClientRect()),
    anchorX: rect.left + rect.width / 2,
    anchorY: rect.top,
    target,
    quote: target.selection.quote,
  };
}

export function selectionCommentTarget(target: SelectionTarget) {
  return {
    target: target.target,
    title: quoteLabel(target.quote),
    // Anchor the draft card to the selection, not the focused element —
    // for a text selection the active element is the document body, whose
    // rect would drop the card at the bottom of the page.
    placement: { x: target.anchorX, y: target.anchorY },
    body: "",
  };
}

function targetForRange(
  range: Range,
  article: HTMLElement,
  exactText: string,
): Extract<ThreadTarget, { kind: "text" }> | null {
  const startSurface = selectionSurface(range.startContainer, article);
  if (startSurface) {
    const surfaceText = startSurface.textContent ?? "";
    const start = exactRangeStart(startSurface, range);
    if (surfaceText.slice(start, start + exactText.length) === exactText) {
      return targetForSelectionSurface(
        startSurface,
        surfaceText,
        start,
        exactText.length,
      );
    }
  }

  const intersectedSurface = singleIntersectedSurface(range, article);
  if (intersectedSurface) {
    const surfaceText = intersectedSurface.textContent ?? "";
    const start = surfaceText.indexOf(exactText);
    if (start >= 0) {
      return targetForSelectionSurface(
        intersectedSurface,
        surfaceText,
        start,
        exactText.length,
      );
    }
  }

  const documentSelection = reviewDocumentSelection(article, range);
  if (!documentSelection) return null;
  return buildDocumentTextTarget({
    text: documentSelection.text,
    start: documentSelection.start,
    length: documentSelection.selectionText.length,
  });
}

function exactRangeStart(root: HTMLElement, range: Range): number {
  const prefix = document.createRange();
  prefix.selectNodeContents(root);
  prefix.setEnd(range.startContainer, range.startOffset);
  return prefix.toString().length;
}

function singleIntersectedSurface(
  range: Range,
  article: HTMLElement,
): HTMLElement | null {
  const surfaces = [
    ...article.querySelectorAll<HTMLElement>(
      "[data-review-table][data-review-row][data-review-column], [data-review-block-index]",
    ),
  ].filter((surface) => range.intersectsNode(surface));
  return surfaces.length === 1 ? surfaces[0]! : null;
}

function selectionSurface(
  node: Node,
  article: HTMLElement,
): HTMLElement | null {
  const element = node instanceof HTMLElement ? node : node.parentElement;
  const surface = element?.closest<HTMLElement>(
    "[data-review-table][data-review-row][data-review-column], [data-review-block-index]",
  );
  return surface && article.contains(surface) ? surface : null;
}

function targetForSelectionSurface(
  surface: HTMLElement,
  text: string,
  start: number,
  length: number,
): Extract<ThreadTarget, { kind: "text" }> {
  if (surface.dataset.reviewTable !== undefined) {
    return buildTableCellTarget({
      table: datasetInteger(surface, "reviewTable"),
      row: datasetInteger(surface, "reviewRow"),
      column: datasetInteger(surface, "reviewColumn"),
      text,
      start,
      length,
    });
  }
  return buildBlockTarget({
    tag: surface.dataset.reviewBlockTag ?? surface.tagName.toLowerCase(),
    index: datasetInteger(surface, "reviewBlockIndex"),
    text,
    start,
    length,
  });
}

function datasetInteger(
  element: HTMLElement,
  name: keyof DOMStringMap,
): number {
  const raw = element.dataset[name];
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid ${String(name)} review target stamp.`);
  }
  return value;
}

function closestCommentTarget(node: Node): Element | null {
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest("[data-review-locator]") ?? null;
}

function quoteLabel(value: string): string {
  return value.length > 72 ? `${value.slice(0, 69).trimEnd()}...` : value;
}
