import { z } from "zod";

import {
  type LensSource,
  selectSource,
  sourceAnchors,
} from "../lens-selection.js";
import { markdownNodes, markdownText, parseMarkdown } from "../markdown.js";
import {
  type FileLineRange,
  type SourcePins,
  fileLineRangeSchema,
  sourcePinsSchema,
} from "../source.js";
import { fileLensTargets } from "./blocks/file_lens.js";
import {
  type FlowDiagramEdge,
  type FlowDiagramNode,
  flowEdgeSchema,
  flowNodeInsertSchema,
  flowNodeSchema,
} from "./blocks/flow_diagram.js";
import { type Block, blockSchema } from "./blocks/index.js";
import { type Step, stepSchema } from "./blocks/sequence.js";
import { ReviewInputError } from "./input-error.js";

export { ReviewInputError } from "./input-error.js";

export { type FileLineRange, type SourcePins, fileLineRangeSchema };

export {
  type Block,
  type BlockType,
  blockSchema,
  blocks,
  checkReferences,
} from "./blocks/index.js";

export { type Frame, frameSchema } from "./blocks/call_stack_diff.js";

export {
  type DatabaseActor,
  type DatabaseField,
  type DatabaseLensBlock,
  type DatabaseOperation,
  type DatabaseStore,
  databaseActorSchema,
  databaseLensSchema,
  fieldSchema,
  operationSchema,
  storeSchema,
} from "./blocks/database_lens.js";

export {
  type SequenceBlock,
  type Step,
  sequenceSchema,
  stepSchema,
} from "./blocks/sequence.js";

const text = z.string();

const label = text.trim().min(1);

export const pinsSchema = z.strictObject({
  repositoryId: label,
  base: label,
  head: label,
});

/** Source identity retained internally for a saved worktree generation. */
/** worktreeRevision is a refresh token, never an address for stored source. */
export type Pins = z.infer<typeof pinsSchema> & { worktreeRevision?: string };

export { sourcePinsSchema };

/** The pins one source reference reads at: its own when it names them,
 * otherwise its document's. A reference with base-less pins reads base at
 * head, like a commits target without a base. */
export function anchorPins(
  source: { pins?: SourcePins },
  documentPins: Pins | undefined,
): Pins {
  if (source.pins)
    return {
      repositoryId: source.pins.repositoryId,
      base: source.pins.base ?? source.pins.head,
      head: source.pins.head,
    };

  if (!documentPins)
    throw new ReviewInputError(
      "This source names no repository or commit, and the document has no pins.",
    );

  return documentPins;
}

/** Distinct explicit pins named by a document's references, for validation. */
export function explicitPins(references: { source: { pins?: SourcePins } }[]) {
  const seen = new Map<string, Pins>();

  for (const { source } of references)
    if (source.pins) {
      const pins = anchorPins(source, undefined);
      seen.set(JSON.stringify(pins), pins);
    }

  return [...seen.values()];
}

export const reviewTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("worktree"),
    repositoryId: label,
    base: label.optional(),
  }),
  z.strictObject({
    kind: z.literal("commits"),
    repositoryId: label,
    head: label,
    base: label.optional(),
  }),
]);

export type ReviewTarget = z.infer<typeof reviewTargetSchema>;

/** Everything with an id: blocks, and the units diagrams are drawn from. */
export type Element = Block | Step | FlowDiagramNode | FlowDiagramEdge;

/** A diagram unit: addressed on its own, but only ever inside its diagram. */
export type Unit = Step | FlowDiagramNode | FlowDiagramEdge;

const unitTypes = new Set(["step", "flow_node", "flow_edge"]);

export const isUnit = (element: Element): element is Unit =>
  unitTypes.has(element.type);

