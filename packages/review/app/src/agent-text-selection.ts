import type { AgentSelection } from "../../src/agent-selection";

/** Authored document text participates; native code editors report their own selections. */
export function observeAgentTextSelection(
  article: HTMLElement,
  select: (
    value:
      | (Omit<AgentSelection, "revision"> & {
          anchor: { x: number; y: number };
          anchorElement: Element;
        })
      | null,
  ) => void,
): () => void {
  const document = article.ownerDocument;
  let hadSelection = false;

  const update = () => {
    const selection = document.getSelection();
    const quote = selection?.toString() ?? "";

    const eligible = (node: Node | null) => {
      const element = node instanceof Element ? node : node?.parentElement;

      return (
        element &&
        article.contains(element) &&
        element.closest("[data-review-copy-prose]") &&
        (!element.closest("pre") ||
          element.closest("code[data-review-copy-prose]")) &&
        !element.closest(
          ".monaco-editor, button, select, input, textarea, [data-review-copy-ignore]",
        )
      );
    };

    if (
      !selection ||
      selection.isCollapsed ||
      !selection.rangeCount ||
      !quote ||
      !eligible(selection.anchorNode) ||
      !eligible(selection.focusNode)
    ) {
      if (hadSelection) {
        hadSelection = false;
        select(null);
      }

      return;
    }

    const range = selection.getRangeAt(0);

    // Endpoints alone are insufficient: a drag can cross a diagram between paragraphs.
    const walker = document.createTreeWalker(
      range.commonAncestorContainer,
      NodeFilter.SHOW_TEXT,
    );

    let node: Node | null = range.commonAncestorContainer;

    while (node) {
      if (
        node.nodeType === Node.TEXT_NODE &&
        node.textContent?.trim() &&
        range.intersectsNode(node) &&
        !eligible(node)
      ) {
        if (hadSelection) select(null);
        hadSelection = false;

        return;
      }

      node = walker.nextNode();
    }

    const rect = range.getBoundingClientRect();

    const anchorElement =
      range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement!;

    hadSelection = true;
    select({
      target: { kind: "text", quote },
      title: quote.slice(0, 100),
      anchor: { x: rect.left + rect.width / 2, y: rect.top },
      anchorElement,
    });
  };

  document.addEventListener("selectionchange", update);

  return () => document.removeEventListener("selectionchange", update);
}
