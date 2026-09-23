import type { AuthoringCursor } from "./authoring-cursor";

/** The element a cursor names, whichever kind of thing it is. */
export function cursorElement(
  article: HTMLElement,
  cursor: AuthoringCursor,
): Element | null {
  // Ids are server-made (`node-12`), but a quote in one must not end the selector.
  const find = (id: string) => {
    const quoted = `"${id.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

    return article.querySelector(
      `[data-review-node-id=${quoted}], [data-review-unit-id=${quoted}], [data-review-anchor-id=${quoted}]`,
    );
  };

  // A hidden element (in a collapsed section) has no boxes to stand on.
  const visible = (element: Element | null) =>
    element?.getClientRects().length ? element : null;

  // A unit whose diagram has not laid out yet, or a block in a collapsed
  // section, is stood in for by the block that holds it.
  return visible(find(cursor.targetId)) ?? visible(find(cursor.blockId));
}