/** Inline trace quotes keep paragraph/list layout while using retained resources. */
export function traceQuoteLink(
  href: string,
): { traceId: string; eventId: string } | undefined {
  const match = /^review-trace:([^#]+)#(.+)$/.exec(href);

  return match
    ? {
        traceId: decodeURIComponent(match[1]!),
        eventId: decodeURIComponent(match[2]!),
      }
    : undefined;
}

export function resourceReference(
  block: Block,
): { id: string; kind: "image" | "trace" | "map" } | undefined {
  switch (block.type) {
    case "image":
      return { id: block.assetId, kind: "image" };
    case "trace_quote":
      return { id: block.traceId, kind: "trace" };
    case "software_map":
      return { id: block.mapVersionId, kind: "map" };
    default:
      return undefined;
  }
}

export function resourceReferences(document: Block[]): Block[] {
  return elements(document).flatMap((block): Block[] => {
    if (block.type !== "markdown")
      return block.type === "image" ||
        block.type === "trace_quote" ||
        block.type === "software_map"
        ? [block]
        : [];

    return [...markdownNodes(parseMarkdown(block.markdown))].flatMap(
      (node): Block[] => {
        if (node.type !== "link" || !node.url?.startsWith("review-trace:"))
          return [];
        const quote = traceQuoteLink(node.url);

        if (!quote) throw new ReviewInputError("Invalid trace quote link.");

        return [{ type: "trace_quote", ...quote, text: markdownText(node) }];
      },
    );
  });
}

/**
 * Source-bearing items share their owning element's stable identity.
 * `tolerant` skips malformed Markdown source links instead of rejecting, for
 * content that is already stored.
 */
function documentReferences(
  document: Block[],
  { tolerant = false }: { tolerant?: boolean } = {},
): {
  id: string;
  source: LensSource;
  label?: string;
  peek?: boolean;
}[] {
  const reject = (message: string): [] => {
    if (tolerant) return [];
    throw new ReviewInputError(message);
  };

  return elements(document).flatMap<{
    id: string;
    source: LensSource;
    label?: string;
    peek?: boolean;
  }>((element) => {
    if (element.type === "markdown")
      return [...markdownNodes(parseMarkdown(element.markdown))].flatMap(
        (node) => {
          if (node.type !== "link" || !/^review-source:/i.test(node.url ?? ""))
            return [];

          const match =
            /^review-source:(base|head)\/(.+)#L(\d+)(?:-L(\d+))?$/i.exec(
              node.url!,
            );

          if (!match)
            return reject(
              "Use review-source:head/path#L10-L24 (or base) for a source link.",
            );
          let file: string;

          try {
            file = decodeURIComponent(match[2]!);
          } catch {
            return reject("Invalid URL encoding in source link.");
          }

          let source = fileLineRangeSchema.safeParse({
            side: match[1]!.toLowerCase(),
            file,
            fromLine: Number(match[3]),
            toLine: Number(match[4] ?? match[3]),
          });

          // A block's pins are the default for every link it holds.
          if (source.success && element.pins)
            source = fileLineRangeSchema.safeParse({
              ...source.data,
              pins: element.pins,
            });

          if (!source.success) {
            if (tolerant) return [];
            throw source.error;
          }

          return [
            {
              id: `${element.id}:${node.url}`,
              source: selectSource(source.data),
            },
          ];
        },
      );

    if (element.type === "file_lens")
      return fileLensTargets(element).flatMap((target, index) =>
        target.kind === "ranges"
          ? target.sources.map((source, range) => ({
              id: `${element.id}:target:${index}:${range}`,
              source,
            }))
          : [],
      );

    if (element.type === "flow_diagram")
      return element.nodes.flatMap((node) =>
        node.attachments.flatMap((attachment, index) =>
          attachment.sources.map((source, sourceIndex) => ({
            id: `${element.id}:${node.key}:${index}:${sourceIndex}`,
            source,
            label: attachment.label,
            peek: true,
          })),
        ),
      );

    if (element.type === "call_stack_diff")
      return [...element.base, ...element.head].flatMap((frame) => [
        { ...frame, id: frame.id!, peek: true },
        ...(frame.contextSources ?? []).map((source, index) => ({
          id: `${frame.id}:context:${index}`,
          source,
        })),
        ...(frame.callSite
          ? [
              {
                id: `${frame.id}:call-site`,
                source: frame.callSite,
                label: frame.label,
                peek: true,
              },
            ]
          : []),
      ]);

    if (element.type === "database_lens")
      return element.useCases.flatMap((useCase) =>
        useCase.operations.map((operation) => ({
          ...operation,
          id: operation.id!,
          peek: true,
        })),
      );

    // A code peek, a sequence step, a frame and an operation all render the
    // range as a peek, so a whitespace-only range is an authoring mistake for
    // each of them. Prose links only need the range to exist.
    if ("source" in element && element.source)
      return [
        {
          id: element.id!,
          source: element.source,
          label: element.type === "step" ? element.label : element.caption,
          peek: true,
        },
      ];

    return [];
  });
}

/** All authored attachments, including code peeks, select the aligned diff. */
export const selectionReferences = documentReferences;

export const lensSourceReferences = selectionReferences;

/** Per-side read coordinates for endpoint validation and retained source quotes. */
export function sourceReferences(
  document: Block[],
  options: { tolerant?: boolean } = {},
) {
  return selectionReferences(document, options).flatMap((ref) =>
    sourceAnchors(ref.source).map((source) => ({ ...ref, source })),
  );
}

export const documentSchema = z.array(blockSchema);

export const contentSchema = z.union([
  blockSchema,
  stepSchema,
  flowNodeInsertSchema,
  flowEdgeSchema,
]);

const placement = { parentId: label.optional(), afterId: label.optional() };

export const editSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("insert"),
    content: contentSchema,
    ...placement,
  }),
  z.strictObject({
    type: z.literal("replace"),
    targetId: label,
    content: blockSchema,
  }),
  z.strictObject({
    type: z.literal("update"),
    targetId: label,
    changes: z.record(text, z.json()),
  }),
  z.strictObject({ type: z.literal("move"), targetId: label, ...placement }),
  z.strictObject({ type: z.literal("remove"), targetId: label }),
]);

