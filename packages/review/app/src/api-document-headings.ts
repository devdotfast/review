import { type MarkdownNode, parseMarkdown } from "../../src/markdown";
import { type Block, elements } from "../../src/review-api/document";
import type { ReviewTocEntry } from "./review-document-headings";

export function apiHeadingId(blockId: string, index: number): string {
  return `${blockId}-heading-${index}`;
}

function text(node: MarkdownNode): string {
  return node.value ?? node.children?.map(text).join("") ?? "";
}

export function apiDocumentHeadings(blocks: Block[]): ReviewTocEntry[] {
  return elements(blocks).flatMap((block): ReviewTocEntry[] => {
    if (block.type === "section")
      return [{ id: block.id!, text: block.title, level: "h2" }];

    if (block.type !== "markdown") return [];

    return (parseMarkdown(block.markdown).children ?? []).flatMap(
      (node, index) =>
        node.type === "heading" && (node.depth === 2 || node.depth === 3)
          ? [
              {
                id: apiHeadingId(block.id!, index),
                text: text(node),
                level: node.depth === 2 ? ("h2" as const) : ("h3" as const),
              },
            ]
          : [],
    );
  });
}
