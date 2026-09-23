import { type JsonValue, jsonValueSchema } from "@dev.fast/whiteboard-protocol";
import { z } from "zod";

import { lensSourceSchema } from "../../lens-selection.js";
import { SessionInputError } from "../input-error.js";
import {
  type BlockDefinition,
  defineBlock,
  identity,
  label,
  requireKey,
  text,
} from "./definition.js";

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
  source: lensSourceSchema,
});

// The legacy MDX audit rejected these empty forms after a lens with
// unresolved operations published clean and rendered a blank canvas.
export const databaseLensSchema = defineBlock("database_lens", {
  title: label,
  actors: z.record(text, databaseActorSchema),
  stores: z
    .record(text, storeSchema)
    .refine(
      (stores) => Object.keys(stores).length > 0,
      "A database lens needs at least one store.",
    ),
  useCases: z
    .array(
      z.strictObject({
        ...identity,
        label,
        summary: text.optional(),
        operations: z
          .array(operationSchema)
          .min(1, "A use case needs at least one operation."),
      }),
    )
    .min(1, "A database lens needs at least one use case."),
});

export type DatabaseLensBlock = z.infer<typeof databaseLensSchema>;

export const database_lens = {
  type: "database_lens",
  schema: databaseLensSchema,
  check(block: DatabaseLensBlock) {
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
          throw new SessionInputError(`Unknown component name: ${name}`);
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
  },
} satisfies BlockDefinition<DatabaseLensBlock>;

export type DatabaseActor = z.infer<typeof databaseActorSchema>;

export type DatabaseStore = z.infer<typeof storeSchema>;

export type DatabaseOperation = z.infer<typeof operationSchema>;
