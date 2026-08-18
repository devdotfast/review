export function hasTextSelectionWithin(element: Element): boolean {
  const selection = element.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return false;
  }

  const { anchorNode, focusNode } = selection;
  return Boolean(
    (anchorNode && element.contains(anchorNode)) ||
    (focusNode && element.contains(focusNode)),
  );
}
