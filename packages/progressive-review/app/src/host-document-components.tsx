import type {
  HostDefinition,
  HostDiagramItem,
  HostDocumentState,
  HostFeedbackTarget,
  HostMapVersion,
  HostNode,
  HostSourceQuote,
  ThreadTarget,
} from "@dev.fast/review-protocol";
import { useEffect, useMemo, useState } from "react";

import {
  type ActorRef,
  type CallStackEntry,
  type PeekableAnchorRef,
  type StoreInputMap,
  createReviewDefinitionSession,
} from "../../src/authoring";
import { diffCallStacks } from "../../src/call-stack-diff";
import { CallStackDiffView } from "./call-stack-diff";
import { validatedCodePeekInputFromRef } from "./CodePeek";
import { type ParsedUseCase, ResolvedDatabaseLens } from "./database-lens";
import {
  ResolvedSequenceDiagram,
  type SequenceRef,
  sequenceTargetElements,
} from "./diagrams";
import { useReviewPanel } from "./review-panel";
import type {
  NormalizedSoftwareElement,
  NormalizedSoftwareModel,
} from "./software-map/model";
import {
  softwareMapNodeTargetPayload,
  softwareMapRelationshipTargetPayload,
} from "./software-map/software-map-paths";
import type {
  SoftwareMapNodeSnapshot,
  SoftwareMapResolvedSnapshot,
} from "./software-map/software-map-snapshot";
import { SoftwareMap } from "./software-map/SoftwareMap";
import { buildAnchorTextTarget, buildGraphTarget } from "./target-fingerprint";
import { TraceQuote } from "./trace-quote";

export interface HostImageResource {
  id: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  bytes: Uint8Array;
}

export interface HostTraceResource {
  id: string;
  provenance: "client_supplied";
  label: string;
  events: Readonly<Record<string, { id: string; text: string; role?: string }>>;
}

/** All artifact dependencies are loaded through ReviewClient by the owner. */
export interface HostDocumentResources {
  maps?: Readonly<Record<string, HostMapVersion>>;
  traces?: Readonly<Record<string, HostTraceResource>>;
  images?: Readonly<Record<string, HostImageResource>>;
  /** Resource reads in flight. These are loading states, not render failures. */
  pending?: ReadonlySet<string>;
  theme?: "dark" | "light";
  wasmUrl?: string;
}

export interface HostRichNodeProps {
  node: HostNode;
  document: HostDocumentState;
  resources?: HostDocumentResources;
  onSourceOpen?: (anchorId: string) => void;
  onSourceRangeOpen?: (source: HostSourceQuote["span"]) => void;
  onError?: (error: Error) => void;
}

export function HostRichNode(props: HostRichNodeProps) {
  const resource = hostNodeResource(props.node);
  if (
    resource &&
    props.resources?.pending?.has(`${resource.kind}:${resource.id}`)
  )
    return (
      <p role="status">
        Loading {resource.kind === "asset" ? "image" : resource.kind}…
      </p>
    );
  switch (props.node.type) {
    case "sequence":
      return <HostSequence {...props} node={props.node} />;
    case "call_stack_diff":
      return <HostCallStack {...props} node={props.node} />;
    case "database_lens":
      return <HostDatabaseLens {...props} node={props.node} />;
    case "software_map":
      return <HostSoftwareMap {...props} node={props.node} />;
    case "trace_quote":
      return <HostTraceQuote {...props} node={props.node} />;
    case "image":
      return <HostImage {...props} node={props.node} />;
    default:
      throw new Error(`Expected a rich node, received ${props.node.type}.`);
  }
}

export function hostNodeResource(
  node: HostNode,
): { kind: "map" | "trace" | "asset"; id: string } | null {
  switch (node.type) {
    case "software_map":
      return { kind: "map", id: node.mapVersionId };
    case "trace_quote":
      return { kind: "trace", id: node.traceId };
    case "image":
      return { kind: "asset", id: node.assetId };
    default:
      return null;
  }
}

type NodeProps<Type extends HostNode["type"]> = Omit<
  HostRichNodeProps,
  "node"
