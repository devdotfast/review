export type SoftwareElementType =
  | "person"
  | "softwareSystem"
  | "container"
  | "dataStore"
  | "component"
  | "codeElement";

export type SoftwareChangeStatus =
  | "added"
  | "removed"
  | "modified"
  | "unchanged";

export type SoftwareDataStoreKind =
  | "database"
  | "objectStore"
  | "bucket"
  | "artifactStore"
  | "fileStore";

export interface SoftwareLineRange {
  fromLine: number;
  toLine: number;
}

export interface SoftwareSourceRange extends SoftwareLineRange {
  file: string;
}

export interface SoftwareCoverageFileInput {
  path: string;
  ranges?: SoftwareLineRange[];
}

export interface SoftwareCoverageInput {
  files?: Array<string | SoftwareCoverageFileInput>;
  globs?: string[];
}

export interface SoftwareRelationshipBaseInput {
  from: string;
  to: string;
  label?: string;
  description?: string;
}

export interface SoftwareCallRelationshipInput extends SoftwareRelationshipBaseInput {
  kind: "call";
  nthCallSite?: number;
}

export interface SoftwareSemanticRelationshipInput extends SoftwareRelationshipBaseInput {
  kind: "semantic";
  semanticKind?: string;
  sourceRanges?: SoftwareLineRange[];
}

export type SoftwareRelationshipInput =
  | SoftwareCallRelationshipInput
  | SoftwareSemanticRelationshipInput;

export interface SoftwareElementBaseInput {
  id?: string;
  label?: string;
  description?: string;
  changeStatus?: SoftwareChangeStatus;
  coverage?: SoftwareCoverageInput;
  relationships?: SoftwareRelationshipInput[];
}

export interface PersonInput extends SoftwareElementBaseInput {}

export interface SoftwareSystemInput extends SoftwareElementBaseInput {
  external?: boolean;
  containers?: SoftwareElementCollection<ContainerInput>;
  dataStores?: SoftwareElementCollection<DataStoreInput>;
}

export interface ContainerInput extends SoftwareElementBaseInput {
  components?: SoftwareElementCollection<ComponentInput>;
}

export interface DataStoreInput extends SoftwareElementBaseInput {
  kind?: SoftwareDataStoreKind;
  tables?: Record<string, SoftwareDataStoreCollectionInput>;
  documents?: Record<string, SoftwareDataStoreCollectionInput>;
  components?: SoftwareElementCollection<ComponentInput>;
}

export type SoftwareDataStoreForeignKeyRef =
  | string
  | {
      table: string;
      field: string;
      label?: string;
      cardinality?: "one-to-one" | "many-to-one";
      onDelete?: string;
      onUpdate?: string;
    };

export interface SoftwareDataStoreFieldLeaf {
  type: string;
  example?: unknown;
  pk?: boolean;
  fk?: SoftwareDataStoreForeignKeyRef;
  schema?: SoftwareDataStoreFieldSchema;
}

export type SoftwareDataStoreFieldSchema = {
  [field: string]: SoftwareDataStoreFieldLeaf | SoftwareDataStoreFieldSchema;
};

export interface SoftwareDataStoreCollectionInput {
  label?: string;
  key?: string;
  schema: SoftwareDataStoreFieldSchema;
}

export interface NormalizedSoftwareDataStoreCollection {
  id: string;
  label: string;
  key?: string;
  schema: SoftwareDataStoreFieldSchema;
}

export interface NormalizedSoftwareDataStoreSchema {
  tables: Record<string, NormalizedSoftwareDataStoreCollection>;
  documents: Record<string, NormalizedSoftwareDataStoreCollection>;
}

export interface ComponentInput extends SoftwareElementBaseInput {
  codeElements?: SoftwareElementCollection<CodeElementInput>;
}

export interface CodeElementInput extends SoftwareElementBaseInput {
  sourceRanges?: SoftwareSourceRange[];
}

export type SoftwareElementCollection<T extends SoftwareElementBaseInput> =
  | Record<string, T>
  | T[];

export interface SoftwareModelInput {
  people?: SoftwareElementCollection<PersonInput>;
  systems?: SoftwareElementCollection<SoftwareSystemInput>;
  relationships?: SoftwareRelationshipInput[];
}

