import { isStringValue, jsonValueSchema } from "@dev.fast/review-protocol";
import { z } from "zod";

import {
  type ActorRef,
  type PeekableAnchorRef,
  type StoreRefData,
  type TargetRef,
  actorRefSchema,
  peekableAnchorRefSchema,
  resolvedTargetRefSchema,
  storeRefDataSchema,
} from "./authoring";
import type {
  DatabaseActor,
  DatabaseField,
  DatabaseLensBlock,
  DatabaseOperation,
  DatabaseStore,
} from "./review-api/document";
import { slugify } from "./slug";
import type {
  SoftwareDataStoreFieldLeaf,
  SoftwareDataStoreFieldSchema,
  SoftwareDataStoreForeignKeyRef,
} from "./software-map-model";

/** A database lens as the document stores it: the canonical block minus its
 * `type` tag, with the id always present and the legacy height kept. */
export interface DatabaseLensBlockProps {
  id: string;
  title?: string;
  height?: number;
  actors: Record<string, DatabaseActor>;
  stores: Record<string, DatabaseStore>;
  useCases: DatabaseLensBlock["useCases"];
}

const nonEmpty = z.string().min(1);

/** The legacy document nodes a lens carried as children. */
export const legacyDbUseCaseSchema = z.strictObject({
  id: nonEmpty,
  label: nonEmpty,
  summary: nonEmpty.optional(),
});

export const legacyDbReadSchema = z.strictObject({
  from: resolvedTargetRefSchema,
  to: actorRefSchema,
  label: nonEmpty,
  anchor: peekableAnchorRefSchema,
});

export const legacyDbWriteSchema = z.strictObject({
  from: actorRefSchema,
  to: resolvedTargetRefSchema,
  label: nonEmpty,
  anchor: peekableAnchorRefSchema,
});

export const legacyDatabaseLensPropsSchema = z.strictObject({
  title: nonEmpty.optional(),
  stores: z.record(nonEmpty, storeRefDataSchema),
  height: z.number().positive().optional(),
});

export interface LegacyDatabaseLensProps {
  title?: string;
  height?: number;
  stores: Record<string, StoreRefData>;
}

export interface LegacyDbOperationNode {
  name: "DbRead" | "DbWrite";
  props:
    | z.infer<typeof legacyDbReadSchema>
    | z.infer<typeof legacyDbWriteSchema>;
}

export interface LegacyDbUseCaseNode {
  props: z.infer<typeof legacyDbUseCaseSchema>;
  operations: LegacyDbOperationNode[];
}

/** Lowers a legacy lens (store data projections plus `DbUseCase` /
 * `DbRead` / `DbWrite` child nodes) to the canonical block once. Ids are
 * kept: the lens id is `db:<slug(title)>`, use cases keep their authored id,
 * and an operation's id is its anchor id, so tour state and deep links still
 * resolve. An anchor reused by later operations gets `--db-use-N` appended,
 * since operation ids double as diagram edge ids and must be unique. */
export function databaseLensBlockFromLegacy(
  props: LegacyDatabaseLensProps,
  useCases: readonly LegacyDbUseCaseNode[],
): DatabaseLensBlockProps {
  const actors: Record<string, DatabaseActor> = {};

  const actorName = (actor: ActorRef): string => {
    actors[actor.id] = actor.softwareMapPath
      ? { label: actor.label, softwareMapPath: actor.softwareMapPath }
      : actor.label;

    return actor.id;
  };

  const stores = Object.fromEntries(
    Object.entries(props.stores).map(([id, store]) => [id, storeBlock(store)]),
  );

  const anchorUses = new Map<string, number>();

  const operationId = (anchorId: string): string => {
    const uses = (anchorUses.get(anchorId) ?? 0) + 1;
    anchorUses.set(anchorId, uses);

    return uses === 1 ? anchorId : `${anchorId}--db-use-${uses}`;
  };

  const block: DatabaseLensBlockProps = {
    id: `db:${slugify(props.title ?? "database") || "database"}`,
    actors,
    stores,
    useCases: useCases.map((useCase) => {
      const entry: DatabaseLensBlockProps["useCases"][number] = {
        id: useCase.props.id,
        label: useCase.props.label,
        operations: useCase.operations.map((node) =>
          operationBlock(node, actorName, operationId),
        ),
      };

      if (useCase.props.summary !== undefined)
        entry.summary = useCase.props.summary;

      return entry;
    }),
  };

  if (props.title !== undefined) block.title = props.title;

  if (props.height !== undefined) block.height = props.height;

  return block;
}

