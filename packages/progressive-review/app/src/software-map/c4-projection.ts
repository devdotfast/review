import { isStringValue } from "@dev.fast/review-protocol";
import { z } from "zod";

import { parseDataStoreSchemaEndpoint } from "./model";
import type {
  NormalizedSoftwareDataStoreCollection,
  NormalizedSoftwareElement,
  NormalizedSoftwareModel,
  NormalizedSoftwareRelationship,
  SoftwareChangeStatus,
  SoftwareDataStoreFieldLeaf,
  SoftwareDataStoreFieldSchema,
  SoftwareDataStoreForeignKeyRef,
  SoftwareDataStoreKind,
  SoftwareElementType,
} from "./model";

export interface C4ProjectionInput {
  model: NormalizedSoftwareModel;
  expandedNodeIds: ReadonlySet<string>;
  selectedNodeId?: string;
  modifiedOnly?: boolean;
  showRemovedNodes?: boolean;
  changedNodeIds?: ReadonlySet<string>;
}

export interface ProjectedC4Node {
  id: string;
  path: string;
  type: ProjectedC4NodeType;
  label: string;
  description?: string;
  changeStatus?: SoftwareChangeStatus;
  external?: boolean;
  dataStoreKind?: SoftwareDataStoreKind;
  parentPath?: string;
  children: string[];
  childCount: number;
  dataStoreSchemaSections?: ProjectedC4DataStoreSchemaSection[];
  isExpanded: boolean;
  isExpandable: boolean;
  isSelected: boolean;
  element?: NormalizedSoftwareElement;
}

export type ProjectedC4NodeType = SoftwareElementType | "dataStoreCollection";

export interface ProjectedC4DataStoreSchemaSection {
  id: string;
  label: string;
  kind: "table" | "document";
  key?: string;
  rows: ProjectedC4DataStoreSchemaRow[];
}

export interface ProjectedC4DataStoreSchemaRow {
  id: string;
  label: string;
  depth?: number;
  type?: string;
  example?: string;
  primaryKey?: boolean;
  foreignKey?: boolean;
}

export interface ProjectedC4Relationship {
  id: string;
  kind: NormalizedSoftwareRelationship["kind"] | "implied";
  from: string;
  to: string;
  label?: string;
  semanticKind?: string;
  sourceRelationshipIds: string[];
  count: number;
  relationships: NormalizedSoftwareRelationship[];
  hideLabel?: boolean;
  fromSchemaFieldPath?: string[];
  toSchemaFieldPath?: string[];
  fromSchemaEndpointKind?: "field" | "header";
  toSchemaEndpointKind?: "field" | "header";
}

export interface C4Projection {
  nodes: ProjectedC4Node[];
  relationships: ProjectedC4Relationship[];
  visibleNodeIds: ReadonlySet<string>;
  expandedNodeIds: ReadonlySet<string>;
  selectedNodeId?: string;
}

interface RelationshipBucket {
  kind: NormalizedSoftwareRelationship["kind"];
  from: string;
  to: string;
  sourceRelationshipIds: string[];
  relationships: NormalizedSoftwareRelationship[];
}

export function projectInlineC4({
  model,
  expandedNodeIds,
  selectedNodeId,
  modifiedOnly = false,
  showRemovedNodes = true,
  changedNodeIds,
}: C4ProjectionInput): C4Projection {
  const baseVisibleNodeIds = visibleNodeIdsForProjection(
    model,
    expandedNodeIds,
    showRemovedNodes,
  );
  const visibleNodeIds = modifiedOnly
    ? changedVisibleNodeIdsForProjection(
        model,
        baseVisibleNodeIds,
        changedNodeIds,
        expandedNodeIds,
      )
    : baseVisibleNodeIds;
  const effectiveExpandedNodeIds = new Set<string>();
  const baseRelationships = [
    ...projectRelationships(model, baseVisibleNodeIds, showRemovedNodes),
    ...projectDataStoreForeignKeyRelationships(model, baseVisibleNodeIds),
  ];

  const nodes = model.elements.flatMap((element) => {
    if (!visibleNodeIds.has(element.path)) return [];
    const isExpanded =
      isElementExpandable(element) && expandedNodeIds.has(element.path);
    if (isExpanded) {
      effectiveExpandedNodeIds.add(element.path);
    }
    const node = projectNode(
      model,
      element,
      visibleNodeIds,
      isExpanded,
      selectedNodeId,
      showRemovedNodes,
    );
    return [
      node,
      ...(isExpanded
        ? projectDataStoreCollectionNodes(element, selectedNodeId)
        : []),
    ];
  });

  return {
    nodes,
    relationships: modifiedOnly
      ? projectModifiedOnlyRelationships(baseRelationships, visibleNodeIds)
      : baseRelationships,
    visibleNodeIds,
    expandedNodeIds: effectiveExpandedNodeIds,
    selectedNodeId,
  };
}