> & {
  node: Extract<HostNode, { type: Type }>;
};

export function projectHostGraphTarget(
  target: Extract<HostFeedbackTarget, { kind: "diagram" }>,
  document: HostDocumentState,
  resources?: HostDocumentResources,
): ThreadTarget | null {
  const node = document.nodes[target.nodeId];
  const selected = target.item;
  if (
    node?.type === "sequence" &&
    (selected.kind === "actor" || selected.kind === "message")
  ) {
    return (
      sequenceTargetElements(hostSequence(node, document)).find(
        (item) =>
          item.element.path[0] ===
            (selected.kind === "actor"
              ? selected.actorId
              : selected.messageId) &&
          item.element.type === (selected.kind === "actor" ? "node" : "edge"),
      ) ?? null
    );
  }
  if (
    node?.type === "database_lens" &&
    (selected.kind === "use_case" || selected.kind === "operation")
  ) {
    const useCase = node.useCases.find(
      (item) => item.id === selected.useCaseId,
    );
    if (useCase && selected.kind === "use_case")
      return buildGraphTarget({
        diagram: node.id,
        type: "node",
        path: [useCase.id],
        payload: {
          label: useCase.label,
          summary: useCase.summary,
          stores: [
            ...new Set(
              useCase.operations.map(
                (operation) =>
                  storeFor(document, operation.store.storeId).collections[
                    operation.store.collectionId
                  ]!.label,
              ),
            ),
          ],
        },
        quote: useCase.label,
      });
    const operation =
      selected.kind === "operation"
        ? useCase?.operations.find((item) => item.id === selected.operationId)
        : undefined;
    if (operation)
      return buildAnchorTextTarget({
        anchorId: operation.id,
        field: "title",
        text: hostAnchorRef(document, operation.anchorId).title,
      });
  }
  if (node?.type === "call_stack_diff" && selected.kind === "frame") {
    const frame = node[selected.side].find(
      (item) => item.id === selected.frameId,
    );
    if (frame)
      return buildAnchorTextTarget({
        anchorId: frame.id,
        field: "title",
        text: frame.label ?? hostAnchorRef(document, frame.anchorId).title,
      });
  }
  if (
    node?.type === "software_map" &&
    (selected.kind === "map_element" || selected.kind === "map_relationship")
  ) {
    const map = resources?.maps?.[node.mapVersionId];
    if (!map) return null;
    const snapshot = hostMapSnapshot(map, null);
    const element =
      selected.kind === "map_element"
        ? snapshot.nodes?.find((item) => item.id === selected.elementId)
        : undefined;
    if (element)
      return buildGraphTarget({
        diagram: node.id,
        type: "node",
        path: [element.id],
        payload: softwareMapNodeTargetPayload(element),
        quote: element.label,
      });
    const relationship =
      selected.kind === "map_relationship"
        ? snapshot.relationships?.find(
            (item) => item.id === selected.relationshipId,
          )
        : undefined;
    if (relationship)
      return buildGraphTarget({
        diagram: node.id,
        type: "edge",
        path: [relationship.id!],
        payload: softwareMapRelationshipTargetPayload(relationship),
        quote: relationship.label ?? relationship.id!,
      });
  }
  return null;
}

