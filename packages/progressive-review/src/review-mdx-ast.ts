import type {
  CallExpression,
  Node as EstreeNode,
  Expression,
  ObjectExpression,
  Program,
  Property,
} from "estree";
import { fromMarkdown } from "mdast-util-from-markdown";
import { mdxFromMarkdown } from "mdast-util-mdx";
import { mdxjs } from "micromark-extension-mdxjs";

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

export interface ReviewMdxDocument {
  parseError: { message: string; line: number } | null;
  // Capitalized (component) JSX elements, in document order.
  components: MdxJsxElementHit[];
  // Every named JSX element with its attributes.
  elements: ReviewMdxElement[];
  // Markdown links (the clickable-anchor surface).
  links: ReviewMdxLink[];
  // Estree programs from `export`/`import` blocks.
  esmPrograms: Program[];
}

interface MdxParseErrorLike {
  reason?: unknown;
  message?: unknown;
  line?: unknown;
  place?: { line?: unknown } | null;
}

interface MdastNodeLike {
  type?: unknown;
  name?: unknown;
  url?: unknown;
  children?: unknown;
  attributes?: unknown;
  value?: unknown;
  data?: { estree?: unknown } | null;
  position?: {
    start?: { line?: unknown; offset?: unknown };
    end?: { offset?: unknown };
  } | null;
}

function nodeLine(node: MdastNodeLike): number {
  const line = node.position?.start?.line;
  return typeof line === "number" ? line : 1;
}

function estreeLine(node: EstreeNode | Property): number {
  const line = (node as { loc?: { start?: { line?: number } } | null }).loc
    ?.start?.line;
  return typeof line === "number" ? line : 1;
}

function isSelfClosing(source: string, node: MdastNodeLike): boolean {
  const start = node.position?.start?.offset;
  const end = node.position?.end?.offset;
  if (typeof start !== "number" || typeof end !== "number") return false;
  return /\/\s*>$/.test(source.slice(start, end).trimEnd());
}

function attributeFromNode(
  attribute: MdastNodeLike,
): ReviewMdxAttribute | null {
  if (
    attribute.type !== "mdxJsxAttribute" ||
    typeof attribute.name !== "string"
  ) {
    // Spread attributes ({...props}) carry no static name to validate.
    return null;
  }
  const base: ReviewMdxAttribute = {
    name: attribute.name,
    line: nodeLine(attribute),
  };
  if (typeof attribute.value === "string") {
    return { ...base, stringValue: attribute.value };
  }
  const value = attribute.value as MdastNodeLike | null;
  if (value && value.type === "mdxJsxAttributeValueExpression") {
    const program = value.data?.estree as Program | undefined;
    const statement = program?.body?.[0];
    if (statement && statement.type === "ExpressionStatement") {
      return { ...base, expression: statement.expression };
    }
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

  let tree: MdastNodeLike;
  try {
    tree = fromMarkdown(source, {
      extensions: [mdxjs()],
      mdastExtensions: [mdxFromMarkdown()],
    }) as MdastNodeLike;
  } catch (error) {
    const parseError = error as MdxParseErrorLike;
    const line =
      typeof parseError.line === "number"
        ? parseError.line
        : typeof parseError.place?.line === "number"
          ? parseError.place.line
          : 1;
    const message =
      typeof parseError.reason === "string"
        ? parseError.reason
        : typeof parseError.message === "string"
          ? parseError.message
          : String(error);
    document.parseError = { message, line };
    return document;
  }

  const visit = (node: MdastNodeLike): void => {
    if (
      (node.type === "mdxJsxFlowElement" ||
        node.type === "mdxJsxTextElement") &&
      typeof node.name === "string"
    ) {
      const line = nodeLine(node);
      if (/^[A-Z]/.test(node.name)) {
        document.components.push({ name: node.name, line });
      }
      const attributes = Array.isArray(node.attributes)
        ? (node.attributes as MdastNodeLike[])
            .map(attributeFromNode)
            .filter((attribute): attribute is ReviewMdxAttribute =>
              Boolean(attribute),
            )
        : [];
      document.elements.push({
        name: node.name,
        line,
        selfClosing: isSelfClosing(source, node),
        attributes,
      });
    }
    if (node.type === "link" && typeof node.url === "string") {
      document.links.push({ url: node.url, line: nodeLine(node) });
    }
    if (node.type === "mdxjsEsm") {
      const program = node.data?.estree as Program | undefined;
      if (program) document.esmPrograms.push(program);
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) visit(child as MdastNodeLike);
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

function isEstreeNode(value: unknown): value is EstreeNode {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
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
  for (const property of (node as ObjectExpression).properties) {
    if (property.type !== "Property") continue;
    const name =
      property.key.type === "Identifier"
        ? property.key.name
        : property.key.type === "Literal" &&
            typeof property.key.value === "string"
          ? property.key.value
          : null;
    if (name === null) continue;
    if (property.value.type === "ObjectPattern") continue;
    properties.push({
      name,
      line: estreeLine(property),
      value: property.value as Expression,
    });
  }
  return properties;
}

// "anchors.runtime" for a member expression on the `anchors` object.
export function anchorMemberName(
  node: Expression | undefined | null,
): string | null {
  if (
    node &&
    node.type === "MemberExpression" &&
    !node.computed &&
    node.object.type === "Identifier" &&
    node.object.name === "anchors" &&
    node.property.type === "Identifier"
  ) {
    return node.property.name;
  }
  return null;
}

export function literalString(
  node: Expression | undefined | null,
): string | null {
  return node && node.type === "Literal" && typeof node.value === "string"
    ? node.value
    : null;
}

export function literalNumber(
  node: Expression | undefined | null,
): number | null {
  return node && node.type === "Literal" && typeof node.value === "number"
    ? node.value
    : null;
}

export function expressionLine(node: Expression | Property): number {
  return estreeLine(node);
}

// Document-relative character offsets of an estree node — acorn (as run by
// the MDX extension) records them on every node, positioned against the full
// document. Lets a caller slice the original source for a node and hand it to
// a different parser.
export function estreeNodeRange(
  node: EstreeNode,
): { start: number; end: number } | null {
  const withOffsets = node as {
    range?: [number, number];
    start?: number;
    end?: number;
  };
  if (Array.isArray(withOffsets.range)) {
    return { start: withOffsets.range[0], end: withOffsets.range[1] };
  }
  if (
    typeof withOffsets.start === "number" &&
    typeof withOffsets.end === "number"
  ) {
    return { start: withOffsets.start, end: withOffsets.end };
  }
  return null;
}
