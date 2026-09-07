import { isStringValue } from "@dev.fast/review-protocol";
import type { Expression, Pattern, Program } from "estree";
import type { Properties } from "hast";
import type { Root } from "mdast";
import type {
  MdxJsxAttribute,
  MdxJsxExpressionAttribute,
} from "mdast-util-mdx-jsx";
import { find, html } from "property-information";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { z } from "zod";

import { maskReviewFrontmatter } from "../review-frontmatter";
import { reviewTypescriptEstreeParser } from "../review-mdx-typescript-parser";
import { rehypeReviewTargets } from "./rehype-review-targets";
import { remarkReviewAnchorLinks } from "./remark-review-anchor-links";
import { remarkReviewSections } from "./remark-review-sections";
import { DocumentParseError } from "./syntax";
import type {
  AuthoredSource,
  DocumentAttribute,
  DocumentParser,
  DocumentSyntaxNode,
  SourceSpan,
} from "./syntax";

interface TreeNode {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  value?: string;
  tagName?: string;
  name?: string | null;
  properties?: Properties;
  attributes?: (MdxJsxAttribute | MdxJsxExpressionAttribute)[];
  children?: TreeNode[];
  data?: { estree?: Program };
}

const pointSchema = z.object({
  line: z.number().optional(),
  column: z.number().optional(),
});
const parseErrorSchema = z.object({
  message: z.string(),
  line: z.number().optional(),
  column: z.number().optional(),
  place: z.union([pointSchema, z.object({ start: pointSchema })]).nullish(),
});
export const parseReviewDocument: DocumentParser = async (source) => {
  try {
    return await parseDocument(source);
  } catch (error) {
    const parsed = parseErrorSchema.safeParse(error);
    if (!parsed.success) throw error;
    const { data } = parsed;
    const point =
      data.place && "start" in data.place ? data.place.start : data.place;
    throw new DocumentParseError(
      data.message,
      data.line ?? point?.line,
      data.column ?? point?.column,
    );
  }
};
const parseDocument: DocumentParser = async (source) => {
  const modules: AuthoredSource[] = [];
  const programs: Program[] = [];
  // SAFETY: the same Babel adapter satisfies MDX's Acorn parse/offset contract
  // in the current compiler; the libraries disagree only on ESTree typings.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- Bridge the existing Babel/Acorn parser ABI, verified by corpus parity.
  const mdxOptions = {
    acorn: reviewTypescriptEstreeParser,
  } as unknown as Parameters<typeof remarkMdx>[0];
  const processor = unified()
    .use(remarkParse)
    .use(remarkFrontmatter)
    .use(remarkMdx, mdxOptions)
    .use(remarkGfm)
    .use(() => (root: Root) => {
      // SAFETY: remark's parsed root has the MDX/Markdown fields used by this traversal.
      unwrapStandaloneJsx(root as TreeNode);
    })
    .use(remarkReviewAnchorLinks)
    .use(remarkReviewSections)
    .use(remarkRehype, {
      allowDangerousHtml: true,
      passThrough: [
        "mdxjsEsm",
        "mdxFlowExpression",
        "mdxTextExpression",
        "mdxJsxFlowElement",
        "mdxJsxTextElement",
      ],
    })
    .use(rehypeReviewTargets);
  const masked = maskReviewFrontmatter(source);
  const parsed = processor.parse(masked);
  // SAFETY: remark-rehype retains the listed MDX node types alongside HAST;
  // TreeNode describes only their shared traversal fields.
  const tree = (await processor.run(parsed, masked)) as TreeNode;

  const expressions: AuthoredSource[] = [];
  const span = (
    node: { position?: TreeNode["position"] },
    fallback?: SourceSpan,
  ): SourceSpan => ({
    start: node.position?.start.offset ?? fallback?.start ?? 0,
    end: node.position?.end.offset ?? fallback?.end ?? 0,
  });
  const expression = (value: string, location: SourceSpan): number => {
    expressions.push({ value, span: location });
    return expressions.length - 1;
  };
  const convert = (node: TreeNode): DocumentSyntaxNode[] => {
    const location = span(node);
    if (node.type === "mdxjsEsm") {
      modules.push({ value: node.value ?? "", span: location });
      if (node.data?.estree) programs.push(node.data.estree);
      return [];
    }
    if (node.type === "comment") return [];
    if (node.type === "text")
      return [{ kind: "text", value: node.value ?? "", span: location }];
    if (
      node.type === "mdxTextExpression" ||
      node.type === "mdxFlowExpression"
    ) {
      if (!node.data?.estree?.body.length) return [];
      return [
        {
          kind: "expression",
          expression: expression(node.value ?? "", {
            start: location.start + 1,
            end: location.end - 1,
          }),
          span: location,
        },
      ];
    }
    const children = (node.children ?? [])
      .filter(
        (child) =>
          !(
            node.type === "element" &&
            ["table", "thead", "tbody", "tfoot", "tr"].includes(
              node.tagName ?? "",
            ) &&
            child.type === "text" &&
            !child.value?.trim()
          ),
      )
      .flatMap(convert);
    if (node.type === "root") {
      while (children[0]?.kind === "text" && !children[0].value.trim())
        children.shift();
      while (children.at(-1)?.kind === "text") {
        const last = children.at(-1);
        if (last?.kind !== "text" || last.value.trim()) break;
        children.pop();
      }
      return children;
    }
    if (node.type === "element")
      return [
        {
          kind: "element",
          name: node.tagName!,
          attributes: proseProperties(node.properties ?? {}),
          children,
          span: location,
        },
      ];
    if (
      node.type === "mdxJsxFlowElement" ||
      node.type === "mdxJsxTextElement"
    ) {
      const attributes: DocumentAttribute[] = (node.attributes ?? []).map(
        (attr) => {
          const attributeSpan = span(attr, location);
          if (attr.type === "mdxJsxExpressionAttribute")
            return {
              kind: "spread",
              expression: expression(attr.value, {
                start: attributeSpan.start + 1,
                end: attributeSpan.end - 1,
              }),
              span: attributeSpan,
            };
          if (attr.value == null || isStringValue(attr.value))
            return {
              kind: "literal",
              name: attr.name,
              value: attr.value ?? true,
              span: attributeSpan,
            };
          const valueSpan = span(attr.value, attributeSpan);
          // Synthesized anchor links carry the link's source position rather than
          // a fabricated parser position for their expression.
          const start = attr.value.position
            ? valueSpan.start + 1
            : source.indexOf(attr.value.value, location.start);
          return {
            kind: "expression",
            name: attr.name,
            expression: expression(attr.value.value, {
              start:
                start >= 0 && start < location.end ? start : location.start,
              end: valueSpan.end,
            }),
            span: attributeSpan,
          };
        },
      );
      return [
        {
          kind: "element",
          name: node.name ?? null,
          attributes,
          children,
          span: location,
        },
      ];
    }
    throw new Error(`Unhandled document syntax: ${node.type}`);
  };
  const body = convert(tree);
  return {
    title: firstHeading(parsed),
    modules,
    expressions,
    bindings: moduleBindings(programs),
    body,
  };
};

