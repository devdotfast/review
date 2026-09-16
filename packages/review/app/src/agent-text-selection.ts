import type { AgentSelection } from "../../src/agent-selection";

/** Observe rendered prose, leaving Monaco and diagram interaction to their owners. */
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
        !element.closest(
          ".monaco-editor, .react-flow, button, input, textarea, [data-review-copy-ignore]",
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
