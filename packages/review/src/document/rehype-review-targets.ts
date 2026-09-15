import type { Element, Nodes, Root } from "hast";

const REVIEW_BLOCK_TAGS = new Set(["p", "li", "h1", "h2", "h3", "h4", "pre"]);

export function rehypeReviewTargets() {
  return (tree: Root) => {
    walk(tree, (element) => {
      if (REVIEW_BLOCK_TAGS.has(element.tagName)) {
        element.properties["data-review-block-tag"] = element.tagName;
      }
    });
  };
}

function walk(node: Nodes, visit: (element: Element) => void): void {
  if (node.type === "element") visit(node);

  if (!("children" in node)) return;

  for (const child of node.children) walk(child, visit);
}