function operationBlock(
  node: LegacyDbOperationNode,
  actorName: (actor: ActorRef) => string,
  operationId: (anchorId: string) => string,
): DatabaseOperation {
  if (node.name === "DbRead") {
    const read = legacyDbReadSchema.parse(node.props);

    return operationFor(
      "read",
      read.from,
      read.to,
      read.label,
      read.anchor,
      actorName,
      operationId,
    );
  }

  const write = legacyDbWriteSchema.parse(node.props);

  return operationFor(
    "write",
    write.to,
    write.from,
    write.label,
    write.anchor,
    actorName,
    operationId,
  );
}

function operationFor(
  kind: DatabaseOperation["kind"],
  target: TargetRef,
  actor: ActorRef,
  label: string,
  anchor: PeekableAnchorRef,
  actorName: (actor: ActorRef) => string,
  operationId: (anchorId: string) => string,
): DatabaseOperation {
  const operation: DatabaseOperation = {
    id: operationId(anchor.id),
    kind,
    store: target.storeId,
    collection: target.collectionId,
    actor: actorName(actor),
    label,
    source: anchor.peek,
  };

  if (target.path.length > 0) operation.field = target.path.join(".");

  if (anchor.detail !== undefined) operation.detail = anchor.detail;

  return operation;
}

function storeBlock(store: StoreRefData): DatabaseStore {
  const collections =
    store.kind === "relational" ? store.tables : store.documents;

  const block: DatabaseStore = {
    label: store.label,
    storage: store.kind,
    collections: Object.fromEntries(
      Object.entries(collections ?? {}).map(([id, collection]) => {
        const entry: DatabaseStore["collections"][string] = {
          label: collection.target.collectionLabel,
          fields: fieldsBlock(collection.schema, store.id),
        };

        if (collection.target.collectionKey !== undefined)
          entry.key = collection.target.collectionKey;

        return [id, entry];
      }),
    ),
  };

  if (store.dataStoreKind !== undefined)
    block.dataStoreKind = store.dataStoreKind;

  if (store.softwareMapPath !== undefined)
    block.softwareMapPath = store.softwareMapPath;

  return block;
}

/** Legacy schemas nest objects as plain records and mark leaves with `type`;
 * `"text?"` means nullable. */
export function fieldsBlock(
  schema: SoftwareDataStoreFieldSchema,
  storeId: string,
): Record<string, DatabaseField> {
  return Object.fromEntries(
    Object.entries(schema).map(([name, value]) => [
      name,
      isFieldLeaf(value)
        ? leafBlock(name, value, storeId)
        : {
            label: name,
            dataType: "object",
            fields: fieldsBlock(value, storeId),
          },
    ]),
  );
}

function leafBlock(
  name: string,
  leaf: SoftwareDataStoreFieldLeaf,
  storeId: string,
): DatabaseField {
  const nullable = leaf.type.endsWith("?");

  const field: DatabaseField = {
    label: name,
    dataType: nullable ? leaf.type.slice(0, -1) : leaf.type,
  };

  if (nullable) field.nullable = true;

  if (leaf.pk) field.primaryKey = true;

  if (leaf.fk) {
    const references = foreignKeyReference(leaf.fk, storeId);

    if (references) field.references = references;
  }

  if ("example" in leaf && leaf.example !== undefined)
    field.example = jsonValueSchema.parse(leaf.example);

  if (leaf.schema) field.fields = fieldsBlock(leaf.schema, storeId);

  return field;
}

function foreignKeyReference(
  fk: SoftwareDataStoreForeignKeyRef,
  storeId: string,
): DatabaseField["references"] | undefined {
  if (isStringValue(fk)) {
    const [collection, ...fieldPath] = fk.split(".").filter(Boolean);

    return collection && fieldPath.length > 0
      ? { store: storeId, collection, field: fieldPath.join(".") }
      : undefined;
  }

  return { store: fk.store ?? storeId, collection: fk.table, field: fk.field };
}

function isFieldLeaf(
  value: SoftwareDataStoreFieldLeaf | SoftwareDataStoreFieldSchema,
): value is SoftwareDataStoreFieldLeaf {
  return "type" in value && isStringValue(value.type);
}