export type Edit = z.infer<typeof editSchema>;

/**
 * What one saved version did, for a canvas drawing the document as the
 * agent writes it: the edit's kind, the element it landed on, and the block
 * that element belongs to (itself, for a block; its diagram, for a unit).
 */
export interface EditSummary {
  type: Edit["type"];
  targetId: string;
  blockId: string;
  /** What the target is: a block type or a unit type. */
  kind: Element["type"];
  unit?: Unit["type"];
  /** The edge a new flow node arrived with, drawn right after the node. */
  linkId?: string;
  /** An update's patched fields, so the canvas can draw only what changed. */
  fields?: string[];
  /** A diagram written whole: its units in the order a hand would draw
   * them, so the canvas can trace the whole diagram in one quick pass. */
  units?: string[];
}

/** What applying an edit produced: the target, and the edge a node came with. */
export interface Applied {
  targetId: string;
  linkId?: string;
}

/** The block an element belongs to: itself, or the diagram around a unit. */
export function enclosingBlock(
  document: Element[],
  id: string,
): { block: Element; element: Element } | undefined {
  for (const block of elements(document)) {
    if (block.id === id) return { block, element: block };

    for (const list of childLists(block))
      for (const element of list)
        if (element.id === id && isUnit(element)) return { block, element };
  }

  return undefined;
}

/** Summarize an edit against the document it was applied to. A removed
 * element is found in the document before the edit; everything else after. */
export function summarizeEdit(
  edit: Edit,
  applied: Applied,
  before: Element[],
  after: Element[],
): EditSummary | undefined {
  const found = enclosingBlock(
    edit.type === "remove" ? before : after,
    applied.targetId,
  );

  if (!found?.block.id) return undefined;

  const summary: EditSummary = {
    type: edit.type,
    targetId: applied.targetId,
    blockId: found.block.id,
    kind: found.element.type,
  };

  if (isUnit(found.element)) summary.unit = found.element.type;

  if (applied.linkId) summary.linkId = applied.linkId;

  if (edit.type === "update") summary.fields = Object.keys(edit.changes);

  if (edit.type === "insert" || edit.type === "replace") {
    const units = drawOrder(found.element);

    if (units.length) summary.units = units;
  }

  return summary;
}

/** The order a hand draws a diagram: a sequence step by step; a flow node by
 * node, each edge as soon as both of its ends are on the board. */
export function drawOrder(element: Element): string[] {
  if (element.type === "sequence")
    return element.steps.flatMap((step) => (step.id ? [step.id] : []));

  if (element.type !== "flow_diagram") return [];

  const order: string[] = [];
  const drawn = new Set<string>();
  const waiting = [...element.edges];

  for (const node of element.nodes) {
    if (node.id) order.push(node.id);

    drawn.add(node.key);

    for (let i = 0; i < waiting.length; ) {
      const edge = waiting[i]!;

      if (drawn.has(edge.from) && drawn.has(edge.to)) {
        if (edge.id) order.push(edge.id);

        waiting.splice(i, 1);
      } else i++;
    }
  }

  return order;
}

/** The arrays an element's children live in, so an edit can splice the
 * real list. A flow diagram keeps its nodes and edges apart. */
export function childLists(element: Element): Element[][] {
  if ("children" in element) return [element.children];

  if (element.type === "sequence") return [element.steps];

  if (element.type === "flow_diagram") return [element.nodes, element.edges];

  return [];
}

export function children(element: Element): Element[] {
  return childLists(element).flat();
}

export function elements(document: Element[]): Element[] {
  return document.flatMap((element) => [
    element,
    ...elements(children(element)),
  ]);
}