export function resolveHostGraphTarget(
  target: Extract<ThreadTarget, { kind: "graph" }>,
  document: HostDocumentState,
  resources?: HostDocumentResources,
): { nodeId: string; item: HostDiagramItem } | null {
  const node = document.nodes[target.diagram];
  const itemId = target.element.path[0];
  if (!node || !itemId) return null;
  let item: HostDiagramItem | undefined;
  if (node.type === "sequence")
    item =
      target.element.type === "node"
        ? { kind: "actor", actorId: itemId }
        : { kind: "message", messageId: itemId };
  else if (node.type === "software_map")
    item =
      target.element.type === "node"
        ? { kind: "map_element", elementId: itemId }
        : { kind: "map_relationship", relationshipId: itemId };
  else if (node.type === "database_lens") {
    if (
      target.element.type === "node" &&
      node.useCases.some((entry) => entry.id === itemId)
    )
      item = { kind: "use_case", useCaseId: itemId };
    else {
      const matches = node.useCases.flatMap((entry) =>
        entry.operations
          .filter((operation) =>
            target.element.path.length > 1
              ? entry.id === itemId && operation.id === target.element.path[1]
              : operation.id === itemId,
          )
          .map((operation) => ({
            kind: "operation" as const,
            useCaseId: entry.id,
            operationId: operation.id,
          })),
      );
      if (matches.length === 1) item = matches[0];
    }
  } else if (
    node.type === "call_stack_diff" &&
    (itemId === "base" || itemId === "head") &&
    target.element.path[1]
  ) {
    item = { kind: "frame", side: itemId, frameId: target.element.path[1] };
  }
  if (!item) return null;
  return projectHostGraphTarget(
    {
      kind: "diagram",
      nodeId: node.id,
      item,
      reviewVersion: document.reviewVersion,
    },
    document,
    resources,
  )
    ? { nodeId: node.id, item }
    : null;
}

export function hostAnchorRef(
  document: HostDocumentState,
  anchorId: string,
): PeekableAnchorRef {
  const definition = document.definitions[anchorId];
  const quote = document.evidence[anchorId];
  if (definition?.kind !== "anchor" || !quote)
    throw new Error(`Stored source evidence is missing for ${anchorId}.`);
  return {
    __kind: "db-anchor-ref",
    id: anchorId,
    title: definition.title,
    detail: definition.detail,
    peek: {
      __kind: "code-peek-ref",
      props: {
        file: quote.span.file,
        fromLine: quote.span.fromLine,
        toLine: quote.span.toLine,
        graph: definition.source.side,
      },
      resolution: {
        snapshot: {
          roots: [{ kind: "source", sourceId: anchorId }],
          resolved: {
            [anchorId]: {
              source: {
                id: anchorId,
                name: definition.title,
                kind: "source-range",
                file: quote.span.file,
                line: quote.span.fromLine,
                endLine: quote.span.toLine,
              },
              lines: quote.text
                .split(/\r?\n/)
                .map((text) => [{ t: text, k: "t" }]),
            },
          },
        },
      },
    },
  };
}

function actorFor(document: HostDocumentState, actorId: string): ActorRef {
  const definition = document.definitions[actorId];
  if (definition?.kind !== "actor")
    throw new Error(`Actor ${actorId} is missing.`);
  return { __kind: "db-actor-ref", id: actorId, label: definition.label };
}

export function hostSequence(
  node: Extract<HostNode, { type: "sequence" }>,
  document: HostDocumentState,
): SequenceRef {
  const participants = new Map<string, ActorRef>();
  const ids = new Set<string>();
  const messages = node.messages.map((message) => {
    if (ids.has(message.id))
      throw new Error(`Sequence message ${message.id} is duplicated.`);
    ids.add(message.id);
    const from = actorFor(document, message.fromActorId);
    const to = actorFor(document, message.toActorId);
    participants.set(from.id, from);
    participants.set(to.id, to);
    return {
      id: message.id,
      from,
      to,
      label: message.label,
      style: message.style,
      anchor:
        message.evidence.kind === "anchor"
          ? {
              ...hostAnchorRef(document, message.evidence.anchorId),
              id: message.id,
            }
          : {
              __kind: "db-anchor-ref" as const,
              id: message.id,
              title: message.label,
            },
      code:
        message.evidence.kind === "illustrative_code"
          ? { language: message.evidence.language, text: message.evidence.text }
          : undefined,
      explanation:
        message.evidence.kind === "explanation"
          ? message.evidence.text
          : undefined,
    };
  });
  return {
    __kind: "review-sequence-ref",
    stableItemIds: true,
    id: node.id,
    label: node.title,
    participants: [...participants.values()],
    messages,
  };
}

