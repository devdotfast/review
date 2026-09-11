import type { Heading, Nodes } from "mdast";

/** Static heading labels do not evaluate authored expressions. */
export function headingText(heading: Heading): string {
  return heading.children.map(nodeText).join("").replace(/\s+/g, " ").trim();
}

function nodeText(node: Nodes): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value;

  if (node.type === "image" || node.type === "imageReference")
    return node.alt ?? "";

  if (node.type === "break") return " ";

  return "children" in node ? node.children.map(nodeText).join("") : "";
}
