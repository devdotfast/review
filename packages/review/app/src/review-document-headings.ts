import { slugify, uniqueId } from "../../src/slug";
import type {
  HydratedReviewComponentNode,
  HydratedReviewElementNode,
  HydratedReviewNode,
} from "./review-document-hydrate";

export type ReviewTocLevel = "h2" | "h3";

export interface ReviewTocEntry {
  id: string;
  text: string;
  level: ReviewTocLevel;
}

/** A node that carries a document heading: a section (its title) or a loose
 * h2/h3 element. */
type HeadingNode = HydratedReviewElementNode | HydratedReviewComponentNode;

function headingId(node: HeadingNode): string {
  const id = node.props.id;

  // Element props are validated primitives. React omits boolean IDs.
  return id === undefined || id === true || id === false ? "" : String(id);
}

function isSection(
  node: HydratedReviewNode,
): node is HydratedReviewComponentNode {
  return node.type === "component" && node.name === "ReviewSection";
}

function headingNodes(nodes: HydratedReviewNode[]): HeadingNode[] {
  return nodes.flatMap((node) => {
    if (node.type === "text") return [];
    const children = headingNodes(node.children);

    if (isSection(node)) return [node, ...children];

    return node.type === "element" && (node.tag === "h2" || node.tag === "h3")
      ? [node, ...children]
      : children;
  });
}

function nodeText(node: HydratedReviewNode): string {
  return node.type === "text"
    ? node.value
    : node.children.map(nodeText).join("") +
        (node.type === "component" ? (node.renderedTextSuffix ?? "") : "");
}

function headingText(node: HeadingNode): string {
  const raw = isSection(node) ? String(node.props.title ?? "") : nodeText(node);

  return raw.replace(/\s+/g, " ").trim();
}

function headingLevel(node: HeadingNode): ReviewTocLevel {
  return node.type === "element" && node.tag === "h3" ? "h3" : "h2";
}

export function assignReviewHeadingIds(body: HydratedReviewNode[]): void {
  const headings = headingNodes(body);

  // Reserve trimmed authored ids, but keep the authored attribute verbatim,
  // including whitespace and numeric ids.
  const usedIds = new Set(
    headings.map((node) => headingId(node).trim()).filter(Boolean),
  );

  for (const node of headings) {
    const text = headingText(node);

    if (!text || headingId(node)) continue;
    const id = uniqueId(slugify(text) || "section", usedIds);
    node.props.id = id;
    usedIds.add(id);
  }
}

export function reviewTocEntries(body: HydratedReviewNode[]): ReviewTocEntry[] {
  return headingNodes(body).flatMap((node) => {
    const id = headingId(node);
    const text = headingText(node);

    return id && text ? [{ id, text, level: headingLevel(node) }] : [];
  });
}