export interface NormalizedSoftwareElement {
  type: SoftwareElementType;
  id: string;
  path: string;
  parentPath?: string;
  label: string;
  description?: string;
  changeStatus?: SoftwareChangeStatus;
  coverage?: NormalizedSoftwareCoverage;
  external?: boolean;
  dataStoreKind?: SoftwareDataStoreKind;
  dataStoreSchema?: NormalizedSoftwareDataStoreSchema;
  sourceRanges?: SoftwareSourceRange[];
  children: string[];
}

export interface NormalizedSoftwareCoverageFile {
  path: string;
  ranges: SoftwareLineRange[];
}

export interface NormalizedSoftwareCoverage {
  files: NormalizedSoftwareCoverageFile[];
  globs: string[];
}

export interface NormalizedRelationshipBase {
  id: string;
  from: string;
  to: string;
  scopePath?: string;
  label?: string;
  description?: string;
}

export interface NormalizedCallRelationship extends NormalizedRelationshipBase {
  kind: "call";
  nthCallSite: number;
}

export interface NormalizedSemanticRelationship extends NormalizedRelationshipBase {
  kind: "semantic";
  semanticKind?: string;
  sourceRanges?: SoftwareLineRange[];
}

export type NormalizedSoftwareRelationship =
  | NormalizedCallRelationship
  | NormalizedSemanticRelationship;

export interface NormalizedSoftwareModel {
  elements: NormalizedSoftwareElement[];
  elementsByPath: ReadonlyMap<string, NormalizedSoftwareElement>;
  relationships: NormalizedSoftwareRelationship[];
}

interface PendingRelationship {
  input: SoftwareRelationshipInput;
  scopePath?: string;
  index: number;
}

interface ElementDraft {
  type: SoftwareElementType;
  id: string;
  path: string;
  parentPath?: string;
  label: string;
  description?: string;
  changeStatus?: SoftwareChangeStatus;
  coverage?: NormalizedSoftwareCoverage;
  external?: boolean;
  dataStoreKind?: SoftwareDataStoreKind;
  dataStoreSchema?: NormalizedSoftwareDataStoreSchema;
  sourceRanges?: SoftwareSourceRange[];
  children: string[];
}

export class SoftwareModelValidationError extends Error {
  errors: string[];

  constructor(errors: string[]) {
    super(`Invalid software model:\n- ${errors.join("\n- ")}`);
    this.name = "SoftwareModelValidationError";
    this.errors = errors;
  }
}

export function defineSoftwareMap(
  input: SoftwareModelInput,
): NormalizedSoftwareModel {
  const errors: string[] = [];
  const elements: ElementDraft[] = [];
  const elementsByPath = new Map<string, ElementDraft>();
  const pendingRelationships: PendingRelationship[] = [];

  if ("views" in input) {
    errors.push(
      "Software model must not author views; SoftwareMap derives inline C4 projection from elements, relationships, and expansion state.",
    );
  }

  flattenElements({
    collection: input.people,
    type: "person",
    parentPath: undefined,
    elements,
    elementsByPath,
    pendingRelationships,
    errors,
  });
  flattenElements({
    collection: input.systems,
    type: "softwareSystem",
    parentPath: undefined,
    elements,
    elementsByPath,
    pendingRelationships,
    errors,
  });

  for (const [index, relationship] of (input.relationships ?? []).entries()) {
    pendingRelationships.push({ input: relationship, index });
  }

  const relationships = normalizeRelationships(
    pendingRelationships,
    elementsByPath,
    errors,
  );

  if (errors.length > 0) {
    throw new SoftwareModelValidationError(errors);
  }

  const normalizedElements = elements.map((element) => Object.freeze(element));
  return Object.freeze({
    elements: normalizedElements,
    elementsByPath: new Map(
      normalizedElements.map((element) => [element.path, element]),
    ),
    relationships,
  });
}