function HostSequence({ node, document }: NodeProps<"sequence">) {
  const sequence = useMemo(
    () => hostSequence(node, document),
    [node, document],
  );
  return <ResolvedSequenceDiagram sequence={sequence} />;
}

function HostCallStack({ node, document }: NodeProps<"call_stack_diff">) {
  const openPeek = useReviewPanel((state) => state.openPeek);
  const frames = [...node.base, ...node.head];
  const sources = new Map<PeekableAnchorRef, string>();
  const adapt = (frame: (typeof frames)[number]): PeekableAnchorRef => {
    const anchor = hostAnchorRef(document, frame.anchorId);
    const entry = {
      ...anchor,
      id: frame.id,
      title: frame.label ?? anchor.title,
    };
    sources.set(entry, frame.anchorId);
    return entry;
  };
  const entries = (side: typeof frames): CallStackEntry[] =>
    side.map((frame, index) =>
      frame.via && index > 0
        ? {
            __kind: "call-assertion",
            parent: adapt(side[index - 1]!),
            child: adapt(frame),
            reason: `${frame.via.kind}: ${frame.via.reason}`,
          }
        : adapt(frame),
    );
  const baseIds = new Set(node.base.map((frame) => frame.id));
  const headIds = new Set(node.head.map((frame) => frame.id));
  const rows = diffCallStacks(entries(node.base), entries(node.head))
    .filter(
      (row) =>
        !(
          row.change === "removed" &&
          headIds.has(
            row.entry.__kind === "call-assertion"
              ? row.entry.child.id
              : row.entry.id,
          )
        ),
    )
    .map((row) =>
      row.change === "added" &&
      baseIds.has(
        row.entry.__kind === "call-assertion"
          ? row.entry.child.id
          : row.entry.id,
      )
        ? { ...row, change: "unchanged" as const, moved: true }
        : row,
    );
  return (
    <CallStackDiffView
      title={node.title}
      rows={rows}
      onOpen={(entry) => {
        const anchorId = sources.get(entry);
        if (anchorId)
          openPeek({
            kind: "peek",
            anchor: entry,
            content: {
              kind: "resolved-code",
              input: validatedCodePeekInputFromRef(entry.peek),
            },
          });
      }}
    />
  );
}

function storeFor(
  document: HostDocumentState,
  id: string,
): Extract<HostDefinition, { kind: "store" }> {
  const definition = document.definitions[id];
  if (definition?.kind !== "store") throw new Error(`Store ${id} is missing.`);
  return definition;
}

function storeSnapshot(
  id: string,
  store: Extract<HostDefinition, { kind: "store" }>,
): SoftwareMapNodeSnapshot {
  return {
    id,
    label: store.label,
    type: "dataStore",
    dataStoreKind: "database",
    dataStoreSchemaSections: Object.entries(store.collections).map(
      ([collectionId, collection]) => ({
        id: collectionId,
        label: collection.label,
        kind: store.storage === "relational" ? "table" : "document",
        rows: Object.entries(collection.fields).map(([fieldId, field]) => ({
          id: fieldId,
          label: field.label,
          type: `${field.dataType}${field.nullable ? "?" : ""}`,
          primaryKey: field.primaryKey,
          foreignKey: Boolean(field.references),
        })),
      }),
    ),
  };
}

