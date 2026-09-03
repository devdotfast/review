import type {
  CallExpression,
  Node as EstreeNode,
  Expression,
  Literal,
  Program,
} from "estree";
import type { Nodes as MdastNode } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import {
  type MdxJsxAttribute,
  type MdxJsxAttributeValueExpression,
  type MdxJsxExpressionAttribute,
  type MdxJsxFlowElement,
  type MdxJsxTextElement,
  mdxFromMarkdown,
} from "mdast-util-mdx";
import { mdxjs } from "micromark-extension-mdxjs";
import { z } from "zod";

// One real MDX parse for every validator. The checks used to regex-scan raw
// text — which cannot tell markup from a tag quoted in a string, an anchor
// reference from prose that mentions one, or a prop from lookalike text inside
// a code snippet — and so both rejected valid documents and blessed broken
// ones. Parsing with the grammar the MDX compiler uses makes those classes of
// error structurally impossible: strings are data, code blocks are code
// blocks, and every JSX attribute expression carries an estree program with
// document-relative positions.

export interface MdxJsxElementHit {
  name: string;
  line: number;
}

export interface ReviewMdxAttribute {
  name: string;
  line: number;
  // title="Runtime"
  stringValue?: string;
  // anchor={anchors.runtime} / messages={[...]} - the expression's estree,
  // with document-relative loc lines.
  expression?: Expression;
}

export interface ReviewMdxElement {
  name: string;
  line: number;
  selfClosing: boolean;
  attributes: ReviewMdxAttribute[];
}

export interface ReviewMdxLink {
  url: string;
  line: number;
}

export interface ReviewMdxParseError {
  message: string;
  line: number;
}

export interface ReviewMdxDocument {
  parseError: ReviewMdxParseError | null;
  // Capitalized (component) JSX elements, in document order.
  components: MdxJsxElementHit[];
  // Every named JSX element with its attributes.
  elements: ReviewMdxElement[];
  // Markdown links (the clickable-anchor surface).
  links: ReviewMdxLink[];
  // Estree programs from `export`/`import` blocks.
  esmPrograms: Program[];
}

// What micromark throws on a syntax error: a VFileMessage, whose `line` is the
// failing line, `place` a point or position, and `reason` the message without
// the file location.
const mdxParseErrorSchema = z.object({
  reason: z.string().optional(),
  message: z.string().optional(),
  line: z.number().optional(),
  place: z.object({ line: z.number().optional() }).nullable().optional(),
});

function mdxParseError(cause: unknown): ReviewMdxParseError {
  const parsed = mdxParseErrorSchema.safeParse(cause);
  if (!parsed.success) return { message: String(cause), line: 1 };
  const { reason, message, line, place } = parsed.data;
  return {
    message: reason ?? message ?? String(cause),
    line: line ?? place?.line ?? 1,
  };
}

function nodeLine(node: Pick<MdastNode, "position">): number {
  return node.position?.start.line ?? 1;
}

function estreeLine(node: EstreeNode): number {
  return node.loc?.start.line ?? 1;
}

function isSelfClosing(
  source: string,
  node: MdxJsxFlowElement | MdxJsxTextElement,
): boolean {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) return false;
  return /\/\s*>$/.test(source.slice(start, end).trimEnd());
}

// A JSX attribute value is the quoted string or an expression node. TypeScript
// cannot narrow that union with `in`, so the node shape is parsed once here.
const attributeValueExpressionSchema = z.object({
  type: z.literal("mdxJsxAttributeValueExpression"),
});

export function isMdxAttributeValueExpression(
  value: MdxJsxAttribute["value"],
): value is MdxJsxAttributeValueExpression {
  return attributeValueExpressionSchema.safeParse(value).success;
}

function attributeFromNode(
  attribute: MdxJsxAttribute | MdxJsxExpressionAttribute,
): ReviewMdxAttribute | null {
  // Spread attributes ({...props}) carry no static name to validate.
  if (attribute.type !== "mdxJsxAttribute") return null;
  const base: ReviewMdxAttribute = {
    name: attribute.name,
    line: nodeLine(attribute),
  };
  const { value } = attribute;
  if (value === null || value === undefined) return base;
  if (!isMdxAttributeValueExpression(value)) {
    return { ...base, stringValue: value };
  }
  const statement = value.data?.estree?.body[0];
  if (statement?.type === "ExpressionStatement") {
    return { ...base, expression: statement.expression };
  }
  return base;
}