function flattenElements({
  collection,
  type,
  parentPath,
  elements,
  elementsByPath,
  pendingRelationships,
  errors,
}: {
  collection: SoftwareElementCollection<SoftwareElementBaseInput> | undefined;
  type: SoftwareElementType;
  parentPath: string | undefined;
  elements: ElementDraft[];
  elementsByPath: Map<string, ElementDraft>;
  pendingRelationships: PendingRelationship[];
  errors: string[];
}) {
  if (!collection) return;

  const siblings = entriesForCollection(collection);
  const siblingIds = new Set<string>();
  for (const [collectionKey, input] of siblings) {
    const id = input.id ?? collectionKey;
    const path = parentPath ? `${parentPath}.${id}` : id;

    if (!id) {
      errors.push(`Software ${type} under ${parentPath ?? "model"} has no id.`);
      continue;
    }
    if (siblingIds.has(id)) {
      errors.push(
        `Duplicate ${type} id "${id}" under ${parentPath ?? "model"}.`,
      );
      continue;
    }
    siblingIds.add(id);
    if (elementsByPath.has(path)) {
      errors.push(`Duplicate element path "${path}".`);
      continue;
    }

    validateElementShape(type, path, input, errors);

    const draft: ElementDraft = {
      type,
      id,
      path,
      parentPath,
      label: input.label ?? id,
      description: input.description,
      changeStatus: input.changeStatus,
      coverage: normalizeCoverage(type, path, input.coverage, errors),
      children: [],
    };

    if (parentPath) {
      elementsByPath.get(parentPath)?.children.push(path);
    }
    if (type === "softwareSystem") {
      draft.external = (input as SoftwareSystemInput).external;
    }
    if (type === "dataStore") {
      const dataStore = input as DataStoreInput;
      draft.dataStoreKind = dataStore.kind ?? "database";
      draft.dataStoreSchema = normalizeDataStoreSchema(path, dataStore, errors);
    }
    if (type === "codeElement") {
      const codeElement = input as CodeElementInput;
      draft.sourceRanges = codeElement.sourceRanges;
      validateSourceRanges(
        codeElement.sourceRanges,
        `Code element "${path}" sourceRanges`,
        errors,
      );
    }

    elements.push(draft);
    elementsByPath.set(path, draft);

    for (const [index, relationship] of (input.relationships ?? []).entries()) {
      pendingRelationships.push({
        input: relationship,
        scopePath: path,
        index,
      });
    }

    if (type === "softwareSystem") {
      flattenElements({
        collection: (input as SoftwareSystemInput).containers,
        type: "container",
        parentPath: path,
        elements,
        elementsByPath,
        pendingRelationships,
        errors,
      });
      flattenElements({
        collection: (input as SoftwareSystemInput).dataStores,
        type: "dataStore",
        parentPath: path,
        elements,
        elementsByPath,
        pendingRelationships,
        errors,
      });
    }
    if (type === "container" || type === "dataStore") {
      flattenElements({
        collection: (input as ContainerInput | DataStoreInput).components,
        type: "component",
        parentPath: path,
        elements,
        elementsByPath,
        pendingRelationships,
        errors,
      });
    }
    if (type === "component") {
      flattenElements({
        collection: (input as ComponentInput).codeElements,
        type: "codeElement",
        parentPath: path,
        elements,
        elementsByPath,
        pendingRelationships,
        errors,
      });
    }
  }
}

function entriesForCollection<T extends SoftwareElementBaseInput>(
  collection: SoftwareElementCollection<T>,
): Array<[string, T]> {
  if (Array.isArray(collection)) {
    return collection.map((item, index) => [item.id ?? String(index), item]);
  }
  return Object.entries(collection);
}

function validateElementShape(
  type: SoftwareElementType,
  path: string,
  input: SoftwareElementBaseInput,
  errors: string[],
) {
  if ("additions" in input || "deletions" in input) {
    errors.push(
      `Element "${path}" must not author additions or deletions; diff counts are computed automatically.`,
    );
  }
  if (
    "changeStatus" in input &&
    input.changeStatus !== undefined &&
    input.changeStatus !== "added" &&
    input.changeStatus !== "removed" &&
    input.changeStatus !== "modified" &&
    input.changeStatus !== "unchanged"
  ) {
    errors.push(
      `Element "${path}" changeStatus must be one of "added", "removed", "modified", or "unchanged".`,
    );
  }
  if (
    type === "dataStore" &&
    "kind" in input &&
    input.kind !== undefined &&
    input.kind !== "database" &&
    input.kind !== "objectStore" &&
    input.kind !== "bucket" &&
    input.kind !== "artifactStore" &&
    input.kind !== "fileStore"
  ) {
    errors.push(
      `Data store "${path}" kind must be one of "database", "objectStore", "bucket", "artifactStore", or "fileStore".`,
    );
  }
  if (type !== "dataStore" && "kind" in input) {
    errors.push(`Only data stores may define kind: "${path}".`);
  }
  if (type !== "dataStore" && ("tables" in input || "documents" in input)) {
    errors.push(`Only data stores may define tables or documents: "${path}".`);
  }
  if (type === "codeElement") {
    if ("codeElements" in input) {
      errors.push(`Code element "${path}" cannot contain code elements.`);
    }
  }
  if (
    "coverage" in input &&
    input.coverage !== undefined &&
    type !== "softwareSystem" &&
    type !== "container" &&
    type !== "dataStore" &&
    type !== "component"
  ) {
    errors.push(
      `Element "${path}" coverage may only be authored on systems, containers, data stores, or components.`,
    );
  }
}

