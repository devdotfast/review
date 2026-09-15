import type {
  HydratedReviewElementNode,
  HydratedReviewNode,
} from "./review-document-hydrate";

export type ReviewTocLevel = "h2" | "h3";

export interface ReviewTocEntry {
  id: string;
  text: string;
  level: ReviewTocLevel;
}

function headingId(node: HydratedReviewElementNode): string {
  const id = node.props.id;

  // Element props are validated primitives. React omits boolean IDs.
  return id === undefined || id === true || id === false ? "" : String(id);
}

function headingNodes(
  nodes: HydratedReviewNode[],
): HydratedReviewElementNode[] {
  return nodes.flatMap((node) => {
    if (node.type === "text") return [];
    const children = headingNodes(node.children);

    return node.type === "element" && (node.tag === "h2" || node.tag === "h3")
      ? [node, ...children]
      : children;
  });
}

function nodeText(node: HydratedReviewNode): string {
  return node.type === "text"
    ? node.value
    : node.children.map(nodeText).join("");
}

function normalizeHeadingText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function uniqueHeadingId(baseId: string, usedIds: Set<string>): string {
  const base = baseId || "section";
  let candidate = base;
  let index = 2;

  while (usedIds.has(candidate)) {
    candidate = `${base}-${index}`;
    index += 1;
  }

  return candidate;
}

export function assignReviewHeadingIds(body: HydratedReviewNode[]): void {
  const headings = headingNodes(body);

  // Match the original DOM collector: reserve trimmed IDs, but preserve
  // authored attribute values verbatim, including whitespace and numeric IDs.
  const usedIds = new Set(
    headings.map((node) => headingId(node).trim()).filter(Boolean),
  );

  for (const node of headings) {
    const text = normalizeHeadingText(nodeText(node));

    if (!text || headingId(node)) continue;
    const id = uniqueHeadingId(slugifyHeading(text), usedIds);
    node.props.id = id;
    usedIds.add(id);
  }
}

export function reviewTocEntries(body: HydratedReviewNode[]): ReviewTocEntry[] {
  return headingNodes(body).flatMap((node) => {
    const id = headingId(node);
    const text = normalizeHeadingText(nodeText(node));

    return id && text
      ? [{ id, text, level: node.tag === "h3" ? "h3" : "h2" }]
      : [];
  });
}
