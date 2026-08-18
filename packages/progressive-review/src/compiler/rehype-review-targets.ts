import type { Element, Nodes, Root } from "hast";

const REVIEW_BLOCK_TAGS = new Set(["p", "li", "h1", "h2", "h3", "h4", "pre"]);

export function rehypeReviewTargets() {
  return (tree: Root) => {
    let blockIndex = 0;
    let tableIndex = 0;

    walk(tree, (element) => {
      if (REVIEW_BLOCK_TAGS.has(element.tagName)) {
        element.properties["data-review-block-index"] = blockIndex;
        element.properties["data-review-block-tag"] = element.tagName;
        blockIndex += 1;
      }
      if (element.tagName === "table") {
        stampTableCells(element, tableIndex);
        tableIndex += 1;
      }
    });
  };
}

function stampTableCells(table: Element, tableIndex: number): void {
  let row = 0;
  walk(table, (element) => {
    if (element.tagName !== "tr") return;
    let column = 0;
    for (const child of element.children) {
      if (
        child.type !== "element" ||
        (child.tagName !== "th" && child.tagName !== "td")
      ) {
        continue;
      }
      child.properties["data-review-table"] = tableIndex;
      child.properties["data-review-row"] = row;
      child.properties["data-review-column"] = column;
      column += 1;
    }
    row += 1;
  });
}

function walk(node: Nodes, visit: (element: Element) => void): void {
  if (node.type === "element") visit(node);
  if (!("children" in node)) return;
  for (const child of node.children) walk(child, visit);
}