export function hostDatabaseSnapshot(
  node: Extract<HostNode, { type: "database_lens" }>,
  document: HostDocumentState,
  useCaseId?: string,
): SoftwareMapResolvedSnapshot {
  const useCase =
    node.useCases.find((item) => item.id === useCaseId) ?? node.useCases[0];
  const nodes = new Map<string, SoftwareMapNodeSnapshot>();
  for (const id of node.storeIds)
    nodes.set(id, storeSnapshot(id, storeFor(document, id)));
  const ids = new Set<string>();
  const relationships = (useCase?.operations ?? []).map((operation) => {
    if (ids.has(operation.id))
      throw new Error(`Database operation ${operation.id} is duplicated.`);
    ids.add(operation.id);
    hostAnchorRef(document, operation.anchorId);
    const actor = actorFor(document, operation.actorId);
    const store = storeFor(document, operation.store.storeId);
    const collection = store.collections[operation.store.collectionId];
    if (
      !collection ||
      (operation.store.fieldId && !collection.fields[operation.store.fieldId])
    )
      throw new Error(
        `Database operation ${operation.id} references an unavailable collection or field.`,
      );
    nodes.set(actor.id, {
      id: actor.id,
      label: actor.label,
      type: "component",
    });
    if (!nodes.has(operation.store.storeId))
      throw new Error(
        `Database operation ${operation.id} uses a store outside this lens.`,
      );
    return {
      id: operation.id,
      from: operation.kind === "read" ? operation.store.storeId : actor.id,
      to: operation.kind === "read" ? actor.id : operation.store.storeId,
      label: operation.label,
      kind: "semantic" as const,
      semanticKind: operation.kind,
      ...(operation.kind === "read"
        ? {
            fromSchemaFieldPath: [
              operation.store.collectionId,
              ...(operation.store.fieldId ? [operation.store.fieldId] : []),
            ],
          }
        : {
            toSchemaFieldPath: [
              operation.store.collectionId,
              ...(operation.store.fieldId ? [operation.store.fieldId] : []),
            ],
          }),
    };
  });
  return {
    title: node.title,
    view: useCase?.id,
    viewType: "inlineC4",
    nodes: [...nodes.values()],
    relationships,
  };
}

function HostDatabaseLens({ node, document }: NodeProps<"database_lens">) {
  const stores = useMemo(
    () =>
      createReviewDefinitionSession({
        softwareMap: null,
        baseSoftwareMap: null,
      }).defineStores(hostStoreInputs(document)),
    [document.definitions],
  );
  const useCases = useMemo<ParsedUseCase[]>(
    () =>
      node.useCases.map((useCase) => ({
        ...useCase,
        operations: useCase.operations.map((operation) => {
          const store = storeFor(document, operation.store.storeId);
          const collection = store.collections[operation.store.collectionId]!;
          const actor = actorFor(document, operation.actorId);
          const target = {
            __kind: "db-target-ref" as const,
            storeId: operation.store.storeId,
            storeKind: store.storage,
            storeLabel: store.label,
            collectionKind:
              store.storage === "relational"
                ? ("tables" as const)
                : ("documents" as const),
            collectionId: operation.store.collectionId,
            collectionLabel: collection.label,
            path: operation.store.fieldId ? [operation.store.fieldId] : [],
          };
          return {
            kind: operation.kind,
            from: operation.kind === "read" ? target : actor,
            to: operation.kind === "read" ? actor : target,
            label: operation.label,
            anchor: {
              ...hostAnchorRef(document, operation.anchorId),
              id: operation.id,
            },
          };
        }),
      })),
    [node, document],
  );
  return (
    <ResolvedDatabaseLens
      id={node.id}
      title={node.title}
      stores={stores}
      useCases={useCases}
    />
  );
}

function hostStoreInputs(document: HostDocumentState): StoreInputMap {
  return Object.fromEntries(
    Object.entries(document.definitions).flatMap(([id, definition]) =>
      definition.kind === "store"
        ? [
            [
              id,
              {
                kind: definition.storage,
                label: definition.label,
                [definition.storage === "relational" ? "tables" : "documents"]:
                  Object.fromEntries(
                    Object.entries(definition.collections).map(
                      ([collectionId, collection]) => [
                        collectionId,
                        {
                          label: collection.label,
                          schema: Object.fromEntries(
                            Object.entries(collection.fields).map(
                              ([fieldId, field]) => [
                                fieldId,
                                {
                                  type: `${field.dataType}${field.nullable ? "?" : ""}`,
                                  pk: field.primaryKey,
                                  fk: field.references
                                    ? [
                                        field.references.storeId,
                                        field.references.collectionId,
                                        field.references.fieldId,
                                      ].join(".")
                                    : undefined,
                                },
                              ],
                            ),
                          ),
                        },
                      ],
                    ),
                  ),
              },
            ],
          ]
        : [],
    ),
  );
}

