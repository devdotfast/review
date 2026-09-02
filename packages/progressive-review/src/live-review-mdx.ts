import { validateSpec, type Spec } from "@json-render/core";
import type { Expression, Program, Property, SpreadElement } from "estree";
import type { Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { mdxFromMarkdown } from "mdast-util-mdx";
import { gfm } from "micromark-extension-gfm";
import { mdxjs } from "micromark-extension-mdxjs";
import { z } from "zod";

import {
  sequenceDiagramPropsSchema,
  type AnchorRef,
  type SequenceDiagramProps,
} from "./authoring";
import { liveReviewCatalog } from "./live-review-catalog";
import type {
  LiveReviewPage,
  RenderDiagnostic,
  StoredLiveReviewNode,
} from "./live-review-types";
import { resolveReviewSourceTarget } from "./review-worktree-target";
import { resolveReviewSourceRange } from "./source-range-resolver";

interface MdastNode {
  type: string;
  name?: string | null;
  value?: unknown;
  children?: MdastNode[];
  attributes?: MdastAttribute[];
  data?: { estree?: Program };
  position?: {
    start: { offset?: number; line?: number };
    end: { offset?: number; line?: number };
  };
}

interface MdastAttribute {
  type: string;
  name?: string;
  value?: string | MdastNode | null;
  position?: MdastNode["position"];
}

const actorSchema = z.strictObject({
  id: z.string().min(1).optional(),
  label: z.string().min(1),
});

const peekSchema = z
  .strictObject({
    file: z.string().min(1),
    fromLine: z.number().int().positive(),
    toLine: z.number().int().positive(),
    graph: z.enum(["head", "base"]).optional(),
    theme: z.enum(["system", "light", "dark"]).optional(),
  })
  .refine((value) => value.toLine >= value.fromLine, {
    path: ["toLine"],
    message: "Must be greater than or equal to fromLine",
  });

const liveAnchorSchema = z.strictObject({
  id: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  detail: z.string().min(1).optional(),
  peek: peekSchema,
});

const messageCodeSchema = z.union([
  z.string().min(1),
  z.strictObject({
    language: z.string().min(1).optional(),
    text: z.string().min(1),
  }),
]);

const liveMessageSchema = z.strictObject({
  from: actorSchema,
  to: actorSchema,
  label: z.string().min(1),
  anchor: liveAnchorSchema.optional(),
  code: messageCodeSchema.optional(),
});

const liveSequenceSchema = z.strictObject({
  label: z.string().min(1),
  messages: z.array(liveMessageSchema).min(1),
});

export class LiveReviewMdxError extends Error {
  override readonly name = "LiveReviewMdxError";

  constructor(readonly diagnostics: RenderDiagnostic[]) {
    super(diagnostics[0]?.message ?? "Invalid Review MDX");
  }
}

export async function projectLiveReviewPage(input: {
  page: Omit<LiveReviewPage, "projection"> & { projection?: Spec };
  reviewRootPath: string;
}): Promise<Spec> {
  assertReviewNodeTree(input.page);
  const elements: Spec["elements"] = {};
  const diagramLabels = new Set<string>();
  const anchorIds = new Set<string>();
  let sourceTargetPromise: ReturnType<typeof resolveReviewSourceTarget> | null =
    null;
  const sourceTarget = () =>
    (sourceTargetPromise ??= resolveReviewSourceTarget({
      reviewRootPath: input.reviewRootPath,
    }));

  const visitNode = async (
    nodeId: string,
    parentDepth: number,
  ): Promise<void> => {
    const node = input.page.nodes[nodeId];
    if (!node) {
      throw new LiveReviewMdxError([
        { path: `nodes.${nodeId}`, message: `Missing Review node ${nodeId}.` },
      ]);
    }
    const depth = parentDepth + 1;
    const content = parseMdxBlocks(node.source, nodeId);
    const contentKeys: string[] = [];
    for (const [index, block] of content.entries()) {
      const key = `${nodeId}:content:${index + 1}`;
      contentKeys.push(key);
      if (block.kind === "markdown") {
        elements[key] = {
          type: "Markdown",
          props: { source: block.source },
          children: [],
        };
        continue;
      }
      const raw = liveSequenceSchema.parse(block.props);
      if (diagramLabels.has(raw.label)) {
        throw new LiveReviewMdxError([
          {
            path: `${nodeId}.SequenceDiagram.label`,
            message: `SequenceDiagram label must be unique: ${raw.label}`,
          },
        ]);
      }
      diagramLabels.add(raw.label);
      const messages = await Promise.all(
        raw.messages.map(async (message, messageIndex) => {
          if (!message.anchor && !message.code) {
            throw new LiveReviewMdxError([
              {
                path: `${nodeId}.SequenceDiagram.messages.${messageIndex}`,
                message: "A sequence message needs an anchor or inline code.",
              },
            ]);
          }
          let anchor: AnchorRef | undefined;
          if (message.anchor) {
            const anchorId =
              message.anchor.id ??
              `${nodeId}-${slug(raw.label)}-message-${messageIndex + 1}`;
            if (anchorIds.has(anchorId)) {
              throw new LiveReviewMdxError([
                {
                  path: `${nodeId}.SequenceDiagram.messages.${messageIndex}.anchor.id`,
                  message: `Anchor ID must be unique: ${anchorId}`,
                },
              ]);
            }
            anchorIds.add(anchorId);
            const peek = message.anchor.peek;
            const target = await sourceTarget();
            const sourceRoot =
              peek.graph === "base"
                ? target.preparedBase?.sourceRootPath
                : target.sourceRootPath;
            if (!sourceRoot) {
              throw new LiveReviewMdxError([
                {
                  path: `${nodeId}.SequenceDiagram.messages.${messageIndex}.anchor.peek`,
                  message: "The pinned source checkout is unavailable.",
                },
              ]);
            }
            const snapshot = await resolveReviewSourceRange({
              rootPath: sourceRoot,
              root: {
                kind: "range",
                file: peek.file,
                fromLine: peek.fromLine,
                toLine: peek.toLine,
              },
            });
            anchor = {
              __kind: "db-anchor-ref",
              id: anchorId,
              title: message.anchor.title ?? message.label,
              detail: message.anchor.detail,
              peek: {
                __kind: "code-peek-ref",
                props: peek,
                resolution: { snapshot },
              },
            };
          }
          return {
            from: message.from,
            to: message.to,
            label: message.label,
            ...(anchor ? { anchor } : {}),
            ...(message.code ? { code: message.code } : {}),
          };
        }),
      );
      const props = sequenceDiagramPropsSchema.parse({
        label: raw.label,
        messages,
      }) as SequenceDiagramProps;
      elements[key] = {
        type: "SequenceDiagram",
        props,
        children: [],
      };
    }

    await Promise.all(
      node.children.map((childId) => visitNode(childId, depth)),
    );
    elements[nodeId] = {
      type: "ReviewNode",
      props: {
        nodeId,
        depth,
        ...(node.title ? { title: node.title } : {}),
      },
      children: [...contentKeys, ...node.children],
    };
  };

  await visitNode(input.page.rootNodeId, -1);
  const spec: Spec = { root: input.page.rootNodeId, elements };
  const catalogResult = liveReviewCatalog.validate(spec);
  if (!catalogResult.success) {
    throw new LiveReviewMdxError(
      (catalogResult.error?.issues ?? []).map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
      })),
    );
  }
  const structure = validateSpec(spec, { checkOrphans: true });
  if (!structure.valid) {
    throw new LiveReviewMdxError(
      structure.issues.map((issue) => ({
        path: issue.elementKey ?? "projection",
        message: issue.message,
      })),
    );
  }
  return spec;
}