function normalizeDataStoreSchema(
  path: string,
  dataStore: DataStoreInput,
  errors: string[],
): NormalizedSoftwareDataStoreSchema | undefined {
  validateDataStoreCollectionRecord(path, "tables", dataStore.tables, errors);
  validateDataStoreCollectionRecord(
    path,
    "documents",
    dataStore.documents,
    errors,
  );
  const tables = normalizeDataStoreCollections(dataStore.tables);
  const documents = normalizeDataStoreCollections(dataStore.documents);
  if (Object.keys(tables).length === 0 && Object.keys(documents).length === 0) {
    return undefined;
  }
  return Object.freeze({
    tables: Object.freeze(tables),
    documents: Object.freeze(documents),
  });
}

function validateDataStoreCollectionRecord(
  path: string,
  property: "tables" | "documents",
  collections: Record<string, SoftwareDataStoreCollectionInput> | undefined,
  errors: string[],
) {
  if (collections === undefined) return;
  if (
    !collections ||
    typeof collections !== "object" ||
    Array.isArray(collections)
  ) {
    errors.push(`Data store "${path}" ${property} must be an object.`);
    return;
  }
  for (const [collectionId, collection] of Object.entries(collections)) {
    if (!collectionId.trim()) {
      errors.push(`Data store "${path}" ${property} contains an empty id.`);
      continue;
    }
    if (
      !collection ||
      typeof collection !== "object" ||
      Array.isArray(collection)
    ) {
      errors.push(
        `Data store "${path}" ${property}.${collectionId} must be an object.`,
      );
      continue;
    }
    validateDataStoreFieldSchema(
      collection.schema,
      `Data store "${path}" ${property}.${collectionId}.schema`,
      errors,
    );
  }
}

function normalizeDataStoreCollections(
  collections: Record<string, SoftwareDataStoreCollectionInput> | undefined,
): Record<string, NormalizedSoftwareDataStoreCollection> {
  return Object.fromEntries(
    Object.entries(collections ?? {}).map(([id, collection]) => [
      id,
      Object.freeze({
        id,
        label: collection.label ?? id,
        key: collection.key,
        schema: collection.schema,
      }),
    ]),
  );
}

