import { ANNOTATION_CONTAINER_SELECTOR } from "./comment-pins";
import { regularExpressionMatches } from "./review-find-query";

const NON_FIND_TEXT_SELECTOR = [
  ANNOTATION_CONTAINER_SELECTOR,
  ".review-doc-meta",
  ".selection-action-buttons",
  ".review-find-widget",
  "[data-review-inline-editor]",
  ".side-panel",
].join(", ");

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

interface TextSegment {
  outputStart: number;
  outputEnd: number;
  node?: Text;
  nodeStart?: number;
  nodeEnd?: number;
}

interface FindTextIndex {
  text: string;
  segments: TextSegment[];
}

export function reviewFindText(article: HTMLElement): string {
  return buildFindTextIndex(article).text;
}

export function reviewFindRanges(
  article: HTMLElement,
  expression: RegExp,
): Range[] {
  const index = buildFindTextIndex(article);
  return regularExpressionMatches(index.text, expression).flatMap(
    ({ start, end }) => {
      const startPoint = rangePoint(index.segments, start, true);
      const endPoint = rangePoint(index.segments, end, false);
      if (!startPoint || !endPoint) return [];
      const range = article.ownerDocument.createRange();
      range.setStart(startPoint.node, startPoint.offset);
      range.setEnd(endPoint.node, endPoint.offset);
      return [range];
    },
  );
}

function buildFindTextIndex(article: HTMLElement): FindTextIndex {
  const parts: string[] = [];
  const segments: TextSegment[] = [];
  let length = 0;
  let previousWasWhitespace = true;

  const append = (
    value: string,
    node?: Text,
    nodeStart?: number,
    nodeEnd?: number,
  ) => {
    if (!value) return;
    parts.push(value);
    segments.push({
      outputStart: length,
      outputEnd: length + value.length,
      node,
      nodeStart,
      nodeEnd,
    });
    length += value.length;
  };

  const appendWhitespace = (
    node?: Text,
    nodeStart?: number,
    nodeEnd?: number,
  ) => {
    if (previousWasWhitespace) return;
    append(" ", node, nodeStart, nodeEnd);
    previousWasWhitespace = true;
  };

  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      // SAFETY: a TEXT_NODE nodeType means this node is a Text.
      const textNode = node as Text;
      const value = textNode.textContent ?? "";
      for (const match of value.matchAll(/\s+|\S+/gu)) {
        const token = match[0];
        const start = match.index;
        if (/^\s/u.test(token)) {
          appendWhitespace(textNode, start, start + token.length);
        } else {
          append(token, textNode, start, start + token.length);
          previousWasWhitespace = false;
        }
      }
      return;
    }
    if (!(node instanceof Element) || node.matches(NON_FIND_TEXT_SELECTOR)) {
      return;
    }
    const block = BLOCK_TEXT_TAGS.has(node.tagName);
    if (block) appendWhitespace();
    for (const child of node.childNodes) visit(child);
    if (block) appendWhitespace();
  };

  visit(article);
  if (parts.at(-1) === " ") {
    parts.pop();
    segments.pop();
  }
  return { text: parts.join(""), segments };
}

function rangePoint(
  segments: readonly TextSegment[],
  offset: number,
  start: boolean,
): { node: Text; offset: number } | undefined {
  const ordered = start ? segments : [...segments].reverse();
  for (const segment of ordered) {
    const contains = start
      ? segment.outputStart <= offset && offset < segment.outputEnd
      : segment.outputStart < offset && offset <= segment.outputEnd;
    if (!contains || !segment.node) continue;
    const nodeStart = segment.nodeStart ?? 0;
    const nodeEnd = segment.nodeEnd ?? nodeStart;
    if (segment.outputEnd - segment.outputStart === nodeEnd - nodeStart) {
      return {
        node: segment.node,
        offset: nodeStart + offset - segment.outputStart,
      };
    }
    return { node: segment.node, offset: start ? nodeStart : nodeEnd };
  }

  // A match boundary can land on an inserted block separator. Use the nearest
  // authored text point on the correct side of that separator.
  const candidates = start ? segments : [...segments].reverse();
  for (const segment of candidates) {
    if (!segment.node) continue;
    if (start && segment.outputStart >= offset) {
      return { node: segment.node, offset: segment.nodeStart ?? 0 };
    }
    if (!start && segment.outputEnd <= offset) {
      return { node: segment.node, offset: segment.nodeEnd ?? 0 };
    }
  }
  return undefined;
}
