import { z } from "zod";

import { markdownNodes, markdownText, parseMarkdown } from "../markdown.js";
import { type Source, sourceSchema } from "../source.js";
import { type Block, blockSchema } from "./blocks/index.js";
import { type Step, stepSchema } from "./blocks/sequence.js";
import { ReviewInputError } from "./input-error.js";

export { ReviewInputError } from "./input-error.js";

export { type Source, sourceSchema };

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

export const reviewTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("worktree"),
    repositoryId: label,
    base: label,
  }),
  z.strictObject({
    kind: z.literal("commits"),
    repositoryId: label,
    head: label,
    base: label.optional(),
  }),
]);

export type ReviewTarget = z.infer<typeof reviewTargetSchema>;

export type Element = Block | Step;

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
export function sourceReferences(
  document: Block[],
  { tolerant = false }: { tolerant?: boolean } = {},
): { id: string; source: Source; label?: string; peek?: boolean }[] {
  const reject = (message: string): [] => {
    if (tolerant) return [];
    throw new ReviewInputError(message);
  };

  return elements(document).flatMap((element) => {
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

          const source = sourceSchema.safeParse({
            side: match[1]!.toLowerCase(),
            file,
            fromLine: Number(match[3]),
            toLine: Number(match[4] ?? match[3]),
          });

          if (!source.success) {
            if (tolerant) return [];
            throw source.error;
          }

          return [{ id: `${element.id}:${node.url}`, source: source.data }];
        },
      );

    if (element.type === "call_stack_diff")
      return [...element.base, ...element.head].map((frame) => ({
        ...frame,
        id: frame.id!,
        peek: true,
      }));

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

export const documentSchema = z.array(blockSchema);

export const contentSchema = z.union([blockSchema, stepSchema]);

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

export function children(element: Element): Element[] {
  return "children" in element
    ? element.children
    : element.type === "sequence"
      ? element.steps
      : [];
}

export function elements(document: Element[]): Element[] {
  return document.flatMap((element) => [
    element,
    ...elements(children(element)),
  ]);
}

const structural = new Set([
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

/** Mutate a private candidate. Only the store owns allocation and commits. */
/** Assign server ids to an element tree that arrives without any. */
export function assignFreshIds(
  element: Element,
  allocate: (prefix: string) => string,
): void {
  if (element.id !== undefined)
    throw new ReviewInputError("IDs are assigned by the server.");
  element.id = allocate(
    element.type === "sequence"
      ? "diagram"
      : element.type === "step"
        ? "step"
        : "block",
  );

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

export function applyEdit(
  document: Block[],
  edit: Edit,
  allocate: (prefix: string) => string,
): string {
  const locate = (id: string): { element: Element; siblings: Element[] } => {
    const find = (
      siblings: Element[],
    ): ReturnType<typeof locate> | undefined => {
      for (const element of siblings) {
        if (element.id === id) return { element, siblings };
        const found = find(children(element));

        if (found) return found;
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
    const isStep = element.type === "step";

    if (
      isStep ? parent?.type !== "sequence" : parent && !("children" in parent)
    )
      throw new ReviewInputError("Invalid parent for this element.");
    const siblings: Element[] = parent ? children(parent) : document;

    if (afterId === element.id)
      throw new ReviewInputError("An element cannot follow itself.");

    if (afterId !== undefined && !siblings.some((s) => s.id === afterId))
      throw new ReviewInputError("afterId must identify a sibling.");

    // Resolve the destination before detaching, then compute its final position.
    if (from) from.splice(from.indexOf(element), 1);

    const index =
      afterId === undefined
        ? siblings.length
        : siblings.findIndex((s) => s.id === afterId) + 1;

    siblings.splice(index, 0, element);
  };

  if (edit.type === "insert") {
    fresh(edit.content);
    place(edit.content, edit.parentId, edit.afterId);

    return edit.content.id!;
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
      break;
    case "replace":
      if (element.type === "step")
        throw new ReviewInputError("Patch the step or replace its diagram.");
      fresh(edit.content);
      edit.content.id = element.id;
      siblings[index] = edit.content;
      break;
    case "move":
      // Actor names are local: moving steps between diagrams is an explicit replacement, not a move.
      if (
        element.type === "step" &&
        children(locate(edit.parentId ?? "").element) !== siblings
      )
        throw new ReviewInputError("Move steps within their own diagram.");
      place(element, edit.parentId, edit.afterId, siblings);
      break;
  }

  return edit.targetId;
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