function validateDataStoreFieldSchema(
  schema: SoftwareDataStoreFieldSchema | undefined,
  path: string,
  errors: string[],
) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    errors.push(`${path} must be an object.`);
    return;
  }
  for (const [field, value] of Object.entries(schema)) {
    if (!field.trim()) {
      errors.push(`${path} contains an empty field name.`);
      continue;
    }
    const fieldPath = `${path}.${field}`;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${fieldPath} must be a field object or nested schema.`);
      continue;
    }
    if (isDataStoreFieldLeaf(value)) {
      if (!value.type.trim()) {
        errors.push(`${fieldPath}.type must not be empty.`);
      }
      if (value.schema) {
        validateDataStoreFieldSchema(
          value.schema,
          `${fieldPath}.schema`,
          errors,
        );
      }
      continue;
    }
    validateDataStoreFieldSchema(value, fieldPath, errors);
  }
}

function isDataStoreFieldLeaf(
  value: SoftwareDataStoreFieldSchema[string],
): value is SoftwareDataStoreFieldLeaf {
  return (
    value !== null &&
    typeof value === "object" &&
    "type" in value &&
    typeof value.type === "string"
  );
}

function normalizeCoverage(
  type: SoftwareElementType,
  path: string,
  coverage: SoftwareCoverageInput | undefined,
  errors: string[],
): NormalizedSoftwareCoverage | undefined {
  if (!coverage) return undefined;
  if (
    type !== "softwareSystem" &&
    type !== "container" &&
    type !== "dataStore" &&
    type !== "component"
  ) {
    return undefined;
  }

  const files: NormalizedSoftwareCoverageFile[] = [];
  const globs: string[] = [];

  if (coverage.files !== undefined && !Array.isArray(coverage.files)) {
    errors.push(`Element "${path}" coverage.files must be an array.`);
  }
  for (const [index, file] of (coverage.files ?? []).entries()) {
    if (typeof file === "string") {
      if (!file.trim()) {
        errors.push(`Element "${path}" coverage.files[${index}] is empty.`);
        continue;
      }
      files.push({ path: file, ranges: [] });
      continue;
    }
    if (!file || typeof file !== "object" || !file.path) {
      errors.push(
        `Element "${path}" coverage.files[${index}] must be a file path or object with path.`,
      );
      continue;
    }
    files.push({
      path: file.path,
      ranges: file.ranges ?? [],
    });
    validateLineRanges(
      file.ranges,
      `Element "${path}" coverage.files[${index}].ranges`,
      errors,
    );
  }

  if (coverage.globs !== undefined && !Array.isArray(coverage.globs)) {
    errors.push(`Element "${path}" coverage.globs must be an array.`);
  }
  for (const [index, glob] of (coverage.globs ?? []).entries()) {
    if (typeof glob !== "string" || !glob.trim()) {
      errors.push(`Element "${path}" coverage.globs[${index}] is empty.`);
      continue;
    }
    globs.push(glob);
  }

  if (files.length === 0 && globs.length === 0) return undefined;
  return Object.freeze({
    files: files.map((file) => Object.freeze(file)),
    globs,
  });
}

function normalizeRelationships(
  pendingRelationships: PendingRelationship[],
  elementsByPath: Map<string, ElementDraft>,
  errors: string[],
): NormalizedSoftwareRelationship[] {
  const relationships: NormalizedSoftwareRelationship[] = [];

  for (const pending of pendingRelationships) {
    const from = resolveEndpoint(
      pending.input.from,
      pending.scopePath,
      elementsByPath,
    );
    const to = resolveEndpoint(
      pending.input.to,
      pending.scopePath,
      elementsByPath,
    );
    const relationshipLabel = pending.scopePath
      ? `relationship scoped to "${pending.scopePath}"`
      : "top-level relationship";

    if (!from) {
      errors.push(
        `Invalid ${relationshipLabel}: endpoint "${pending.input.from}" does not match an element path or data store schema path.`,
      );
    }
    if (!to) {
      errors.push(
        `Invalid ${relationshipLabel}: endpoint "${pending.input.to}" does not match an element path or data store schema path.`,
      );
    }
    validateRelationshipShape(pending, errors);
    if (!from || !to) continue;

    const base = {
      id: relationshipIdForPending(pending),
      from,
      to,
      scopePath: pending.scopePath,
      label: pending.input.label,
      description: pending.input.description,
    };
    if (pending.input.kind === "call") {
      relationships.push(
        Object.freeze({
          ...base,
          kind: "call",
          nthCallSite: pending.input.nthCallSite ?? 0,
        }),
      );
    } else {
      relationships.push(
        Object.freeze({
          ...base,
          kind: "semantic",
          semanticKind: pending.input.semanticKind,
          sourceRanges: pending.input.sourceRanges,
        }),
      );
    }
  }

  return relationships;
}

function validateRelationshipShape(
  pending: PendingRelationship,
  errors: string[],
) {
  if (pending.input.kind === "call") {
    const nthCallSite = pending.input.nthCallSite ?? 0;
    if (!Number.isInteger(nthCallSite) || nthCallSite < 0) {
      errors.push(
        `Call relationship "${relationshipIdForPending(
          pending,
        )}" must use a non-negative integer nthCallSite.`,
      );
    }
    return;
  }

  validateLineRanges(
    pending.input.sourceRanges,
    `Semantic relationship "${relationshipIdForPending(pending)}" sourceRanges`,
    errors,
  );
}

function resolveEndpoint(
  endpoint: string,
  scopePath: string | undefined,
  elementsByPath: Map<string, ElementDraft>,
): string | undefined {
  const candidates: string[] = [];
  if (scopePath && endpoint === ".") {
    candidates.push(scopePath);
  }
  if (scopePath && endpoint !== ".") {
    candidates.push(`${scopePath}.${endpoint}`);
    const parentPath = parentPathFor(scopePath);
    if (parentPath) candidates.push(`${parentPath}.${endpoint}`);
  }
  candidates.push(endpoint);
  for (const candidate of candidates) {
    if (elementsByPath.has(candidate)) return candidate;
    const schemaEndpoint = resolveDataStoreSchemaEndpoint(
      candidate,
      elementsByPath,
    );
    if (schemaEndpoint) return schemaEndpoint;
  }
  return undefined;
}

