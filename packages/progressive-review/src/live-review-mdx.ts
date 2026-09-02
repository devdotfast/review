import { type Spec, validateSpec } from "@json-render/core";
import type { Expression, Program, Property, SpreadElement } from "estree";
import type { Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { mdxFromMarkdown } from "mdast-util-mdx";
import { gfm } from "micromark-extension-gfm";
import { mdxjs } from "micromark-extension-mdxjs";
import { z } from "zod";

import { extractTraceEventText } from "./agent-trace-parser";
import {
  type PeekableAnchorRef,
  type SequenceDiagramProps,
  sequenceDiagramPropsSchema,
  storeInputMapSchema,
} from "./authoring";
import {
  type LiveDatabaseLensProps,
  type LiveReviewCodePeekProps,
  type LiveReviewMarkdownProps,
  liveDatabaseLensPropsSchema,
  liveReviewCatalog,
} from "./live-review-catalog";
import type {
  LiveReviewPage,
  RenderDiagnostic,
  StoredLiveReviewNode,
} from "./live-review-types";
import { loadReviewAgentTrace } from "./review-agent-traces";
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

const liveTraceQuoteSchema = z.strictObject({
  sessionId: z.string().min(1),
  trace: z.string().min(1).optional(),
  event: z.number().int().nonnegative().optional(),
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

const liveDatabaseTargetInputSchema = z.strictObject({
  store: z.string().min(1),
  collectionKind: z.enum(["tables", "documents"]),
  collection: z.string().min(1),
  path: z.array(z.string().min(1)).optional(),
});

const liveDatabaseOperationInputSchema = z.strictObject({
  kind: z.enum(["read", "write"]),
  actor: actorSchema,
  target: liveDatabaseTargetInputSchema,
  label: z.string().min(1),
  anchor: liveAnchorSchema,
});

const liveDatabaseInputSchema = z.strictObject({
  title: z.string().min(1).optional(),
  stores: storeInputMapSchema,
  height: z.number().positive().optional(),
  useCases: z
    .array(
      z.strictObject({
        id: z.string().min(1),
        label: z.string().min(1),
        summary: z.string().min(1).optional(),
        operations: z.array(liveDatabaseOperationInputSchema).min(1),
      }),
    )
    .min(1),
});

interface LiveAnchorRegistryEntry {
  signature: string;
  anchor: Promise<PeekableAnchorRef>;
}

function resolveLiveAnchor(input: {
  raw: z.infer<typeof liveAnchorSchema>;
  fallbackId: string;
  fallbackTitle: string;
  diagnosticPath: string;
  anchors: Map<string, LiveAnchorRegistryEntry>;
  sourceTarget: () => ReturnType<typeof resolveReviewSourceTarget>;
}): Promise<PeekableAnchorRef> {
  const anchorId = input.raw.id ?? input.fallbackId;
  const title = input.raw.title ?? input.fallbackTitle;
  const signature = JSON.stringify({
    title,
    detail: input.raw.detail ?? null,
    peek: input.raw.peek,
  });
  const existing = input.anchors.get(anchorId);
  if (existing?.signature === signature) return existing.anchor;
  if (existing) {
    throw new LiveReviewMdxError([
      {
        path: `${input.diagnosticPath}.id`,
        message: `Anchor ID is reused with different source or metadata: ${anchorId}`,
      },
    ]);
  }
  const anchor = (async (): Promise<PeekableAnchorRef> => {
    const peek = input.raw.peek;
    const target = await input.sourceTarget();
    const sourceRoot =
      peek.graph === "base"
        ? target.preparedBase?.sourceRootPath
        : target.sourceRootPath;
    if (!sourceRoot) {
      throw new LiveReviewMdxError([
        {
          path: `${input.diagnosticPath}.peek`,
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
    return {
      __kind: "db-anchor-ref",
      id: anchorId,
      title,
      detail: input.raw.detail,
      peek: {
        __kind: "code-peek-ref",
        props: peek,
        resolution: { snapshot },
      },
    };
  })();
  input.anchors.set(anchorId, { signature, anchor });
  return anchor;
}

function validateLiveTraceQuote(input: {
  sessionId: string;
  trace?: string;
  event?: number;
  quote: string;
  diagnosticPath: string;
  traceQuotes: Map<string, Promise<void>>;
  sourceTarget: () => ReturnType<typeof resolveReviewSourceTarget>;
}): Promise<void> {
  const normalizedQuote = input.quote.trim().replace(/\s+/g, " ");
  const key = JSON.stringify({
    sessionId: input.sessionId,
    trace: input.trace ?? null,
    quote: normalizedQuote,
  });
  const existing = input.traceQuotes.get(key);
  if (existing) return existing;
  const validation = (async () => {
    if (!normalizedQuote) {
      throw new LiveReviewMdxError([
        {
          path: input.diagnosticPath,
          message: "TraceQuote text must not be empty.",
        },
      ]);
    }
    const target = await input.sourceTarget();
    const loaded = await loadReviewAgentTrace({
      sessionId: input.sessionId,
      trace: input.trace,
      cwd: target.sourceRootPath,
    });
    if (!loaded) {
      throw new LiveReviewMdxError([
        {
          path: input.diagnosticPath,
          message: `Trace not found for session ${input.sessionId}${input.trace ? ` (${input.trace})` : ""}.`,
        },
      ]);
    }
    const found = loaded.trace.events.some((event) =>
      extractTraceEventText(event)
        .replace(/\s+/g, " ")
        .includes(normalizedQuote),
    );
    if (!found) {
      throw new LiveReviewMdxError([
        {
          path: input.diagnosticPath,
          message: `TraceQuote text was not found in session ${input.sessionId}.`,
        },
      ]);
    }
  })();
  input.traceQuotes.set(key, validation);
  return validation;
}

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
  const anchors = new Map<string, LiveAnchorRegistryEntry>();
  const traceQuotes = new Map<string, Promise<void>>();
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
        const links = Object.fromEntries(
          await Promise.all(
            block.links.map(async (link) => {
              if (link.kind === "anchor") {
                const anchor = await resolveLiveAnchor({
                  raw: liveAnchorSchema.parse(link.anchor),
                  fallbackId: `${nodeId}-prose-${link.key}`,
                  fallbackTitle: link.text,
                  diagnosticPath: `${nodeId}.AnchorLink.${link.key}.anchor`,
                  anchors,
                  sourceTarget,
                });
                return [link.key, { kind: "anchor", anchor }] as const;
              }
              const props = liveTraceQuoteSchema.parse(link.props);
              await validateLiveTraceQuote({
                ...props,
                quote: link.text,
                diagnosticPath: `${nodeId}.TraceQuote.${link.key}`,
                traceQuotes,
                sourceTarget,
              });
              return [
                link.key,
                { kind: "trace-quote", ...props, quote: link.text },
              ] as const;
            }),
          ),
        );
        elements[key] = {
          type: "Markdown",
          props: {
            source: block.source,
            links,
          } satisfies LiveReviewMarkdownProps,
          children: [],
        };
        continue;
      }
      if (block.kind === "code-peek") {
        const raw = liveAnchorSchema.parse(block.anchor);
        const anchor = await resolveLiveAnchor({
          raw,
          fallbackId: `${nodeId}-code-peek-${index + 1}`,
          fallbackTitle: raw.title ?? "Code peek",
          diagnosticPath: `${nodeId}.CodePeek.${index + 1}.anchor`,
          anchors,
          sourceTarget,
        });
        elements[key] = {
          type: "CodePeek",
          props: { anchor } satisfies LiveReviewCodePeekProps,
          children: [],
        };
        continue;
      }
      if (block.kind === "database") {
        const raw = liveDatabaseInputSchema.parse(block.props);
        const label = raw.title ?? "Database lens";
        if (diagramLabels.has(label)) {
          throw new LiveReviewMdxError([
            {
              path: `${nodeId}.DatabaseLens.title`,
              message: `Diagram label must be unique: ${label}`,
            },
          ]);
        }
        diagramLabels.add(label);
        const useCases = await Promise.all(
          raw.useCases.map(async (useCase, useCaseIndex) => ({
            ...useCase,
            operations: await Promise.all(
              useCase.operations.map(async (operation, operationIndex) => ({
                ...operation,
                actor: {
                  id: operation.actor.id ?? slug(operation.actor.label),
                  label: operation.actor.label,
                },
                target: {
                  ...operation.target,
                  path: operation.target.path ?? [],
                },
                anchor: await resolveLiveAnchor({
                  raw: operation.anchor,
                  fallbackId: `${nodeId}-${slug(label)}-${useCaseIndex + 1}-${operationIndex + 1}`,
                  fallbackTitle: operation.label,
                  diagnosticPath: `${nodeId}.DatabaseLens.useCases.${useCaseIndex}.operations.${operationIndex}.anchor`,
                  anchors,
                  sourceTarget,
                }),
              })),
            ),
          })),
        );
        const props = liveDatabaseLensPropsSchema.parse({
          ...(raw.title ? { title: raw.title } : {}),
          stores: raw.stores,
          ...(raw.height ? { height: raw.height } : {}),
          useCases,
        }) as LiveDatabaseLensProps;
        elements[key] = {
          type: "DatabaseLens",
          props,
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
          const anchor = message.anchor
            ? await resolveLiveAnchor({
                raw: message.anchor,
                fallbackId: `${nodeId}-${slug(raw.label)}-message-${messageIndex + 1}`,
                fallbackTitle: message.label,
                diagnosticPath: `${nodeId}.SequenceDiagram.messages.${messageIndex}.anchor`,
                anchors,
                sourceTarget,
              })
            : undefined;
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
  | {
      kind: "markdown";
      source: string;
      links: ParsedInlineLink[];
    }
  | { kind: "code-peek"; anchor: unknown }
  | { kind: "sequence"; props: unknown }
  | { kind: "database"; props: unknown };

type ParsedInlineLink =
  | {
      kind: "anchor";
      key: string;
      text: string;
      anchor: unknown;
    }
  | {
      kind: "trace-quote";
      key: string;
      text: string;
      props: unknown;
    };

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
    if (child.type === "mdxJsxFlowElement" && child.name === "DatabaseLens") {
      blocks.push({ kind: "database", props: databaseProps(child, nodeId) });
      continue;
    }
    if (child.type === "mdxJsxFlowElement" && child.name === "CodePeek") {
      if ((child.children?.length ?? 0) > 0) {
        throw new LiveReviewMdxError([
          {
            path: `${nodeId}.CodePeek`,
            message: "CodePeek does not accept children.",
          },
        ]);
      }
      blocks.push({
        kind: "code-peek",
        anchor: jsxProps(child, nodeId, "CodePeek").anchor,
      });
      continue;
    }
    const start = child.position?.start.offset;
    const end = child.position?.end.offset;
    if (typeof start !== "number" || typeof end !== "number") continue;
    const markdown = markdownWithInlineLinks(source, child, nodeId);
    if (markdown.source) blocks.push({ kind: "markdown", ...markdown });
  }
  return blocks;
}

function markdownWithInlineLinks(
  source: string,
  root: MdastNode,
  nodeId: string,
): { source: string; links: ParsedInlineLink[] } {
  const blockStart = root.position?.start.offset;
  const blockEnd = root.position?.end.offset;
  if (typeof blockStart !== "number" || typeof blockEnd !== "number") {
    return { source: "", links: [] };
  }
  const links: ParsedInlineLink[] = [];
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  const visit = (node: MdastNode): void => {
    if (
      node.type === "mdxJsxTextElement" &&
      (node.name === "AnchorLink" || node.name === "TraceQuote")
    ) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      const firstChild = node.children?.[0]?.position?.start.offset;
      const lastChild = node.children?.at(-1)?.position?.end.offset;
      if (
        typeof start !== "number" ||
        typeof end !== "number" ||
        typeof firstChild !== "number" ||
        typeof lastChild !== "number"
      ) {
        throw new LiveReviewMdxError([
          {
            path: `${nodeId}.${node.name}`,
            message: `${node.name} requires text children.`,
          },
        ]);
      }
      const text = mdastText(node).trim();
      if (!text) {
        throw new LiveReviewMdxError([
          {
            path: `${nodeId}.${node.name}`,
            message: `${node.name} requires text children.`,
          },
        ]);
      }
      const key = `link-${links.length + 1}`;
      const props = jsxProps(node, nodeId, node.name);
      links.push(
        node.name === "AnchorLink"
          ? { kind: "anchor", key, text, anchor: props.anchor }
          : { kind: "trace-quote", key, text, props },
      );
      replacements.push({
        start,
        end,
        value: `[${source.slice(firstChild, lastChild)}](#review-inline-${key})`,
      });
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  let markdown = source.slice(blockStart, blockEnd);
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    const start = replacement.start - blockStart;
    const end = replacement.end - blockStart;
    markdown = `${markdown.slice(0, start)}${replacement.value}${markdown.slice(end)}`;
  }
  return { source: markdown.trim(), links };
}

function mdastText(node: MdastNode): string {
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(mdastText).join("");
}

function databaseProps(
  node: MdastNode,
  nodeId: string,
): Record<string, unknown> {
  const useCases = (node.children ?? [])
    .filter(
      (child) =>
        child.type === "mdxJsxFlowElement" && child.name === "DbUseCase",
    )
    .map((useCase) => {
      const operations = (useCase.children ?? [])
        .filter(
          (child) =>
            child.type === "mdxJsxFlowElement" &&
            (child.name === "DbRead" || child.name === "DbWrite"),
        )
        .map((operation) => {
          if ((operation.children?.length ?? 0) > 0) {
            throw new LiveReviewMdxError([
              {
                path: `${nodeId}.${operation.name}`,
                message: `${operation.name} does not accept children.`,
              },
            ]);
          }
          const props = jsxProps(
            operation,
            nodeId,
            operation.name ?? "operation",
          );
          const kind = operation.name === "DbRead" ? "read" : "write";
          return {
            kind,
            actor: kind === "read" ? props.to : props.from,
            target: kind === "read" ? props.from : props.to,
            label: props.label,
            anchor: props.anchor,
          };
        });
      return {
        ...jsxProps(useCase, nodeId, "DbUseCase"),
        operations,
      };
    });
  return {
    ...jsxProps(node, nodeId, "DatabaseLens"),
    useCases,
  };
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
    node.name !== "SequenceDiagram" &&
    node.name !== "DatabaseLens" &&
    node.name !== "DbUseCase" &&
    node.name !== "DbRead" &&
    node.name !== "DbWrite" &&
    node.name !== "CodePeek" &&
    node.name !== "AnchorLink" &&
    node.name !== "TraceQuote"
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

function jsxProps(
  node: MdastNode,
  nodeId: string,
  component = node.name ?? "component",
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const attribute of node.attributes ?? []) {
    if (attribute.type !== "mdxJsxAttribute" || !attribute.name) {
      throw new LiveReviewMdxError([
        {
          path: `${nodeId}.${component}`,
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
          path: `${nodeId}.${component}.${attribute.name}`,
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