const mapElementTypes = {
  person: "person",
  system: "softwareSystem",
  container: "container",
  component: "component",
  code: "codeElement",
  store: "dataStore",
} as const;

export function hostMapSnapshot(
  map: HostMapVersion,
  selectedNodeId: string | null,
  collapsed: ReadonlySet<string> = new Set(),
): SoftwareMapResolvedSnapshot {
  const children = new Set(
    Object.values(map.elements).flatMap((element) =>
      element.parentId ? [element.parentId] : [],
    ),
  );
  const visibleAncestor = (id: string): string => {
    let visible = id;
    let parent = map.elements[id]?.parentId;
    const visited = new Set([id]);
    while (parent) {
      if (visited.has(parent))
        throw new Error(`Software map ${map.id} has a parent cycle.`);
      visited.add(parent);
      if (collapsed.has(parent)) visible = parent;
      parent = map.elements[parent]?.parentId;
    }
    return visible;
  };
  return {
    view: map.id,
    viewType: "inlineC4",
    selectedNodeId: selectedNodeId ? visibleAncestor(selectedNodeId) : null,
    nodes: Object.values(map.elements)
      .filter((element) => visibleAncestor(element.id) === element.id)
      .map((element) => {
        const snapshot: SoftwareMapNodeSnapshot = {
          id: element.id,
          parentId: element.parentId,
          label: element.label,
          description: element.description,
          type: mapElementTypes[element.kind],
          path: element.id,
          file: element.source[0]?.file,
          line: element.source[0]?.fromLine,
          boundary: children.has(element.id) && !collapsed.has(element.id),
          expanded: children.has(element.id) && !collapsed.has(element.id),
          expandable: children.has(element.id),
          childCount: Object.values(map.elements).filter(
            (child) => child.parentId === element.id,
          ).length,
        };
        if (element.store) {
          Object.assign(
            snapshot,
            storeSnapshot(element.id, {
              kind: "store",
              label: element.label,
              ...element.store,
            }),
          );
        }
        return snapshot;
      }),
    relationships: Object.values(map.relationships).flatMap((relationship) => {
      const from = visibleAncestor(relationship.fromId);
      const to = visibleAncestor(relationship.toId);
      return from === to && relationship.fromId !== relationship.toId
        ? []
        : [
            {
              id: relationship.id,
              from,
              to,
              label: relationship.label,
              kind: relationship.kind,
            },
          ];
    }),
  };
}

function HostSoftwareMap({
  node,
  resources,
  onSourceRangeOpen,
  onError,
}: NodeProps<"software_map">) {
  const map = resources?.maps?.[node.mapVersionId];
  if (!map || map.id !== node.mapVersionId)
    throw new Error(`Stored software map ${node.mapVersionId} is unavailable.`);
  return (
    <HostSoftwareMapView
      key={map.id}
      node={node}
      map={map}
      resources={resources}
      onSourceRangeOpen={onSourceRangeOpen}
      onError={onError}
    />
  );
}

function HostSoftwareMapView({
  node,
  map,
}: {
  node: Extract<HostNode, { type: "software_map" }>;
  map: HostMapVersion;
  resources?: HostDocumentResources;
  onSourceRangeOpen?: HostRichNodeProps["onSourceRangeOpen"];
  onError?: (error: Error) => void;
}) {
  const model = useMemo(() => hostMapModel(map), [map]);
  return (
    <SoftwareMap
      model={model}
      targetId={node.id}
      title="Software map"
      view={node.id}
      focusRequest={
        node.focusElementId
          ? { requestId: 0, elementPath: node.focusElementId }
          : undefined
      }
    />
  );
}