function proseProperties(properties: Properties): DocumentAttribute[] {
  return Object.entries(properties).flatMap(([name, value]) => {
    if (value === false || value === null || value === undefined) return [];
    const info = find(html, name);
    const key =
      info.attribute.startsWith("aria-") || info.attribute.startsWith("data-")
        ? info.attribute
        : info.property;
    return [
      {
        kind: "literal",
        name: key,
        value: Array.isArray(value)
          ? value.join(info.commaSeparated ? ", " : " ")
          : info.attribute.startsWith("data-")
            ? String(value)
            : value,
      },
    ];
  });
}

function unwrapStandaloneJsx(node: TreeNode): void {
  if (!node.children) return;
  node.children = node.children.flatMap((child) => {
    unwrapStandaloneJsx(child);
    if (
      child.type !== "paragraph" ||
      !child.children?.some(
        (item) =>
          item.type === "mdxJsxTextElement" ||
          item.type === "mdxTextExpression",
      )
    )
      return [child];
    if (
      !child.children.every(
        (item) =>
          ["mdxJsxTextElement", "mdxTextExpression"].includes(item.type) ||
          (item.type === "text" && !item.value?.trim()),
      )
    )
      return [child];
    return child.children
      .filter((item) => item.type !== "text")
      .map((item) => ({
        ...item,
        type:
          item.type === "mdxTextExpression"
            ? "mdxFlowExpression"
            : "mdxJsxFlowElement",
      }));
  });
}

function moduleBindings(programs: readonly Program[]): string[] {
  const names = new Set<string>();
  const binding = (node: Pattern | Expression): void => {
    if (node.type === "Identifier") names.add(node.name);
    if (node.type === "RestElement") binding(node.argument);
    if (node.type === "AssignmentPattern") binding(node.left);
    if (node.type === "ArrayPattern")
      node.elements.forEach((child) => {
        if (child) binding(child);
      });
    if (node.type === "ObjectPattern")
      node.properties.forEach((child) =>
        binding(child.type === "RestElement" ? child.argument : child.value),
      );
  };
  for (const program of programs)
    for (const statement of program.body) {
      if (statement.type === "ImportDeclaration") {
        if ("importKind" in statement && statement.importKind === "type")
          continue;
        for (const specifier of statement.specifiers) {
          if (!("importKind" in specifier) || specifier.importKind !== "type")
            names.add(specifier.local.name);
        }
      }
      const declaration =
        statement.type === "ExportNamedDeclaration"
          ? statement.declaration
          : statement;
      if (declaration?.type === "VariableDeclaration")
        declaration.declarations.forEach((item) => binding(item.id));
      if (
        (declaration?.type === "FunctionDeclaration" ||
          declaration?.type === "ClassDeclaration") &&
        declaration.id
      )
        names.add(declaration.id.name);
    }
  return [...names];
}

function firstHeading(root: Root): string {
  const heading = root.children.find(
    (node) => node.type === "heading" && node.depth === 1,
  );
  if (!heading || heading.type !== "heading") return "review";
  return heading.children
    .map((node) => ("value" in node ? node.value : ""))
    .join("");
}