export function collapseInlineC4Node(
  expandedNodeIds: ReadonlySet<string>,
  nodeId: string,
): Set<string> {
  const collapsed = new Set(expandedNodeIds);
  for (const expandedNodeId of expandedNodeIds) {
    if (expandedNodeId === nodeId || isDescendantPath(expandedNodeId, nodeId)) {
      collapsed.delete(expandedNodeId);
    }
  }
  return collapsed;
}

export function isInlineC4Expandable(element: NormalizedSoftwareElement) {
  return isElementExpandable(element);
}

function visibleNodeIdsForProjection(
  model: NormalizedSoftwareModel,
  expandedNodeIds: ReadonlySet<string>,
  showRemovedNodes: boolean,
) {
  const visibleNodeIds = new Set<string>();
  const rootNodes = model.elements.filter(
    (element) =>
      !element.parentPath &&
      (element.type === "person" || element.type === "softwareSystem"),
  );

  for (const rootNode of rootNodes) {
    addVisibleSubtree(
      model,
      rootNode,
      expandedNodeIds,
      visibleNodeIds,
      showRemovedNodes,
    );
  }

  return visibleNodeIds;
}

function changedVisibleNodeIdsForProjection(
  model: NormalizedSoftwareModel,
  baseVisibleNodeIds: ReadonlySet<string>,
  changedNodeIds: ReadonlySet<string> | undefined,
  expandedNodeIds: ReadonlySet<string>,
) {
  const visibleNodeIds = new Set<string>();
  if (changedNodeIds) {
    for (const changedNodeId of changedNodeIds) {
      const endpoint = projectedEndpoint(
        model,
        changedNodeId,
        baseVisibleNodeIds,
      );
      if (!endpoint) continue;
      visibleNodeIds.add(endpoint);
      addExpandedDataStoreCollectionPaths(
        model,
        endpoint,
        expandedNodeIds,
        baseVisibleNodeIds,
        visibleNodeIds,
      );
    }
  }
  for (const element of model.elements) {
    if (!isChangedElement(element)) continue;
    const endpoint = projectedEndpoint(model, element.path, baseVisibleNodeIds);
    if (!endpoint) continue;
    visibleNodeIds.add(endpoint);
    addExpandedDataStoreCollectionPaths(
      model,
      endpoint,
      expandedNodeIds,
      baseVisibleNodeIds,
      visibleNodeIds,
    );
  }
  return visibleNodeIds;
}

function addExpandedDataStoreCollectionPaths(
  model: NormalizedSoftwareModel,
  endpoint: string,
  expandedNodeIds: ReadonlySet<string>,
  baseVisibleNodeIds: ReadonlySet<string>,
  visibleNodeIds: Set<string>,
) {
  if (!expandedNodeIds.has(endpoint)) return;
  const element = model.elementsByPath.get(endpoint);
  if (!element || element.type !== "dataStore") return;
  for (const collectionPath of dataStoreCollectionPaths(element)) {
    if (baseVisibleNodeIds.has(collectionPath)) {
      visibleNodeIds.add(collectionPath);
    }
  }
}

function addVisibleSubtree(
  model: NormalizedSoftwareModel,
  element: NormalizedSoftwareElement,
  expandedNodeIds: ReadonlySet<string>,
  visibleNodeIds: Set<string>,
  showRemovedNodes: boolean,
) {
  if (!showRemovedNodes && element.changeStatus === "removed") {
    return;
  }
  visibleNodeIds.add(element.path);
  if (!expandedNodeIds.has(element.path) || !isElementExpandable(element)) {
    return;
  }

  if (element.type === "dataStore") {
    for (const childPath of dataStoreCollectionPaths(element)) {
      visibleNodeIds.add(childPath);
    }
  }

  for (const childPath of element.children) {
    const child = model.elementsByPath.get(childPath);
    if (!child) continue;
    addVisibleSubtree(
      model,
      child,
      expandedNodeIds,
      visibleNodeIds,
      showRemovedNodes,
    );
  }
}

