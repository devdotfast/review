import type { HydratedReviewNode } from "./review-document-hydrate";

export interface ReviewSectionSummary {
  diagrams: number;
  codeRefs: number;
  paragraphs: number;
}

const DIAGRAMS = new Set(["SequenceDiagram", "DatabaseLens"]);

const CODE_REFS = new Set(["AnchorLink", "CodePeek"]);

/** Count the section body; its leading heading belongs to the header. */
export function reviewSectionSummary(children: HydratedReviewNode[]) {
  const summary = { diagrams: 0, codeRefs: 0, paragraphs: 0 };

  const walk = (node: HydratedReviewNode) => {
    if (node.type === "text") return;

    if (node.type === "component") {
      if (DIAGRAMS.has(node.name)) summary.diagrams += 1;

      if (CODE_REFS.has(node.name)) summary.codeRefs += 1;
    } else if (node.tag === "p") {
      summary.paragraphs += 1;
    }

    for (const child of node.children) walk(child);
  };

  const first = children[0];

  const body =
    first?.type === "element" && first.tag === "h2"
      ? children.slice(1)
      : children;

  for (const child of body) walk(child);

  return summary;
}
