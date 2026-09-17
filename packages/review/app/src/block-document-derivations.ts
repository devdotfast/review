import { markdownNodes, parseMarkdown } from "../../src/markdown";
import type { Block } from "../../src/review-api/document";
import type { ReviewSectionSummary } from "./review-section-summary";

export function blockSectionSummary(children: Block[]): ReviewSectionSummary {
  const summary = { diagrams: 0, codeRefs: 0, paragraphs: 0 };

  const walk = (block: Block) => {
    switch (block.type) {
      case "section":
      case "callout":
        for (const child of block.children) walk(child);
        break;
      case "sequence":
      case "database_lens":
      case "call_stack_diff":
      case "flow_diagram":
      case "software_map":
        summary.diagrams += 1;
        break;
      case "code_peek":
        summary.codeRefs += 1;
        break;
      case "markdown": {
        const markdown = parseMarkdown(block.markdown);

        for (const node of markdown.children ?? [])
          if (node.type === "paragraph") summary.paragraphs += 1;

        for (const node of markdownNodes(markdown))
          if (node.type === "link" && /^review-source:/i.test(node.url ?? ""))
            summary.codeRefs += 1;
        break;
      }
    }
  };

  for (const child of children) walk(child);

  return summary;
}
