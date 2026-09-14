import {
  HOST_LIMITS,
  type HostDefinition,
  type HostDiagnostic,
  type HostDocument,
  type HostDocumentOperation,
  HostDocumentOperationSchema,
  HostDocumentSchema,
  type HostNode,
  HostNodePatchSchemas,
  HostNodeSchema,
  type HostPlacement,
} from "./host-document.js";
import type { JsonValue } from "./json.js";
import {
  isBooleanValue,
  isNumberValue,
  isObjectValue,
  isStringValue,
} from "./runtime-value.js";

export class HostDocumentValidationError extends Error {
  readonly code = "VALIDATION_FAILED";

  constructor(readonly diagnostics: HostDiagnostic[]) {
    super(diagnostics[0]?.message ?? "Invalid review document.");
    this.diagnostics = diagnostics.map((item) => ({
      ...item,
      path:
        item.path.startsWith("/input") || item.path.startsWith("/candidate")
          ? item.path
          : item.path.startsWith("/operations")
            ? `/input${item.path}`
            : `/candidate/document${item.path}`,
    }));
    this.name = "HostDocumentValidationError";
  }
}

function pointer(...parts: (string | number)[]): string {
  return `/${parts.map((part) => String(part).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}

function diagnostic(path: string, message: string): HostDiagnostic {
  return { severity: "error", code: "INVALID_DOCUMENT", path, message };
}

function fail(path: string, message: string): never {
  throw new HostDocumentValidationError([diagnostic(path, message)]);
}

/** Canonical JSON for identity and no-op comparison; preserves array order/text. */
export function canonicalHostJson(value: JsonValue): string {
  if (value === null || isBooleanValue(value) || isStringValue(value)) {
    return JSON.stringify(value);
  }
  if (isNumberValue(value) && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${Array.from(value, canonicalHostJson).join(",")}]`;
  }
  if (isObjectValue(value) && value !== null) {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical values must contain only JSON objects.");
    }
    return `{${Object.keys(value)
      .sort()
      .map((key) => {
        return `${JSON.stringify(key)}:${canonicalHostJson(value[key]!)}`;
      })
      .join(",")}}`;
  }
  throw new TypeError("Canonical values must contain only finite JSON data.");
}

function byteLength(value: JsonValue): number {
  return new TextEncoder().encode(canonicalHostJson(value)).length;
}

export function hostNodeChildren(node: HostNode): string[] | null {
  return node.type === "section" || node.type === "callout"
    ? node.children
    : null;
}