// Parse a review document once into everything the validators consume. A
// syntax error reports the parser's own message and position — the document
// would fail the MDX compile with the same error anyway.
export function parseReviewMdxDocument(source: string): ReviewMdxDocument {
  const document: ReviewMdxDocument = {
    parseError: null,
    components: [],
    elements: [],
    links: [],
    esmPrograms: [],
  };

  let tree: MdastNode;
  try {
    tree = fromMarkdown(source, {
      extensions: [mdxjs()],
      mdastExtensions: [mdxFromMarkdown()],
    });
  } catch (cause) {
    document.parseError = mdxParseError(cause);
    return document;
  }

  const visit = (node: MdastNode): void => {
    if (
      (node.type === "mdxJsxFlowElement" ||
        node.type === "mdxJsxTextElement") &&
      node.name !== null
    ) {
      const line = nodeLine(node);
      if (/^[A-Z]/.test(node.name)) {
        document.components.push({ name: node.name, line });
      }
      document.elements.push({
        name: node.name,
        line,
        selfClosing: isSelfClosing(source, node),
        attributes: node.attributes
          .map(attributeFromNode)
          .filter((attribute) => attribute !== null),
      });
    }
    if (node.type === "link") {
      document.links.push({ url: node.url, line: nodeLine(node) });
    }
    if (node.type === "mdxjsEsm" && node.data?.estree) {
      document.esmPrograms.push(node.data.estree);
    }
    if ("children" in node) {
      for (const child of node.children) visit(child);
    }
  };
  visit(tree);
  return document;
}

// --- estree helpers -------------------------------------------------------

export function walkEstree(
  node: EstreeNode,
  visit: (node: EstreeNode) => void,
): void {
  visit(node);
  const fields: unknown[] = Object.values(node);
  for (const value of fields) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isEstreeNode(item)) walkEstree(item, visit);
      }
    } else if (isEstreeNode(value)) {
      walkEstree(value, visit);
    }
  }
}

// Every estree node carries a string `type`; the other objects hanging off a
// node (`loc`, a literal's `regex`, ...) do not.
const estreeNodeSchema = z.object({ type: z.string() });

function isEstreeNode(value: unknown): value is EstreeNode {
  return estreeNodeSchema.safeParse(value).success;
}

export function findCallExpressions(
  root: EstreeNode,
  calleeName: string,
): CallExpression[] {
  const calls: CallExpression[] = [];
  walkEstree(root, (node) => {
    if (
      node.type === "CallExpression" &&
      node.callee.type === "Identifier" &&
      node.callee.name === calleeName
    ) {
      calls.push(node);
    }
  });
  return calls;
}

export interface EstreeObjectProperty {
  name: string;
  line: number;
  value: Expression;
}

// Named, non-spread properties of an object literal, with source lines.
export function objectLiteralProperties(
  node: Expression | undefined | null,
): EstreeObjectProperty[] {
  if (!node || node.type !== "ObjectExpression") return [];
  const properties: EstreeObjectProperty[] = [];
  for (const property of node.properties) {
    if (property.type !== "Property") continue;
    const name =
      property.key.type === "Identifier"
        ? property.key.name
        : property.key.type === "Literal"
          ? literalStringValue(property.key)
          : null;
    if (name === null) continue;
    if (
      property.value.type === "ObjectPattern" ||
      property.value.type === "ArrayPattern" ||
      property.value.type === "RestElement" ||
      property.value.type === "AssignmentPattern"
    ) {
      continue;
    }
    properties.push({
      name,
      line: estreeLine(property),
      value: property.value,
    });
  }
  return properties;
}

// Only a string literal ({ "a": 1 }) names a property; numeric, boolean, and
// regex literals do not.
function literalStringValue(literal: Literal): string | null {
  const value = z.string().safeParse(literal.value);
  return value.success ? value.data : null;
}

// Absolute character offsets acorn and Babel record on every node beside the
// optional estree `range`.
export interface EstreeOffsets {
  start: number;
  end: number;
}

const estreeOffsetsSchema = z.object({ start: z.number(), end: z.number() });

export function hasEstreeOffsets(
  node: EstreeNode,
): node is EstreeNode & EstreeOffsets {
  return estreeOffsetsSchema.safeParse(node).success;
}

// Document-relative character offsets of an estree node — acorn (as run by
// the MDX extension) records them on every node, positioned against the full
// document. Lets a caller slice the original source for a node and hand it to
// a different parser.
export function estreeNodeRange(node: EstreeNode): EstreeOffsets | null {
  if (node.range) return { start: node.range[0], end: node.range[1] };
  return hasEstreeOffsets(node) ? { start: node.start, end: node.end } : null;
}