function projectNode(
  model: NormalizedSoftwareModel,
  element: NormalizedSoftwareElement,
  visibleNodeIds: ReadonlySet<string>,
  isExpanded: boolean,
  selectedNodeId: string | undefined,
  showRemovedNodes: boolean,
): ProjectedC4Node {
  return {
    id: element.path,
    path: element.path,
    type: element.type,
    label: element.label,
    description: element.description,
    changeStatus: element.changeStatus,
    external: element.external,
    dataStoreKind: element.dataStoreKind,
    parentPath: element.parentPath,
    children: [
      ...element.children.filter((child) => visibleNodeIds.has(child)),
      ...(isExpanded ? dataStoreCollectionPaths(element) : []),
    ],
    childCount: childCountForElement(model, element, showRemovedNodes),
    dataStoreSchemaSections: undefined,
    isExpanded,
    isExpandable: isElementExpandable(element),
    isSelected: element.path === selectedNodeId,
    element,
  };
}

function projectDataStoreCollectionNodes(
  element: NormalizedSoftwareElement,
  selectedNodeId: string | undefined,
): ProjectedC4Node[] {
  if (element.type !== "dataStore" || !element.dataStoreSchema) return [];
  return dataStoreSchemaSectionsForElement(element).map((section) => {
    const collectionPath = dataStoreCollectionPath(
      element.path,
      section.kind === "table" ? "tables" : "documents",
      collectionIdFromSection(section),
    );
    return {
      id: collectionPath,
      path: collectionPath,
      type: "dataStoreCollection",
      label: section.label,
      description: section.kind === "table" ? "Table" : "Document",
      parentPath: element.path,
      children: [],
      childCount: 0,
      dataStoreSchemaSections: [section],
      isExpanded: false,
      isExpandable: false,
      isSelected: collectionPath === selectedNodeId,
    };
  });
}

function childCountForElement(
  model: NormalizedSoftwareModel,
  element: NormalizedSoftwareElement,
  showRemovedNodes: boolean,
) {
  const visibleChildCount = element.children.filter((child) =>
    showRemovedNodes
      ? true
      : !pathHasRemovedAncestor(model, child, element.path),
  ).length;
  return visibleChildCount + dataStoreSchemaChildCount(element);
}

function dataStoreSchemaChildCount(element: NormalizedSoftwareElement) {
  if (element.type !== "dataStore" || !element.dataStoreSchema) return 0;
  return (
    Object.keys(element.dataStoreSchema.tables).length +
    Object.keys(element.dataStoreSchema.documents).length
  );
}

function dataStoreSchemaSectionsForElement(
  element: NormalizedSoftwareElement,
): ProjectedC4DataStoreSchemaSection[] {
  if (!element.dataStoreSchema) return [];
  const sections: ProjectedC4DataStoreSchemaSection[] = [];
  for (const collection of Object.values(element.dataStoreSchema.tables)) {
    sections.push(dataStoreSchemaSection("table", collection));
  }
  for (const collection of Object.values(element.dataStoreSchema.documents)) {
    sections.push(dataStoreSchemaSection("document", collection));
  }
  return sections;
}

function dataStoreSchemaSection(
  kind: "table" | "document",
  collection: NormalizedSoftwareDataStoreCollection,
): ProjectedC4DataStoreSchemaSection {
  return {
    id: `${kind}:${collection.id}`,
    kind,
    label: collection.label,
    key: collection.key,
    rows: flattenDataStoreSchemaRows(collection.schema).map((row) => ({
      id: `${collection.id}:${row.path.join(".")}`,
      label: row.label,
      depth: row.depth,
      type: row.type ?? "object",
      example: formatSchemaExample(row.example),
      primaryKey: row.pk,
      foreignKey: Boolean(row.fk),
    })),
  };
}

interface DataStoreSchemaRow {
  path: string[];
  label: string;
  depth: number;
  type?: string;
  pk?: boolean;
  fk?: SoftwareDataStoreForeignKeyRef;
  example?: DataStoreFieldExample;
}