/** Whole-document checks; retained source/resource checks live in the host. */
export function validateHostDocument(value: JsonValue): HostDiagnostic[] {
  const parsed = HostDocumentSchema.safeParse(value);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) =>
      diagnostic(pointer(...issue.path.map(String)), issue.message),
    );
  }
  const document = parsed.data;
  const issues: HostDiagnostic[] = [];
  const add = (path: string, message: string) => {
    issues.push(diagnostic(path, message));
  };
  if (Object.keys(document.nodes).length > HOST_LIMITS.nodes) {
    add("/nodes", `Documents may contain at most ${HOST_LIMITS.nodes} nodes.`);
  }
  if (Object.keys(document.definitions).length > HOST_LIMITS.definitions) {
    add(
      "/definitions",
      `Documents may contain at most ${HOST_LIMITS.definitions} definitions.`,
    );
  }
  if (byteLength(document) > HOST_LIMITS.documentBytes) {
    add("", "Document exceeds the expanded JSON size limit.");
  }

  const parents = new Map<string, string>();
  const place = (ids: string[], owner: string) => {
    ids.forEach((id, index) => {
      const path = `${owner}/${index}`;
      if (!Object.hasOwn(document.nodes, id)) {
        add(path, `Node ${id} does not exist.`);
      } else if (parents.has(id)) {
        add(path, `Node ${id} is already placed at ${parents.get(id)}.`);
      } else {
        parents.set(id, path);
      }
    });
  };
  place(document.roots, "/roots");
  for (const [id, node] of Object.entries(document.nodes)) {
    if (node.id !== id)
      add(pointer("nodes", id, "id"), "Node ID must match its record key.");
    if (byteLength(node) > HOST_LIMITS.nodeBytes)
      add(pointer("nodes", id), "Node exceeds the JSON size limit.");
    const children = hostNodeChildren(node);
    if (children) place(children, pointer("nodes", id, "children"));
  }
  const visited = new Set<string>();
  const walk = (id: string, ancestors: Set<string>, depth: number) => {
    if (!Object.hasOwn(document.nodes, id)) return;
    if (ancestors.has(id)) {
      add(pointer("nodes", id), "Container parenting must not contain cycles.");
      return;
    }
    if (depth > HOST_LIMITS.depth) {
      add(
        pointer("nodes", id),
        `Container depth exceeds ${HOST_LIMITS.depth}.`,
      );
      return;
    }
    if (visited.has(id)) return;
    visited.add(id);
    const next = new Set(ancestors).add(id);
    for (const child of hostNodeChildren(document.nodes[id]!) ?? [])
      walk(child, next, depth + 1);
  };
  for (const id of document.roots) walk(id, new Set(), 1);
  for (const id of Object.keys(document.nodes)) {
    if (!visited.has(id))
      add(pointer("nodes", id), "Node is not reachable from document roots.");
  }

  const requireDefinition = (
    id: string,
    kind: HostDefinition["kind"],
    path: string,
  ) => {
    const found = Object.hasOwn(document.definitions, id)
      ? document.definitions[id]
      : undefined;
    if (found?.kind !== kind) add(path, `Expected ${kind} definition ${id}.`);
    return found;
  };
  const requireField = (
    storeId: string,
    collectionId: string,
    fieldId: string | undefined,
    path: string,
  ) => {
    const store = requireDefinition(storeId, "store", path);
    if (store?.kind !== "store") return;
    const collection = Object.hasOwn(store.collections, collectionId)
      ? store.collections[collectionId]
      : undefined;
    if (!collection)
      add(
        path,
        `Collection ${collectionId} does not exist in store ${storeId}.`,
      );
    else if (
      fieldId !== undefined &&
      !Object.hasOwn(collection.fields, fieldId)
    )
      add(
        path,
        `Field ${fieldId} does not exist in collection ${collectionId}.`,
      );
  };
  for (const [id, definition] of Object.entries(document.definitions)) {
    if (definition.kind !== "store") continue;
    for (const [collectionId, collection] of Object.entries(
      definition.collections,
    )) {
      for (const [fieldId, field] of Object.entries(collection.fields)) {
        if (field.references) {
          requireField(
            field.references.storeId,
            field.references.collectionId,
            field.references.fieldId,
            pointer(
              "definitions",
              id,
              "collections",
              collectionId,
              "fields",
              fieldId,
              "references",
            ),
          );
        }
      }
    }
  }

  const uniqueIds = (items: { id: string }[], path: string) => {
    const ids = new Set<string>();
    items.forEach((item, index) => {
      if (ids.has(item.id))
        add(`${path}/${index}/id`, `Duplicate item ID ${item.id}.`);
      ids.add(item.id);
    });
  };
  for (const [id, node] of Object.entries(document.nodes)) {
    const path = pointer("nodes", id);
    switch (node.type) {
      case "paragraph":
      case "heading":
        node.content.forEach((inline, index) => {
          if (inline.type === "anchor_link")
            requireDefinition(
              inline.anchorId,
              "anchor",
              `${path}/content/${index}/anchorId`,
            );
        });
        break;
      case "code_peek":
        requireDefinition(node.anchorId, "anchor", `${path}/anchorId`);
        break;
      case "sequence":
        uniqueIds(node.messages, `${path}/messages`);
        node.messages.forEach((message, index) => {
          const prefix = `${path}/messages/${index}`;
          requireDefinition(
            message.fromActorId,
            "actor",
            `${prefix}/fromActorId`,
          );
          requireDefinition(message.toActorId, "actor", `${prefix}/toActorId`);
          if (message.evidence.kind === "anchor")
            requireDefinition(
              message.evidence.anchorId,
              "anchor",
              `${prefix}/evidence/anchorId`,
            );
        });
        break;
      case "call_stack_diff":
        for (const side of ["base", "head"] as const) {
          uniqueIds(node[side], `${path}/${side}`);
          node[side].forEach((frame, index) => {
            if (index === 0 && frame.via)
              add(
                `${path}/${side}/${index}/via`,
                "The first frame has no incoming transition.",
              );
            const anchor = requireDefinition(
              frame.anchorId,
              "anchor",
              `${path}/${side}/${index}/anchorId`,
            );
            if (anchor?.kind === "anchor" && anchor.source.side !== side)
              add(
                `${path}/${side}/${index}/anchorId`,
                `${side} frames require ${side} source evidence.`,
              );
          });
        }
        break;
      case "database_lens": {
        const storeIds = new Set(node.storeIds);
        if (storeIds.size !== node.storeIds.length)
          add(
            `${path}/storeIds`,
            "A store must not be listed twice in one lens.",
          );
        node.storeIds.forEach((storeId, index) =>
          requireDefinition(storeId, "store", `${path}/storeIds/${index}`),
        );
        uniqueIds(node.useCases, `${path}/useCases`);
        const operations = node.useCases.flatMap(
          (useCase) => useCase.operations,
        );
        if (operations.length > HOST_LIMITS.diagramItems)
          add(`${path}/useCases`, "Database lens exceeds the operation limit.");
        node.useCases.forEach((useCase, caseIndex) => {
          const operationIds = new Set<string>();
          useCase.operations.forEach((operation, index) => {
            const prefix = `${path}/useCases/${caseIndex}/operations/${index}`;
            if (operationIds.has(operation.id))
              add(`${prefix}/id`, `Duplicate operation ID ${operation.id}.`);
            operationIds.add(operation.id);
            requireDefinition(operation.actorId, "actor", `${prefix}/actorId`);
            requireDefinition(
              operation.anchorId,
              "anchor",
              `${prefix}/anchorId`,
            );
            if (!storeIds.has(operation.store.storeId))
              add(
                `${prefix}/store/storeId`,
                "Operation store must be included in this lens.",
              );
            requireField(
              operation.store.storeId,
              operation.store.collectionId,
              operation.store.fieldId,
              `${prefix}/store`,
            );
          });
        });
        break;
      }
    }
  }
  return issues;
}

