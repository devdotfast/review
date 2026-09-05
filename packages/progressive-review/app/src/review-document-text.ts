import { ANNOTATION_CONTAINER_SELECTOR } from "./comment-pins";

const NON_DOCUMENT_TEXT_SELECTOR = `${ANNOTATION_CONTAINER_SELECTOR}, .review-doc-meta, .selection-action-buttons, .review-section-meta`;
const BLOCK_TEXT_TAGS = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "BR",
  "DD",
  "DIV",
  "DL",
  "DT",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HR",
  "LI",
  "MAIN",
  "NAV",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "TABLE",
  "TBODY",
  "TD",
  "TFOOT",
  "TH",
  "THEAD",
  "TR",
  "UL",
]);

/** Canonical visible text authored by the review document, excluding app chrome. */
export function reviewDocumentText(article: HTMLElement): string {
  return documentTextTokens(article)
    .map((token) => token.value)
    .join("");
}

export function reviewDocumentRange(
  article: HTMLElement,
  start: number,
  end: number,
): Range | null {
  const tokens = documentTextTokens(article);
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start ||
    end > tokens.length
  ) {
    return null;
  }
  const startPoint = tokens[start]?.start;
  const endPoint = tokens[end - 1]?.end;
  if (!startPoint || !endPoint) return null;
  const range = article.ownerDocument.createRange();
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset);
  return range;
}

export function reviewDocumentSelection(
  article: HTMLElement,
  range: Range,
): { text: string; start: number; selectionText: string } | null {
  const start = documentBoundaryOffset(article, {
    container: range.startContainer,
    offset: range.startOffset,
  });
  const end = documentBoundaryOffset(article, {
    container: range.endContainer,
    offset: range.endOffset,
  });
  if (start < 0 || end <= start) return null;
  const text = reviewDocumentText(article);
  const rawSelection = text.slice(start, end);
  const leadingWhitespace =
    rawSelection.length - rawSelection.trimStart().length;
  const selectionText = rawSelection.trim();
  if (!selectionText) return null;
  return { text, start: start + leadingWhitespace, selectionText };
}

function documentBoundaryOffset(
  article: HTMLElement,
  boundary: { container: Node; offset: number },
): number {
  const marker = "\u0000";
  return documentTextTokens(article, { ...boundary, marker })
    .map((token) => token.value)
    .join("")
    .indexOf(marker);
}

interface DocumentTextPoint {
  node: Text;
  offset: number;
}

interface DocumentTextToken {
  value: string;
  start?: DocumentTextPoint;
  end?: DocumentTextPoint;
}

function documentTextTokens(
  article: HTMLElement,
  boundary?: { container: Node; offset: number; marker: string },
): DocumentTextToken[] {
  const normalized: DocumentTextToken[] = [];
  let previousWasWhitespace = true;
  for (const token of rawDocumentTextTokens(article, boundary)) {
    if (/\s/.test(token.value)) {
      if (!previousWasWhitespace) {
        normalized.push({ ...token, value: " " });
        previousWasWhitespace = true;
      }
      continue;
    }
    normalized.push(token);
    previousWasWhitespace = false;
  }
  if (normalized.at(-1)?.value === " ") normalized.pop();
  return normalized;
}

function rawDocumentTextTokens(
  node: Node,
  boundary?: { container: Node; offset: number; marker: string },
): DocumentTextToken[] {
  if (node.nodeType === 3) {
    // SAFETY: nodeType 3 is Node.TEXT_NODE, so this node is a Text.
    const textNode = node as Text;
    const text = textNode.textContent ?? "";
    const tokens: DocumentTextToken[] = [];
    for (let offset = 0; offset < text.length; offset += 1) {
      if (node === boundary?.container && offset === boundary.offset) {
        tokens.push({ value: boundary.marker });
      }
      tokens.push({
        value: text[offset]!,
        start: { node: textNode, offset },
        end: { node: textNode, offset: offset + 1 },
      });
    }
    if (node === boundary?.container && boundary.offset === text.length) {
      tokens.push({ value: boundary.marker });
    }
    return tokens;
  }
  if (!(node instanceof Element)) return [];
  if (node.matches(NON_DOCUMENT_TEXT_SELECTOR)) return [];
  const separator = BLOCK_TEXT_TAGS.has(node.tagName) ? [{ value: " " }] : [];
  const children = [...node.childNodes].flatMap((child, index) => {
    const marker =
      node === boundary?.container && index === boundary.offset
        ? [{ value: boundary.marker }]
        : [];
    return [...marker, ...rawDocumentTextTokens(child, boundary)];
  });
  const trailingMarker =
    node === boundary?.container && boundary.offset === node.childNodes.length
      ? [{ value: boundary.marker }]
      : [];
  return [...separator, ...children, ...trailingMarker, ...separator];
}