function assertReviewNodeTree(input: {
  rootNodeId: string;
  nodes: Record<string, StoredLiveReviewNode>;
}): void {
  const diagnostics: RenderDiagnostic[] = [];
  if (!input.nodes[input.rootNodeId]) {
    throw new LiveReviewMdxError([
      { path: "rootNodeId", message: "The Review root node is missing." },
    ]);
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const parentCounts = new Map<string, number>();
  const visit = (nodeId: string): void => {
    const node = input.nodes[nodeId];
    if (!node) return;
    if (visiting.has(nodeId)) {
      diagnostics.push({
        path: `nodes.${nodeId}.children`,
        message: "Review node tree contains a cycle.",
      });
      return;
    }
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    visited.add(nodeId);
    if (node.id !== nodeId) {
      diagnostics.push({
        path: `nodes.${nodeId}.id`,
        message: "Review node ID must match its adjacency-list key.",
      });
    }
    if (new Set(node.children).size !== node.children.length) {
      diagnostics.push({
        path: `nodes.${nodeId}.children`,
        message: "Review node children must be unique.",
      });
    }
    for (const childId of node.children) {
      if (!input.nodes[childId]) {
        diagnostics.push({
          path: `nodes.${nodeId}.children`,
          message: `Review child node is missing: ${childId}.`,
        });
        continue;
      }
      const parentCount = (parentCounts.get(childId) ?? 0) + 1;
      parentCounts.set(childId, parentCount);
      if (parentCount > 1) {
        diagnostics.push({
          path: `nodes.${childId}`,
          message: "Review node must have exactly one parent.",
        });
      }
      visit(childId);
    }
    visiting.delete(nodeId);
  };
  visit(input.rootNodeId);
  for (const nodeId of Object.keys(input.nodes)) {
    if (!visited.has(nodeId)) {
      diagnostics.push({
        path: `nodes.${nodeId}`,
        message: "Review node is not reachable from the root.",
      });
    }
  }
  if (diagnostics.length > 0) throw new LiveReviewMdxError(diagnostics);
}

type ParsedBlock =
  | { kind: "markdown"; source: string }
  | { kind: "sequence"; props: unknown };

function parseMdxBlocks(source: string, nodeId: string): ParsedBlock[] {
  if (!source.trim()) return [];
  let root: Root & MdastNode;
  try {
    root = fromMarkdown(source, {
      extensions: [gfm(), mdxjs()],
      mdastExtensions: [gfmFromMarkdown(), mdxFromMarkdown()],
    }) as Root & MdastNode;
  } catch (error) {
    throw new LiveReviewMdxError([
      {
        path: nodeId,
        message: error instanceof Error ? error.message : String(error),
      },
    ]);
  }

  rejectExecutableMdx(root, nodeId);
  const blocks: ParsedBlock[] = [];
  for (const child of root.children as MdastNode[]) {
    if (
      child.type === "mdxJsxFlowElement" &&
      child.name === "SequenceDiagram"
    ) {
      if ((child.children?.length ?? 0) > 0) {
        throw new LiveReviewMdxError([
          {
            path: `${nodeId}.SequenceDiagram`,
            message: "SequenceDiagram does not accept children.",
          },
        ]);
      }
      blocks.push({ kind: "sequence", props: jsxProps(child, nodeId) });
      continue;
    }
    const start = child.position?.start.offset;
    const end = child.position?.end.offset;
    if (typeof start !== "number" || typeof end !== "number") continue;
    const markdown = source.slice(start, end).trim();
    if (markdown) blocks.push({ kind: "markdown", source: markdown });
  }
  return blocks;
}

function rejectExecutableMdx(node: MdastNode, nodeId: string): void {
  if (
    node.type === "mdxjsEsm" ||
    node.type === "mdxFlowExpression" ||
    node.type === "mdxTextExpression"
  ) {
    throw new LiveReviewMdxError([
      {
        path: nodeId,
        message: "Executable MDX is not supported by the live Review canvas.",
      },
    ]);
  }
  if (
    (node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") &&
    node.name !== "SequenceDiagram"
  ) {
    throw new LiveReviewMdxError([
      {
        path: nodeId,
        message: `Unknown Review component: ${node.name ?? "fragment"}.`,
      },
    ]);
  }
  for (const child of node.children ?? []) rejectExecutableMdx(child, nodeId);
}

function jsxProps(node: MdastNode, nodeId: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const attribute of node.attributes ?? []) {
    if (attribute.type !== "mdxJsxAttribute" || !attribute.name) {
      throw new LiveReviewMdxError([
        {
          path: `${nodeId}.SequenceDiagram`,
          message: "Spread attributes are not supported.",
        },
      ]);
    }
    if (typeof attribute.value === "string") {
      result[attribute.name] = attribute.value;
      continue;
    }
    const value = attribute.value;
    const statement = value?.data?.estree?.body[0];
    if (!statement || statement.type !== "ExpressionStatement") {
      throw new LiveReviewMdxError([
        {
          path: `${nodeId}.SequenceDiagram.${attribute.name}`,
          message: "Component props must be JSON-like literals.",
        },
      ]);
    }
    result[attribute.name] = literalValue(statement.expression);
  }
  return result;
}

function literalValue(expression: Expression): unknown {
  if (expression.type === "Literal") {
    if ("regex" in expression || "bigint" in expression) {
      throw new Error("Only JSON-like literals are supported.");
    }
    return expression.value;
  }
  if (expression.type === "ArrayExpression") {
    return expression.elements.map((entry) => {
      if (!entry || entry.type === "SpreadElement") {
        throw new Error("Array spreads are not supported.");
      }
      return literalValue(entry);
    });
  }
  if (expression.type === "ObjectExpression") {
    return Object.fromEntries(
      expression.properties.map((entry) => objectEntry(entry)),
    );
  }
  if (
    expression.type === "TemplateLiteral" &&
    expression.expressions.length === 0
  ) {
    return expression.quasis[0]?.value.cooked ?? "";
  }
  if (
    expression.type === "UnaryExpression" &&
    expression.operator === "-" &&
    expression.argument.type === "Literal" &&
    typeof expression.argument.value === "number"
  ) {
    return -expression.argument.value;
  }
  throw new Error("Only JSON-like literal component props are supported.");
}

function objectEntry(property: Property | SpreadElement): [string, unknown] {
  if (
    property.type !== "Property" ||
    property.kind !== "init" ||
    property.method ||
    property.shorthand ||
    property.computed
  ) {
    throw new Error(
      "Object spreads and computed properties are not supported.",
    );
  }
  const key =
    property.key.type === "Identifier"
      ? property.key.name
      : property.key.type === "Literal" &&
          typeof property.key.value === "string"
        ? property.key.value
        : null;
  if (!key) {
    throw new Error("Object keys must be names or strings.");
  }
  return [key, literalValue(property.value as Expression)];
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "sequence"
  );
}

export function parentIdForNode(
  nodes: Record<string, StoredLiveReviewNode>,
  nodeId: string,
): string | null {
  for (const node of Object.values(nodes)) {
    if (node.children.includes(nodeId)) return node.id;
  }
  return null;
}