function flattenDataStoreSchemaRows(
  schema: SoftwareDataStoreFieldSchema,
): DataStoreSchemaRow[] {
  const rows: DataStoreSchemaRow[] = [];
  const visit = (
    node: SoftwareDataStoreFieldSchema,
    prefix: string[],
    depth: number,
  ) => {
    for (const [field, value] of Object.entries(node)) {
      const nextPath = [...prefix, field];
      if (isDataStoreFieldLeaf(value)) {
        rows.push({
          path: nextPath,
          label: field,
          depth,
          type: value.type,
          pk: value.pk,
          fk: value.fk,
          example: exampleForDataStoreField(value),
        });
        if (value.schema) visit(value.schema, nextPath, depth + 1);
      } else {
        rows.push({
          path: nextPath,
          label: field,
          depth,
          example: exampleForDataStoreSchema(value),
        });
        visit(value, nextPath, depth + 1);
      }
    }
  };
  visit(schema, [], 0);
  return rows;
}

/** A schema entry is a leaf when its `type` names the field's type. */
export function isDataStoreFieldLeaf(
  value: SoftwareDataStoreFieldLeaf | SoftwareDataStoreFieldSchema,
): value is SoftwareDataStoreFieldLeaf {
  return "type" in value && isStringValue(value.type);
}

/**
 * The authored example of a field: the leaf's own example, or the examples of
 * its nested schema keyed by field.
 */
export type DataStoreFieldExample =
  | SoftwareDataStoreFieldLeaf["example"]
  | DataStoreSchemaExample;

export function exampleForDataStoreField(
  field: SoftwareDataStoreFieldLeaf,
): DataStoreFieldExample {
  if ("example" in field) return field.example;
  if (field.schema) return exampleForDataStoreSchema(field.schema);
  return undefined;
}

/** Example values keyed by field, nested like the schema they illustrate. */
interface DataStoreSchemaExample {
  [field: string]: DataStoreFieldExample;
}

export function exampleForDataStoreSchema(
  schema: SoftwareDataStoreFieldSchema,
): DataStoreSchemaExample {
  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => [
      key,
      isDataStoreFieldLeaf(value)
        ? exampleForDataStoreField(value)
        : exampleForDataStoreSchema(value),
    ]),
  );
}

const scalarExampleSchema = z.union([z.string(), z.number(), z.boolean()]);

export function formatSchemaExample(
  value: DataStoreFieldExample,
): string | undefined {
  if (value === undefined) return undefined;
  const scalar = scalarExampleSchema.safeParse(value);
  return scalar.success ? String(scalar.data) : JSON.stringify(value);
}

function dataStoreCollectionPaths(
  element: NormalizedSoftwareElement,
): string[] {
  if (element.type !== "dataStore" || !element.dataStoreSchema) return [];
  return [
    ...Object.keys(element.dataStoreSchema.tables).map((collectionId) =>
      dataStoreCollectionPath(element.path, "tables", collectionId),
    ),
    ...Object.keys(element.dataStoreSchema.documents).map((collectionId) =>
      dataStoreCollectionPath(element.path, "documents", collectionId),
    ),
  ];
}

function dataStoreCollectionPath(
  dataStorePath: string,
  collectionKind: "tables" | "documents",
  collectionId: string,
) {
  return `${dataStorePath}.${collectionKind}.${collectionId}`;
}

function collectionIdFromSection(
  section: ProjectedC4DataStoreSchemaSection,
): string {
  const separatorIndex = section.id.indexOf(":");
  return separatorIndex === -1
    ? section.id
    : section.id.slice(separatorIndex + 1);
}

function dataStoreCollectionPathForEndpoint(
  model: NormalizedSoftwareModel,
  endpoint: string,
): string | undefined {
  if (!looksLikeDataStoreSchemaEndpoint(endpoint)) return undefined;
  const schemaEndpoint = parseDataStoreSchemaEndpoint(
    endpoint,
    model.elementsByPath,
  );
  if (!schemaEndpoint) return undefined;
  return dataStoreCollectionPath(
    schemaEndpoint.dataStorePath,
    schemaEndpoint.collectionKind,
    schemaEndpoint.collectionId,
  );
}

function dataStorePathForSchemaEndpoint(
  model: NormalizedSoftwareModel,
  endpoint: string,
): string | undefined {
  if (!looksLikeDataStoreSchemaEndpoint(endpoint)) return undefined;
  return parseDataStoreSchemaEndpoint(endpoint, model.elementsByPath)
    ?.dataStorePath;
}