export function assertHostDocument(value: HostDocument): void {
  const issues = validateHostDocument(value);
  if (issues.length) throw new HostDocumentValidationError(issues);
}

function placementList(
  document: HostDocument,
  parentId: string | null,
  path: string,
): string[] {
  if (parentId === null) return document.roots;
  const parent = Object.hasOwn(document.nodes, parentId)
    ? document.nodes[parentId]
    : undefined;
  const list = parent ? hostNodeChildren(parent) : null;
  if (!list)
    fail(
      `${path}/parentId`,
      `Parent ${parentId} must be an existing container.`,
    );
  return list;
}

function detach(document: HostDocument, id: string): void {
  const lists = [
    document.roots,
    ...Object.values(document.nodes).flatMap((node) => {
      const children = hostNodeChildren(node);
      return children ? [children] : [];
    }),
  ];
  for (const list of lists) {
    const index = list.indexOf(id);
    if (index >= 0) list.splice(index, 1);
  }
}

function placeNode(
  document: HostDocument,
  id: string,
  placement: HostPlacement,
  path: string,
): void {
  if (
    id === placement.parentId ||
    (placement.position.kind === "after" && id === placement.position.nodeId)
  )
    fail(path, "A node cannot be placed relative to itself.");
  const descendants = [...(hostNodeChildren(document.nodes[id]!) ?? [])];
  const seen = new Set<string>();
  while (descendants.length) {
    const child = descendants.pop()!;
    if (child === placement.parentId)
      fail(
        `${path}/parentId`,
        "A node cannot be placed beneath its descendant.",
      );
    if (seen.has(child)) continue;
    seen.add(child);
    if (Object.hasOwn(document.nodes, child))
      descendants.push(...(hostNodeChildren(document.nodes[child]!) ?? []));
  }
  const list = placementList(document, placement.parentId, path);
  const position = placement.position;
  const previous =
    position.kind === "start"
      ? -1
      : position.kind === "end"
        ? list.length - 1
        : list.indexOf(position.nodeId);
  if (position.kind === "after" && previous < 0)
    fail(
      `${path}/position/nodeId`,
      "Previous sibling must belong to the selected parent.",
    );
  list.splice(previous + 1, 0, id);
}