const unitParent = {
  step: "sequence",
  flow_node: "flow_diagram",
  flow_edge: "flow_diagram",
} as const;

const structural = new Set([
  "nodes",
  "edges",
  "id",
  "type",
  "children",
  "steps",
  "actors",
  "stores",
  "useCases",
  "base",
  "head",
]);

const idPrefix = (element: Element) =>
  element.type === "sequence" || element.type === "flow_diagram"
    ? "diagram"
    : element.type === "step"
      ? "step"
      : element.type === "flow_node"
        ? "node"
        : element.type === "flow_edge"
          ? "edge"
          : "block";

/** Flow units saved before they had ids or types get both on the next
 * write, so a stored diagram can be drawn on unit by unit. */
export function adoptFlowUnits(
  document: Element[],
  allocate: (prefix: string) => string,
): void {
  for (const element of elements(document)) {
    if (element.type === "flow_diagram") {
      for (const node of element.nodes) node.type ??= "flow_node";

      for (const edge of element.edges) edge.type ??= "flow_edge";
    }

    if (isUnit(element) && element.id === undefined)
      element.id = allocate(idPrefix(element));
  }
}

/** Mutate a private candidate. Only the store owns allocation and commits. */
/** Assign server ids to an element tree that arrives without any. */
export function assignFreshIds(
  element: Element,
  allocate: (prefix: string) => string,
): void {
  if (element.id !== undefined)
    throw new ReviewInputError("IDs are assigned by the server.");
  element.id = allocate(idPrefix(element));

  for (const child of children(element)) assignFreshIds(child, allocate);

  const assign = (item: { id?: string }, prefix: string) => {
    if (item.id !== undefined)
      throw new ReviewInputError("IDs are assigned by the server.");
    item.id = allocate(prefix);
  };

  if (element.type === "call_stack_diff")
    for (const frame of [...element.base, ...element.head])
      assign(frame, "frame");

  if (element.type === "database_lens")
    for (const useCase of element.useCases) {
      assign(useCase, "case");

      for (const op of useCase.operations) assign(op, "operation");
    }
}

export interface ApplyEditOptions {
  /** Where a root-level insert with no placement lands: the end by default. */
  placement?: "first" | "last";
}