function projectRelationships(
  model: NormalizedSoftwareModel,
  visibleNodeIds: ReadonlySet<string>,
  showRemovedNodes: boolean,
) {
  const buckets = new Map<string, RelationshipBucket>();

  for (const relationship of model.relationships) {
    if (
      !showRemovedNodes &&
      (pathHasRemovedAncestor(model, relationship.from) ||
        pathHasRemovedAncestor(model, relationship.to))
    ) {
      continue;
    }
    const from = projectedEndpoint(model, relationship.from, visibleNodeIds);
    const to = projectedEndpoint(model, relationship.to, visibleNodeIds);
    if (!from || !to || from === to) continue;

    const bucketKey = relationshipBucketKey({
      model,
      from,
      to,
      kind: relationship.kind,
    });
    const bucket = buckets.get(bucketKey) ?? {
      kind: relationship.kind,
      from,
      to,
      sourceRelationshipIds: [],
      relationships: [],
    };

    bucket.sourceRelationshipIds.push(relationship.id);
    bucket.relationships.push(relationship);
    buckets.set(bucketKey, bucket);
  }

  return [...buckets.values()].map<ProjectedC4Relationship>((bucket) => ({
    id: projectedRelationshipId(bucket),
    kind: bucket.kind,
    from: bucket.from,
    to: bucket.to,
    label:
      bucket.relationships.length === 1
        ? bucket.relationships[0]?.label
        : undefined,
    semanticKind:
      bucket.kind === "semantic" && bucket.relationships.length === 1
        ? semanticRelationshipKind(bucket.relationships[0])
        : undefined,
    sourceRelationshipIds: bucket.sourceRelationshipIds,
    count: bucket.sourceRelationshipIds.length,
    relationships: bucket.relationships,
    ...projectedRelationshipSchemaEndpoints(model, bucket),
  }));
}

function projectedRelationshipSchemaEndpoints(
  model: NormalizedSoftwareModel,
  bucket: RelationshipBucket,
): Pick<
  ProjectedC4Relationship,
  | "fromSchemaFieldPath"
  | "toSchemaFieldPath"
  | "fromSchemaEndpointKind"
  | "toSchemaEndpointKind"
> {
  if (bucket.relationships.length !== 1) return {};
  const relationship = bucket.relationships[0];
  if (!relationship) return {};
  const fromEndpoint = looksLikeDataStoreSchemaEndpoint(relationship.from)
    ? parseDataStoreSchemaEndpoint(relationship.from, model.elementsByPath)
    : undefined;
  const toEndpoint = looksLikeDataStoreSchemaEndpoint(relationship.to)
    ? parseDataStoreSchemaEndpoint(relationship.to, model.elementsByPath)
    : undefined;
  return {
    ...(fromEndpoint &&
    bucket.from ===
      dataStoreCollectionPath(
        fromEndpoint.dataStorePath,
        fromEndpoint.collectionKind,
        fromEndpoint.collectionId,
      )
      ? {
          fromSchemaFieldPath: fromEndpoint.fieldPath,
          fromSchemaEndpointKind:
            fromEndpoint.fieldPath.length > 0 ? "field" : "header",
        }
      : {}),
    ...(toEndpoint &&
    bucket.to ===
      dataStoreCollectionPath(
        toEndpoint.dataStorePath,
        toEndpoint.collectionKind,
        toEndpoint.collectionId,
      )
      ? {
          toSchemaFieldPath: toEndpoint.fieldPath,
          toSchemaEndpointKind:
            toEndpoint.fieldPath.length > 0 ? "field" : "header",
        }
      : {}),
  };
}

function looksLikeDataStoreSchemaEndpoint(endpoint: string) {
  return endpoint.includes(".tables.") || endpoint.includes(".documents.");
}