/**
 * Build an isolated candidate, enforcing operation-specific rules only.
 * The host must validate the complete candidate before accepting it.
 */
export function applyHostDocumentOperations(
  current: HostDocument,
  input: readonly HostDocumentOperation[],
  retired: {
    nodeIds?: ReadonlySet<string>;
    definitionIds?: ReadonlySet<string>;
  } = {},
): HostDocument {
  if (!input.length || input.length > HOST_LIMITS.operations)
    fail(
      "/operations",
      `Between 1 and ${HOST_LIMITS.operations} operations are required.`,
    );
  const document = HostDocumentSchema.parse(current);
  const writes = new Map<string, Set<string>>();
  input.forEach((raw, index) => {
    const parsed = HostDocumentOperationSchema.safeParse(raw);
    if (!parsed.success)
      throw new HostDocumentValidationError(
        parsed.error.issues.map((issue) =>
          diagnostic(
            pointer("operations", index, ...issue.path.map(String)),
            issue.message,
          ),
        ),
      );
    const operation = parsed.data;
    const id =
      "node" in operation
        ? operation.node.id
        : "nodeId" in operation
          ? operation.nodeId
          : operation.id;
    const namespace = operation.op.startsWith("node.") ? "node" : "definition";
    const key = `${namespace}:${id}`;
    const priorWrites = writes.get(key) ?? new Set<string>();
    const isEdit = (op: string) =>
      op === "node.update" || op === "node.replace";
    const editAndMove =
      Object.hasOwn(current.nodes, id) &&
      priorWrites.size === 1 &&
      ((operation.op === "node.move" && [...priorWrites].some(isEdit)) ||
        (isEdit(operation.op) && priorWrites.has("node.move")));
    if (priorWrites.size && !editAndMove)
      fail(pointer("operations", index), `Conflicting operations for ${key}.`);
    priorWrites.add(operation.op);
    writes.set(key, priorWrites);
    const existing = Object.hasOwn(document.nodes, id)
      ? document.nodes[id]
      : undefined;
    switch (operation.op) {
      case "node.insert":
        if (existing || retired.nodeIds?.has(id))
          fail(
            pointer("operations", index, "node", "id"),
            `Node ID ${id} already exists or is retired.`,
          );
        document.nodes[id] = operation.node;
        placeNode(
          document,
          id,
          operation.placement,
          pointer("operations", index, "placement"),
        );
        break;
      case "node.replace": {
        if (!existing)
          fail(pointer("operations", index), `Node ${id} does not exist.`);
        const beforeChildren = hostNodeChildren(existing);
        const isContainer =
          operation.node.type === "section" ||
          operation.node.type === "callout";
        if ((beforeChildren !== null) !== isContainer) {
          fail(
            pointer("operations", index),
            "Replacing a node cannot change its child placement or container category.",
          );
        }
        document.nodes[id] = HostNodeSchema.parse(
          beforeChildren === null
            ? operation.node
            : { ...operation.node, children: beforeChildren },
        );
        break;
      }
      case "node.update": {
        if (!existing)
          fail(pointer("operations", index), `Node ${id} does not exist.`);
        const patch = HostNodePatchSchemas[existing.type]!.safeParse(
          operation.changes,
        );
        if (!patch.success)
          throw new HostDocumentValidationError(
            patch.error.issues.map((issue) =>
              diagnostic(
                pointer(
                  "operations",
                  index,
                  "changes",
                  ...issue.path.map(String),
                ),
                issue.message,
              ),
            ),
          );
        const candidate = Object.fromEntries(
          Object.entries({ ...existing, ...patch.data }).filter(
            ([, value]) => value !== null,
          ),
        );
        document.nodes[id] = HostNodeSchema.parse(candidate);
        break;
      }
      case "node.move":
        if (!existing)
          fail(pointer("operations", index), `Node ${id} does not exist.`);
        detach(document, id);
        placeNode(
          document,
          id,
          operation.placement,
          pointer("operations", index, "placement"),
        );
        break;
      case "node.remove": {
        if (!existing)
          fail(pointer("operations", index), `Node ${id} does not exist.`);
        if (
          !operation.recursive &&
          (hostNodeChildren(existing)?.length ?? 0) > 0
        )
          fail(
            pointer("operations", index),
            "Removing a nonempty container requires recursive: true.",
          );
        const removed = new Set<string>();
        const remove = (nodeId: string) => {
          if (removed.has(nodeId))
            fail(
              pointer("operations", index),
              "Cannot remove a cyclic or multiply placed subtree.",
            );
          removed.add(nodeId);
          if (nodeId !== id) {
            const childKey = `node:${nodeId}`;
            if (writes.has(childKey))
              fail(
                pointer("operations", index),
                `Recursive removal conflicts with another edit to ${nodeId}.`,
              );
            writes.set(childKey, new Set(["node.remove"]));
          }
          const node = document.nodes[nodeId]!;
          for (const child of hostNodeChildren(node) ?? []) remove(child);
          delete document.nodes[nodeId];
        };
        detach(document, id);
        remove(id);
        break;
      }
      case "definition.put":
        if (
          !Object.hasOwn(document.definitions, id) &&
          retired.definitionIds?.has(id)
        )
          fail(pointer("operations", index), `Definition ID ${id} is retired.`);
        document.definitions[id] = operation.value;
        break;
      case "definition.remove":
        if (!Object.hasOwn(document.definitions, id))
          fail(
            pointer("operations", index),
            `Definition ${id} does not exist.`,
          );
        delete document.definitions[id];
        break;
    }
  });
  return document;
}