export interface ResolvedDataStoreSchemaEndpoint {
  dataStorePath: string;
  collectionKind: "tables" | "documents";
  collectionId: string;
  fieldPath: string[];
}

export function parseDataStoreSchemaEndpoint(
  endpoint: string,
  elementsByPath: ReadonlyMap<
    string,
    Pick<NormalizedSoftwareElement, "type" | "dataStoreSchema">
  >,
): ResolvedDataStoreSchemaEndpoint | undefined {
  for (const [dataStorePath, element] of elementsByPath) {
    if (element.type !== "dataStore" || !element.dataStoreSchema) continue;
    const parsed = parseDataStoreSchemaEndpointForStore(
      endpoint,
      dataStorePath,
      element.dataStoreSchema,
    );
    if (parsed) return parsed;
  }
  return undefined;
}

function resolveDataStoreSchemaEndpoint(
  endpoint: string,
  elementsByPath: ReadonlyMap<string, ElementDraft>,
): string | undefined {
  return parseDataStoreSchemaEndpoint(endpoint, elementsByPath)
    ? endpoint
    : undefined;
}

function parseDataStoreSchemaEndpointForStore(
  endpoint: string,
  dataStorePath: string,
  schema: NormalizedSoftwareDataStoreSchema,
): ResolvedDataStoreSchemaEndpoint | undefined {
  for (const collectionKind of ["tables", "documents"] as const) {
    const prefix = `${dataStorePath}.${collectionKind}.`;
    if (!endpoint.startsWith(prefix)) continue;
    const parts = endpoint.slice(prefix.length).split(".").filter(Boolean);
    if (parts.length === 0) continue;
    const [collectionId, ...fieldPath] = parts;
    const collection = schema[collectionKind][collectionId];
    if (!collection) continue;
    if (
      fieldPath.length > 0 &&
      !dataStoreFieldPathExists(collection.schema, fieldPath)
    ) {
      continue;
    }
    return {
      dataStorePath,
      collectionKind,
      collectionId,
      fieldPath,
    };
  }
  return undefined;
}

function dataStoreFieldPathExists(
  schema: SoftwareDataStoreFieldSchema,
  fieldPath: readonly string[],
): boolean {
  let current: SoftwareDataStoreFieldSchema = schema;
  for (const [index, part] of fieldPath.entries()) {
    const next: SoftwareDataStoreFieldSchema | SoftwareDataStoreFieldLeaf =
      current[part];
    if (!next) return false;
    if (index === fieldPath.length - 1) return true;
    if (isDataStoreFieldLeaf(next)) {
      if (!next.schema) return false;
      current = next.schema;
    } else {
      current = next;
    }
  }
  return fieldPath.length === 0;
}

function validateSourceRanges(
  sourceRanges: SoftwareSourceRange[] | undefined,
  label: string,
  errors: string[],
) {
  for (const [index, range] of (sourceRanges ?? []).entries()) {
    if (typeof range.file !== "string" || range.file.trim().length === 0) {
      errors.push(`${label}[${index}].file must be a non-empty string.`);
    }
    if (
      !Number.isInteger(range.fromLine) ||
      !Number.isInteger(range.toLine) ||
      range.fromLine < 1 ||
      range.toLine < range.fromLine
    ) {
      errors.push(
        `${label}[${index}] must use positive inclusive line numbers with fromLine <= toLine.`,
      );
    }
  }
}

function validateLineRanges(
  ranges: SoftwareLineRange[] | undefined,
  label: string,
  errors: string[],
) {
  for (const [index, range] of (ranges ?? []).entries()) {
    if (
      !Number.isInteger(range.fromLine) ||
      !Number.isInteger(range.toLine) ||
      range.fromLine < 1 ||
      range.toLine < range.fromLine
    ) {
      errors.push(
        `${label}[${index}] must use positive inclusive line numbers with fromLine <= toLine.`,
      );
    }
  }
}

function relationshipIdForPending(pending: PendingRelationship) {
  return `${pending.scopePath ?? "model"}.relationship.${pending.index}`;
}

function parentPathFor(path: string) {
  const lastDot = path.lastIndexOf(".");
  if (lastDot === -1) return undefined;
  return path.slice(0, lastDot);
}
