import { type JsonValue, jsonValueSchema } from "@dev.fast/review-protocol";
import { z } from "zod";

import { markdownNodes, parseMarkdown } from "../markdown.js";
import { type Source, sourceSchema } from "../source.js";

/** Deliberately safe to show to API clients, unlike filesystem/provider errors. */
export class ReviewInputError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

const text = z.string();

const label = text.trim().min(1);

const identity = { id: text.optional() };

export { type Source, sourceSchema };

export const pinsSchema = z.strictObject({
  repositoryId: label,
  base: label,
  head: label,
});

export type Pins = z.infer<typeof pinsSchema>;

const code = z.strictObject({ language: text.default("text"), text });

export const stepSchema = z
  .strictObject({
    ...identity,
    type: z.literal("step").default("step"),
    from: label,
    to: label,
    label,
    style: z.enum(["call", "return", "async"]).default("call"),
    source: sourceSchema.optional(),
    explanation: label.optional(),
    code: code.optional(),
  })
  .refine(
    (s) =>
      [s.source, s.explanation, s.code].filter((v) => v !== undefined)
        .length === 1,
    "A step needs exactly one of source, explanation, or code.",
  );

export const frameSchema = z.strictObject({
  ...identity,
  // Optional component-local name for the same frame on both sides (even if moved).
  key: label.optional(),
  source: sourceSchema,
  label: label.optional(),
  via: z
    .strictObject({
      kind: z.enum(["call", "queue", "callback", "rpc"]),
      reason: label,
    })
    .optional(),
});

export type Frame = z.infer<typeof frameSchema>;

export const sequenceSchema = z.strictObject({
  ...identity,
  type: z.literal("sequence"),
  title: label,
  actors: z.record(text, label),
  steps: z.array(stepSchema),
});

export type SequenceBlock = z.infer<typeof sequenceSchema>;

export interface DatabaseField {
  label: string;
  dataType: string;
  nullable?: boolean;
  primaryKey?: boolean;
  references?: { store: string; collection: string; field: string };
  /** An illustrative value shown beside the field. */
  example?: JsonValue;
  /** Nested fields of a document-store object field. */
  fields?: Record<string, DatabaseField>;
}

export const fieldSchema: z.ZodType<DatabaseField> = z.lazy(() =>
  z.strictObject({
    label,
    dataType: label,
    nullable: z.boolean().optional(),
    primaryKey: z.boolean().optional(),
    references: z
      .strictObject({ store: label, collection: label, field: label })
      .optional(),
    example: jsonValueSchema.optional(),
    fields: z.record(text, fieldSchema).optional(),
  }),
);

export const databaseActorSchema = z.union([
  label,
  z.strictObject({ label, softwareMapPath: label.optional() }),
]);

export const storeSchema = z.strictObject({
  label,
  storage: z.enum(["relational", "document"]),
  dataStoreKind: z
    .enum(["database", "objectStore", "bucket", "artifactStore", "fileStore"])
    .optional(),
  softwareMapPath: label.optional(),
  collections: z.record(
    text,
    z.strictObject({
      label,
      key: label.optional(),
      fields: z.record(text, fieldSchema),
    }),
  ),
});

export const operationSchema = z.strictObject({
  ...identity,
  kind: z.enum(["read", "write"]),
  store: label,
  collection: label,
  field: label.optional(),
  actor: label,
  label,
  detail: label.optional(),
  source: sourceSchema,
});

export const databaseLensSchema = z.strictObject({
  ...identity,
  type: z.literal("database_lens"),
  title: label,
  actors: z.record(text, databaseActorSchema),
  stores: z.record(text, storeSchema),
  useCases: z.array(
    z.strictObject({
      ...identity,
      label,
      summary: text.optional(),
      operations: z.array(operationSchema),
    }),
  ),
});

export type DatabaseLensBlock = z.infer<typeof databaseLensSchema>;

export type DatabaseActor = z.infer<typeof databaseActorSchema>;

export type DatabaseStore = z.infer<typeof storeSchema>;

export type DatabaseOperation = z.infer<typeof operationSchema>;

const leafSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...identity,
    type: z.literal("markdown"),
    markdown: text.describe(
      "Safe Markdown. Use [label](review-source:head/path#L10-L24) or base for a validated native source peek.",
    ),
  }),
  z.strictObject({
    ...identity,
    type: z.literal("code"),
    ...code.shape,
    caption: text.optional(),
  }),
  z.strictObject({ ...identity, type: z.literal("divider") }),
  z.strictObject({
    ...identity,
    type: z.literal("code_peek"),
    source: sourceSchema,
    caption: text.optional(),
  }),
  sequenceSchema,
  z.strictObject({
    ...identity,
    type: z.literal("call_stack_diff"),
    title: label,
    base: z.array(frameSchema),
    head: z.array(frameSchema),
  }),
  databaseLensSchema,
  z.strictObject({
    ...identity,
    type: z.literal("image"),
    assetId: label,
    alt: label,
    caption: text.optional(),
  }),
  z.strictObject({
    ...identity,
    type: z.literal("trace_quote"),
    traceId: label,
    eventId: label,
    text: label,
  }),
  z.strictObject({
    ...identity,
    type: z.literal("software_map"),
    mapVersionId: label,
    focusElementId: label.optional(),
  }),
]);

export type Block =
  | z.infer<typeof leafSchema>
  | {
      id?: string;
      type: "section";
      title: string;
      defaultCollapsed?: boolean;
      children: Block[];
    }
  | {
      id?: string;
      type: "callout";
      title?: string;
      tone: "info" | "warning" | "danger" | "success";
      children: Block[];
    };

export type Step = z.infer<typeof stepSchema>;

export type Element = Block | Step;

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
      }));

    if (element.type === "database_lens")
      return element.useCases.flatMap((useCase) =>
        useCase.operations.map((operation) => ({
          ...operation,
          id: operation.id!,
        })),
      );

    if ("source" in element && element.source)
      return [
        {
          id: element.id!,
          source: element.source,
          label: element.type === "step" ? element.label : element.caption,
          peek: element.type === "code_peek",
        },
      ];

    return [];
  });
}

export const blockSchema: z.ZodType<Block> = z.lazy(() =>
  z.union([
    leafSchema,
    z.strictObject({
      ...identity,
      type: z.literal("section"),
      title: label,
      defaultCollapsed: z.boolean().optional(),
      children: z.array(blockSchema),
    }),
    z.strictObject({
      ...identity,
      type: z.literal("callout"),
      title: label.optional(),
      tone: z.enum(["info", "warning", "danger", "success"]).default("info"),
      children: z.array(blockSchema),
    }),
  ]),
);

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

  const fresh = (element: Element) => {
    if (element.id !== undefined)
      throw new ReviewInputError("IDs are assigned by the server.");
    element.id = allocate(
      element.type === "sequence"
        ? "diagram"
        : element.type === "step"
          ? "step"
          : "block",
    );

    for (const child of children(element)) fresh(child);

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
  };

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

/** Relationships not expressible in a field schema. Sources/resources are checked by host providers. */
export function checkReferences(document: Block[]): void {
  for (const block of elements(document)) {
    const requireKey = <T>(record: Record<string, T>, name: string) => {
      if (!Object.hasOwn(record, name))
        throw new ReviewInputError(`Unknown component name: ${name}`);
    };

    if (block.type === "sequence")
      for (const step of block.steps) {
        requireKey(block.actors, step.from);
        requireKey(block.actors, step.to);
      }

    if (block.type === "call_stack_diff")
      for (const side of ["base", "head"] as const) {
        const keys = block[side].flatMap((frame) =>
          frame.key ? [frame.key] : [],
        );

        if (new Set(keys).size !== keys.length)
          throw new ReviewInputError(
            `Frame keys must be unique within ${side}.`,
          );

        for (const frame of block[side])
          if (frame.source.side !== side)
            throw new ReviewInputError(`A ${side} frame needs ${side} source.`);
      }

    if (block.type === "database_lens") {
      const field = (store: string, collection: string, name?: string) => {
        requireKey(block.stores, store);
        const collections = block.stores[store]!.collections;
        requireKey(collections, collection);

        if (name === undefined) return;

        // Nested document fields are addressed by dotted path.
        let fields: Record<string, DatabaseField> | undefined =
          collections[collection]!.fields;

        for (const part of name.split(".")) {
          if (!fields)
            throw new ReviewInputError(`Unknown component name: ${name}`);
          requireKey(fields, part);
          fields = fields[part]!.fields;
        }
      };

      for (const useCase of block.useCases)
        for (const op of useCase.operations) {
          requireKey(block.actors, op.actor);
          field(op.store, op.collection, op.field);
        }

      for (const store of Object.values(block.stores))
        for (const collection of Object.values(store.collections))
          for (const value of Object.values(collection.fields))
            if (value.references)
              field(
                value.references.store,
                value.references.collection,
                value.references.field,
              );
    }
  }
}