function projectDataStoreForeignKeyRelationships(
  model: NormalizedSoftwareModel,
  visibleNodeIds: ReadonlySet<string>,
): ProjectedC4Relationship[] {
  const relationships: ProjectedC4Relationship[] = [];
  for (const element of model.elements) {
    if (element.type !== "dataStore" || !element.dataStoreSchema) continue;
    for (const collection of Object.values(element.dataStoreSchema.tables)) {
      const sourceCollectionPath = dataStoreCollectionPath(
        element.path,
        "tables",
        collection.id,
      );
      if (!visibleNodeIds.has(sourceCollectionPath)) continue;
      for (const row of flattenDataStoreSchemaRows(collection.schema)) {
        if (!row.fk) continue;
        const targetEndpoint = foreignKeyTargetEndpoint(element.path, row.fk);
        if (
          !targetEndpoint ||
          !parseDataStoreSchemaEndpoint(targetEndpoint, model.elementsByPath)
        ) {
          continue;
        }
        const targetCollectionPath = dataStoreCollectionPathForEndpoint(
          model,
          targetEndpoint,
        );
        if (
          !targetCollectionPath ||
          !visibleNodeIds.has(targetCollectionPath) ||
          targetCollectionPath === sourceCollectionPath
        ) {
          continue;
        }
        const sourceEndpoint = `${sourceCollectionPath}.${row.path.join(".")}`;
        relationships.push({
          id: `schema-fk:${sourceEndpoint}->${targetEndpoint}`,
          kind: "semantic",
          from: sourceCollectionPath,
          to: targetCollectionPath,
          semanticKind: "foreign key",
          sourceRelationshipIds: [
            `schema-fk:${sourceEndpoint}->${targetEndpoint}`,
          ],
          count: 1,
          relationships: [],
          hideLabel: true,
          fromSchemaFieldPath: row.path,
          fromSchemaEndpointKind: "field",
          toSchemaFieldPath: [],
          toSchemaEndpointKind: "header",
        });
      }
    }
  }
  return relationships;
}

function foreignKeyTargetEndpoint(
  dataStorePath: string,
  fk: SoftwareDataStoreForeignKeyRef,
): string | undefined {
  const target = foreignKeyTarget(fk);
  if (!target) return undefined;
  return `${dataStorePath}.tables.${target.table}.${target.fieldPath.join(".")}`;
}

/** The table and field a foreign key points at, or undefined when malformed. */
export function foreignKeyTarget(
  fk: SoftwareDataStoreForeignKeyRef,
): { table: string; fieldPath: string[] } | undefined {
  if (isForeignKeyShorthand(fk)) {
    const [table, ...fieldPath] = fk.split(".").filter(Boolean);
    return table && fieldPath.length > 0 ? { table, fieldPath } : undefined;
  }
  const fieldPath = fk.field.split(".").filter(Boolean);
  return fk.table && fieldPath.length > 0
    ? { table: fk.table, fieldPath }
    : undefined;
}

/** Foreign keys may be authored as a dotted `table.field` path. */
function isForeignKeyShorthand(
  fk: SoftwareDataStoreForeignKeyRef,
): fk is string {
  return isStringValue(fk);
}

function projectModifiedOnlyRelationships(
  baseRelationships: ProjectedC4Relationship[],
  visibleNodeIds: ReadonlySet<string>,
): ProjectedC4Relationship[] {
  const direct = baseRelationships.filter(
    (relationship) =>
      visibleNodeIds.has(relationship.from) &&
      visibleNodeIds.has(relationship.to),
  );
  const directKeys = new Set(
    direct.map(
      (relationship) => `${relationship.from}\u0000${relationship.to}`,
    ),
  );
  const implied = projectElidedRelationships(
    baseRelationships,
    visibleNodeIds,
  ).filter(
    (relationship) =>
      !directKeys.has(`${relationship.from}\u0000${relationship.to}`),
  );
  return [...direct, ...implied];
}