/** All definitions whose values can influence this node, including store FKs. */
export function hostNodeDependencies(
  node: HostNode,
  definitions: HostDocument["definitions"],
): Set<string> {
  const ids = new Set<string>();
  switch (node.type) {
    case "paragraph":
    case "heading":
      for (const inline of node.content)
        if (inline.type === "anchor_link") ids.add(inline.anchorId);
      break;
    case "code_peek":
      ids.add(node.anchorId);
      break;
    case "sequence":
      for (const message of node.messages) {
        ids.add(message.fromActorId).add(message.toActorId);
        if (message.evidence.kind === "anchor")
          ids.add(message.evidence.anchorId);
      }
      break;
    case "call_stack_diff":
      for (const frame of [...node.base, ...node.head]) ids.add(frame.anchorId);
      break;
    case "database_lens":
      for (const id of node.storeIds) ids.add(id);
      for (const useCase of node.useCases)
        for (const operation of useCase.operations)
          ids
            .add(operation.anchorId)
            .add(operation.actorId)
            .add(operation.store.storeId);
      break;
  }
  // Set iteration also visits appended entries; FK cycles terminate by identity.
  for (const id of ids) {
    const definition = Object.hasOwn(definitions, id)
      ? definitions[id]
      : undefined;
    if (definition?.kind !== "store") continue;
    for (const collection of Object.values(definition.collections))
      for (const field of Object.values(collection.fields))
        if (field.references) ids.add(field.references.storeId);
  }
  return ids;
}

export function affectedHostNodeIds(
  before: HostDocument,
  after: HostDocument,
): string[] {
  const changedDefinitions = new Set(
    [
      ...Object.keys(before.definitions),
      ...Object.keys(after.definitions),
    ].filter(
      (id) =>
        canonicalHostJson(before.definitions[id] ?? null) !==
        canonicalHostJson(after.definitions[id] ?? null),
    ),
  );
  return Object.keys(after.nodes).filter((id) => {
    const node = after.nodes[id]!;
    return (
      canonicalHostJson(before.nodes[id] ?? null) !== canonicalHostJson(node) ||
      [...hostNodeDependencies(node, after.definitions)].some((dependency) =>
        changedDefinitions.has(dependency),
      )
    );
  });
}