export function applyEdit(
  document: Block[],
  edit: Edit,
  allocate: (prefix: string) => string,
  options: ApplyEditOptions = {},
): Applied {
  adoptFlowUnits(document, allocate);

  const locate = (id: string): { element: Element; siblings: Element[] } => {
    const find = (
      siblings: Element[],
    ): ReturnType<typeof locate> | undefined => {
      for (const element of siblings) {
        if (element.id === id) return { element, siblings };

        for (const list of childLists(element)) {
          const found = find(list);

          if (found) return found;
        }
      }
    };

    const found = find(document);

    if (!found) throw new ReviewInputError(`Target ${id} does not exist.`);

    return found;
  };

  const fresh = (element: Element) => assignFreshIds(element, allocate);

  const place = (
    element: Element,
    parentId?: string,
    afterId?: string,
    from?: Element[],
  ) => {
    const parent = parentId ? locate(parentId).element : undefined;

    if (parent && elements([element]).includes(parent))
      throw new ReviewInputError("Cannot move a block inside itself.");

    if (!isUnit(element) && parent && !("children" in parent))
      throw new ReviewInputError("Invalid parent for this element.");

    if (isUnit(element) && parent?.type !== unitParent[element.type])
      throw new ReviewInputError(
        `A ${element.type} belongs inside a ${unitParent[element.type]}.`,
      );

    // A unit's parent type was checked just above: a flow diagram's lists
    // are [nodes, edges]; every other container has one list.
    const siblings: Element[] = parent
      ? (childLists(parent)[element.type === "flow_edge" ? 1 : 0] ?? document)
      : document;

    if (afterId === element.id)
      throw new ReviewInputError("An element cannot follow itself.");

    if (afterId !== undefined && !siblings.some((s) => s.id === afterId))
      throw new ReviewInputError("afterId must identify a sibling.");

    // Resolve the destination before detaching, then compute its final position.
    if (from) from.splice(from.indexOf(element), 1);

    // A running log reads newest first, so a root insert with no placement
    // may lead the document; a move or a unit inside a diagram never does.
    const index =
      afterId !== undefined
        ? siblings.findIndex((s) => s.id === afterId) + 1
        : !parent && !from && options.placement === "first"
          ? 0
          : siblings.length;

    siblings.splice(index, 0, element);
  };

  if (edit.type === "insert") {
    // A node that arrives with its edge: the node is placed first, then the
    // edge joins it to the board, so the layout has both from the start.
    if (edit.content.type === "flow_node" && edit.content.link) {
      const { link, ...node } = edit.content;

      if ((link.from === undefined) === (link.to === undefined))
        throw new ReviewInputError(
          "A link names exactly one of from or to: the node already on the board.",
        );
      fresh(node);
      place(node, edit.parentId, edit.afterId);

      const edge: FlowDiagramEdge = {
        type: "flow_edge",
        from: link.from ?? node.key,
        to: link.to ?? node.key,
      };

      if (link.label !== undefined) edge.label = link.label;

      if (link.style !== undefined) edge.style = link.style;
      fresh(edge);
      place(edge, edit.parentId);

      return { targetId: node.id!, linkId: edge.id! };
    }

    fresh(edit.content);
    place(edit.content, edit.parentId, edit.afterId);

    return { targetId: edit.content.id! };
  }

  const { element, siblings } = locate(edit.targetId);
  const index = siblings.indexOf(element);

  switch (edit.type) {
    case "update": {
      if (!Object.keys(edit.changes).length)
        throw new ReviewInputError("Supply at least one field to update.");

      for (const key of Object.keys(edit.changes))
        if (
          structural.has(key) ||
          ["__proto__", "constructor", "prototype"].includes(key)
        )
          throw new ReviewInputError(
            `Cannot patch ${key}; use structural edits or replace.`,
          );

      if ("link" in edit.changes)
        throw new ReviewInputError(
          "A link only comes with a new node; insert a flow_edge instead.",
        );

      const merged = Object.fromEntries(
        Object.entries({ ...element, ...edit.changes }).filter(
          ([, value]) => value !== null,
        ),
      );

      siblings[index] = contentSchema.parse(merged);
      break;
    }

    case "remove":
      siblings.splice(index, 1);

      // A node takes its edges with it: an edge with a missing end is not a
      // state the diagram can be in, and the agent asked for the node to go.
      if (element.type === "flow_node") {
        const diagram = elements(document).find(
          (candidate) =>
            candidate.type === "flow_diagram" && candidate.nodes === siblings,
        );

        if (diagram?.type === "flow_diagram")
          diagram.edges = diagram.edges.filter(
            (edge) => edge.from !== element.key && edge.to !== element.key,
          );
      }

      break;
    case "replace":
      if (isUnit(element))
        throw new ReviewInputError(
          `Patch the ${element.type} or replace its diagram.`,
        );
      fresh(edit.content);
      edit.content.id = element.id;
      siblings[index] = edit.content;
      break;
    case "move":
      // Names are diagram-local: moving a unit between diagrams is an explicit replacement, not a move.
      if (
        isUnit(element) &&
        !childLists(locate(edit.parentId ?? "").element).includes(siblings)
      )
        throw new ReviewInputError(
          `Move a ${element.type} within its own diagram.`,
        );
      place(element, edit.parentId, edit.afterId, siblings);
      break;
  }

  return { targetId: edit.targetId };
}

/** Rewrite only parsed destinations, simultaneously, preserving surrounding Markdown. */
export function rewriteSourceLinks(
  markdown: string,
  replacements: Map<string, string>,
): string {
  const edits: { start: number; end: number; value: string }[] = [];

  for (const node of markdownNodes(parseMarkdown(markdown))) {
    if (node.type !== "definition" && (node.type !== "link" || node.identifier))
      continue;
    const value = node.url && replacements.get(node.url);
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;

    if (!value || start === undefined || end === undefined) continue;
    const raw = markdown.slice(start, end);

    const labelEnd =
      (node.children?.at(-1)?.position?.end.offset ?? start) - start;

    let destination =
      node.type === "definition"
        ? raw.indexOf("]:") + 2
        : raw.startsWith("<")
          ? 1
          : raw.indexOf("](", labelEnd) + 2;

    while (/\s/.test(raw[destination] ?? "") && destination < raw.length)
      destination++;

    if (raw[destination] === "<") destination++;

    if (!raw.startsWith(node.url!, destination)) continue;
    edits.push({
      start: start + destination,
      end: start + destination + node.url!.length,
      value,
    });
  }

  for (const edit of edits.sort((a, b) => b.start - a.start))
    markdown =
      markdown.slice(0, edit.start) + edit.value + markdown.slice(edit.end);

  return markdown;
}