function projectElidedRelationships(
  baseRelationships: ProjectedC4Relationship[],
  visibleNodeIds: ReadonlySet<string>,
): ProjectedC4Relationship[] {
  const adjacency = new Map<string, ProjectedC4Relationship[]>();
  for (const relationship of baseRelationships) {
    const outgoing = adjacency.get(relationship.from) ?? [];
    outgoing.push(relationship);
    adjacency.set(relationship.from, outgoing);
  }

  const candidates = new Map<string, ImpliedRelationshipCandidate>();
  for (const sourceId of visibleNodeIds) {
    const queue: ImpliedTraversalState[] = [
      {
        currentId: sourceId,
        sourceRelationshipIds: [],
        crossedHiddenNode: false,
      },
    ];
    const visited = new Set<string>([sourceId]);

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const relationship of adjacency.get(current.currentId) ?? []) {
        const targetId = relationship.to;
        if (targetId === sourceId) continue;
        const sourceRelationshipIds = [
          ...current.sourceRelationshipIds,
          ...relationship.sourceRelationshipIds,
        ];
        if (visibleNodeIds.has(targetId)) {
          if (current.crossedHiddenNode) {
            rememberImpliedRelationship(candidates, {
              from: sourceId,
              to: targetId,
              sourceRelationshipIds,
            });
          }
          continue;
        }
        if (visited.has(targetId)) continue;
        visited.add(targetId);
        queue.push({
          currentId: targetId,
          sourceRelationshipIds,
          crossedHiddenNode: true,
        });
      }
    }
  }

  return [...candidates.values()].map((candidate) => ({
    id: `elided:${candidate.from}->${candidate.to}`,
    kind: "implied" as const,
    from: candidate.from,
    to: candidate.to,
    sourceRelationshipIds: candidate.sourceRelationshipIds,
    count: candidate.sourceRelationshipIds.length,
    relationships: [],
    hideLabel: true,
  }));
}

interface ImpliedTraversalState {
  currentId: string;
  sourceRelationshipIds: string[];
  crossedHiddenNode: boolean;
}

interface ImpliedRelationshipCandidate {
  from: string;
  to: string;
  sourceRelationshipIds: string[];
}

function rememberImpliedRelationship(
  candidates: Map<string, ImpliedRelationshipCandidate>,
  candidate: ImpliedRelationshipCandidate,
) {
  const key = `${candidate.from}\u0000${candidate.to}`;
  if (!candidates.has(key)) candidates.set(key, candidate);
}

function projectedEndpoint(
  model: NormalizedSoftwareModel,
  path: string,
  visibleNodeIds: ReadonlySet<string>,
) {
  const collectionPath = dataStoreCollectionPathForEndpoint(model, path);
  if (collectionPath && visibleNodeIds.has(collectionPath)) {
    return collectionPath;
  }
  const dataStorePath = dataStorePathForSchemaEndpoint(model, path);
  if (dataStorePath && visibleNodeIds.has(dataStorePath)) {
    return dataStorePath;
  }

  let current: string | undefined = path;
  while (current) {
    if (visibleNodeIds.has(current)) return current;
    current = model.elementsByPath.get(current)?.parentPath;
  }
  return undefined;
}

function isElementExpandable(element: NormalizedSoftwareElement) {
  return (
    element.type !== "codeElement" &&
    (element.children.length > 0 || dataStoreSchemaChildCount(element) > 0)
  );
}

function pathHasRemovedAncestor(
  model: NormalizedSoftwareModel,
  path: string,
  stopAtPath?: string,
) {
  let current: string | undefined =
    dataStorePathForSchemaEndpoint(model, path) ?? path;
  while (current) {
    if (current !== stopAtPath) {
      const element = model.elementsByPath.get(current);
      if (element?.changeStatus === "removed") return true;
    }
    current = model.elementsByPath.get(current)?.parentPath;
  }
  return false;
}

function isChangedElement(element: NormalizedSoftwareElement) {
  return (
    element.changeStatus === "added" ||
    element.changeStatus === "modified" ||
    element.changeStatus === "removed"
  );
}

function isDescendantPath(path: string, ancestorPath: string) {
  return path.startsWith(`${ancestorPath}.`);
}

function relationshipBucketKey({
  model,
  from,
  to,
  kind,
}: {
  model: NormalizedSoftwareModel;
  from: string;
  to: string;
  kind: NormalizedSoftwareRelationship["kind"] | "implied";
}) {
  return [
    from,
    to,
    c4RelationshipBucketSeparatesKind(model, from, to) ? kind : "",
  ].join("\u0000");
}

function c4RelationshipBucketSeparatesKind(
  model: NormalizedSoftwareModel,
  from: string,
  to: string,
) {
  return (
    model.elementsByPath.get(from)?.type === "codeElement" ||
    model.elementsByPath.get(to)?.type === "codeElement"
  );
}

function projectedRelationshipId(bucket: RelationshipBucket) {
  return `projected:${bucket.from}->${bucket.to}:${bucket.kind}`;
}

function semanticRelationshipKind(
  relationship: NormalizedSoftwareRelationship | undefined,
) {
  return relationship?.kind === "semantic"
    ? relationship.semanticKind
    : undefined;
}