/** Keeps the host's exact IDs/hierarchy when adapting to the existing map UI. */
export function hostMapModel(
  map: HostMapVersion,
  nodeId?: string,
): NormalizedSoftwareModel {
  const elements: NormalizedSoftwareElement[] = Object.values(map.elements).map(
    (element) => ({
      id: element.id,
      path: element.id,
      type: mapElementTypes[element.kind],
      label: element.label,
      description: element.description,
      parentPath: element.parentId ?? undefined,
      children: Object.values(map.elements)
        .filter((child) => child.parentId === element.id)
        .map((child) => child.id),
      sourceRanges: element.source.map((source) => ({
        file: source.file,
        fromLine: source.fromLine,
        toLine: source.toLine,
      })),
      coverage: {
        files: element.source.map((source) => ({
          path: source.file,
          ranges: [{ fromLine: source.fromLine, toLine: source.toLine }],
        })),
        globs: [],
      },
      dataStoreKind: element.store ? "database" : undefined,
      dataStoreSchema: element.store
        ? {
            tables:
              element.store.storage === "relational"
                ? hostMapCollections(element.store)
                : {},
            documents:
              element.store.storage === "document"
                ? hostMapCollections(element.store)
                : {},
          }
        : undefined,
    }),
  );
  return {
    targetId: nodeId ?? `map:${map.id}`,
    savedMap: { id: map.id, commit: map.commit },
    elements,
    elementsByPath: new Map(elements.map((element) => [element.path, element])),
    relationships: Object.values(map.relationships).map((relationship) => ({
      id: relationship.id,
      from: relationship.fromId,
      to: relationship.toId,
      label: relationship.label,
      ...(relationship.kind === "call"
        ? { kind: "call" as const, nthCallSite: 1 }
        : {
            kind: "semantic" as const,
            description: relationship.explanation,
          }),
    })),
  };
}

function hostMapCollections(
  store: NonNullable<HostMapVersion["elements"][string]["store"]>,
) {
  return Object.fromEntries(
    Object.entries(store.collections).map(([id, collection]) => [
      id,
      {
        id,
        label: collection.label,
        schema: Object.fromEntries(
          Object.entries(collection.fields).map(([fieldId, field]) => [
            fieldId,
            {
              type: `${field.dataType}${field.nullable ? "?" : ""}`,
              pk: field.primaryKey,
              fk: field.references
                ? [
                    field.references.storeId,
                    field.references.collectionId,
                    field.references.fieldId,
                  ].join(".")
                : undefined,
            },
          ]),
        ),
      },
    ]),
  );
}

function HostTraceQuote({ node, resources }: NodeProps<"trace_quote">) {
  const trace = resources?.traces?.[node.traceId];
  const event = trace?.events[node.eventId];
  const quote = node.text.trim().replace(/\s+/g, " ");
  if (
    !trace ||
    trace.id !== node.traceId ||
    !event ||
    event.id !== node.eventId ||
    !quote ||
    !event.text.trim().replace(/\s+/g, " ").includes(quote)
  )
    throw new Error(
      `Stored trace excerpt ${node.traceId}/${node.eventId} is unavailable or does not contain this quotation.`,
    );
  return (
    <TraceQuote
      sessionId={trace.id}
      trace={trace.id}
      event={Object.keys(trace.events).indexOf(event.id)}
    >
      {node.text}
    </TraceQuote>
  );
}

function HostImage({ node, resources }: NodeProps<"image">) {
  const asset = resources?.images?.[node.assetId];
  if (!asset || asset.id !== node.assetId)
    throw new Error(`Stored image ${node.assetId} is unavailable.`);
  return <RetainedImage key={asset.id} asset={asset} node={node} />;
}

function RetainedImage({
  asset,
  node,
}: {
  asset: HostImageResource;
  node: Extract<HostNode, { type: "image" }>;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (
      !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
        asset.mimeType,
      )
    )
      throw new Error(`Unsupported stored image format ${asset.mimeType}.`);
    const next = URL.createObjectURL(
      new Blob([new Uint8Array(asset.bytes).buffer], { type: asset.mimeType }),
    );
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [asset]);
  if (failed) throw new Error(`Stored image ${asset.id} could not be decoded.`);
  return (
    <figure className="review-image">
      {url && <img src={url} alt={node.alt} onError={() => setFailed(true)} />}
      {node.caption && <figcaption>{node.caption}</figcaption>}
    </figure>
  );
}
