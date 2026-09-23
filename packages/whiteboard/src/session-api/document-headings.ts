import { markdownText, parseMarkdown } from "../markdown.js";
import { slugify, uniqueId } from "../slug.js";
import { type Block, elements } from "./document.js";

export type WhiteboardHeadingLevel = "h2" | "h3";

/** A section title or a root-level h2/h3 of a markdown block. `block` rather
 * than its id: import needs slugs before the store has assigned ids. */
export interface DocumentHeading {
  id: string;
  text: string;
  level: WhiteboardHeadingLevel;
  block: Block;
  /** Position among the markdown block's own headings; absent for a section. */
  index?: number;
}

/** Heading ids by the rule the MDX renderer published, `slugify(text)` made
 * unique in document order, so imported `#fragment` links still land. */
export function documentHeadings(blocks: Block[]): DocumentHeading[] {
  const used = new Set<string>();

  const assign = (heading: Omit<DocumentHeading, "id">): DocumentHeading => {
    const id = uniqueId(slugify(heading.text) || "section", used);
    used.add(id);

    return { id, ...heading };
  };

  return elements(blocks).flatMap((block): DocumentHeading[] => {
    if (block.type === "section")
      return [assign({ text: block.title, level: "h2", block })];

    if (block.type !== "markdown") return [];
    let index = 0;

    return (parseMarkdown(block.markdown).children ?? []).flatMap((node) =>
      node.type === "heading" && (node.depth === 2 || node.depth === 3)
        ? [
            assign({
              text: markdownText(node),
              level: node.depth === 2 ? "h2" : "h3",
              block,
              index: index++,
            }),
          ]
        : [],
    );
  });
}
