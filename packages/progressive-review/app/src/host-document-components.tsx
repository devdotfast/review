import type {
  HostDefinition,
  HostDocumentState,
  HostMapVersion,
  HostNode,
  HostSourceQuote,
} from "@dev.fast/review-protocol";
import { useEffect, useMemo, useState } from "react";

import type {
  ActorRef,
  CallStackEntry,
  PeekableAnchorRef,
} from "../../src/authoring";
import { diffCallStacks } from "../../src/call-stack-diff";
import { CallStackDiffView } from "./call-stack-diff";
import { SequenceDiagramView, type SequenceRef } from "./diagrams";
import type {
  SoftwareMapNodeSnapshot,
  SoftwareMapResolvedSnapshot,
} from "./software-map/software-map-snapshot";
import { SoftwareMapCanvas } from "./software-map/SoftwareMap";

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

function anchorFor(
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
      // Visual-only anchor identity; source display uses SourceQuote directly.
      // This handle is never passed to the legacy session/source resolver.
      resolution: null,
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
          ? anchorFor(document, message.evidence.anchorId)
          : {
              __kind: "db-anchor-ref" as const,
              id: message.id,
              title: message.label,
            },
      code:
        message.evidence.kind === "illustrative_code"
          ? { language: message.evidence.language, text: message.evidence.text }
          : undefined,
    };
  });
  return {
    __kind: "review-sequence-ref",
    id: node.id,
    label: node.title,
    participants: [...participants.values()],
    messages,
  };
}

function HostSequence({
  node,
  document,
  resources,
  onSourceOpen,
}: NodeProps<"sequence">) {
  const sequence = useMemo(
    () => hostSequence(node, document),
    [node, document],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = node.messages.find((message) => message.id === selectedId);
  return (
    <>
      <SequenceDiagramView
        sequence={sequence}
        theme={resources?.theme ?? "dark"}
        stopCount={node.messages.length}
        activeTourAnchor={selectedId}
        itemIdentity="message"
        openTour={(id) => {
          const message =
            node.messages.find((item) => item.id === id) ?? node.messages[0];
          if (!message) return;
          setSelectedId(message.id);
          if (message.evidence.kind === "anchor")
            onSourceOpen?.(message.evidence.anchorId);
        }}
      />
      {selected && (
        <EvidenceDetail evidence={selected.evidence} document={document} />
      )}
    </>
  );
}

function EvidenceDetail({
  evidence,
  document,
}: {
  evidence: Extract<
    HostNode,
    { type: "sequence" }
  >["messages"][number]["evidence"];
  document: HostDocumentState;
}) {
  if (evidence.kind === "illustrative_code")
    return (
      <pre className="host-document-graph-evidence">
        <code data-language={evidence.language}>{evidence.text}</code>
      </pre>
    );
  const quote = document.evidence[evidence.anchorId];
  if (!quote)
    throw new Error(
      `Stored source evidence is missing for ${evidence.anchorId}.`,
    );
  return <SourceDetail quote={quote} />;
}

function SourceDetail({ quote }: { quote: HostSourceQuote }) {
  return (
    <figure className="host-document-graph-evidence">
      <figcaption>
        {quote.span.file}:{quote.span.fromLine}–{quote.span.toLine}
      </figcaption>
      <pre>
        <code>{quote.text}</code>
      </pre>
    </figure>
  );
}

function HostCallStack({
  node,
  document,
  onSourceOpen,
}: NodeProps<"call_stack_diff">) {
  const frames = [...node.base, ...node.head];
  const sources = new Map<PeekableAnchorRef, string>();
  const adapt = (frame: (typeof frames)[number]): PeekableAnchorRef => {
    const anchor = anchorFor(document, frame.anchorId);
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
        if (anchorId) onSourceOpen?.(anchorId);
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
    anchorFor(document, operation.anchorId);
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

function HostDatabaseLens({
  node,
  document,
  resources,
  onSourceOpen,
  onError,
}: NodeProps<"database_lens">) {
  const [useCaseId, setUseCaseId] = useState(node.useCases[0]?.id);
  const [selectedOperation, setSelectedOperation] = useState<string | null>(
    null,
  );
  const active =
    node.useCases.find((item) => item.id === useCaseId) ?? node.useCases[0];
  const snapshot = useMemo(
    () => hostDatabaseSnapshot(node, document, active?.id),
    [node, document, active?.id],
  );
  const operation = active?.operations.find(
    (item) => item.id === selectedOperation,
  );
  return (
    <figure className="db-lens host-document-graph">
      <figcaption>
        <strong>{node.title}</strong>
        <select
          aria-label={`${node.title} use case`}
          value={active?.id ?? ""}
          onChange={(event) => {
            setUseCaseId(event.currentTarget.value);
            setSelectedOperation(null);
          }}
        >
          {node.useCases.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </figcaption>
      {active?.summary && <p>{active.summary}</p>}
      <SoftwareMapCanvas
        snapshot={snapshot}
        diagram={node.id}
        viewName={active?.label ?? node.title}
        expanded={false}
        interactionMode="inline"
        theme={resources?.theme ?? "dark"}
        wasmUrl={resources?.wasmUrl}
        onOpenRelationship={(id) => {
          setSelectedOperation(id);
          const selected = active?.operations.find((item) => item.id === id);
          if (selected) onSourceOpen?.(selected.anchorId);
        }}
        onError={onError}
      />
      {operation && (
        <EvidenceDetail
          evidence={{ kind: "anchor", anchorId: operation.anchorId }}
          document={document}
        />
      )}
    </figure>
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
  resources,
  onSourceRangeOpen,
  onError,
}: {
  node: Extract<HostNode, { type: "software_map" }>;
  map: HostMapVersion;
  resources?: HostDocumentResources;
  onSourceRangeOpen?: HostRichNodeProps["onSourceRangeOpen"];
  onError?: (error: Error) => void;
}) {
  const [selected, setSelected] = useState<string | null>(
    node.focusElementId ?? null,
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  useEffect(
    () => setSelected(node.focusElementId ?? null),
    [node.focusElementId],
  );
  const snapshot = useMemo(
    () => hostMapSnapshot(map, selected, collapsed),
    [map, selected, collapsed],
  );
  return (
    <figure className="software-map host-document-graph">
      <figcaption>
        <strong>Software map</strong>
        <small>{map.commit.slice(0, 12)}</small>
      </figcaption>
      <SoftwareMapCanvas
        snapshot={snapshot}
        viewName={map.id}
        diagram={node.id}
        expanded={false}
        interactionMode="inline"
        theme={resources?.theme ?? "dark"}
        wasmUrl={resources?.wasmUrl}
        viewportFocusNodeId={selected}
        onSelectNode={(item) => setSelected(item.id)}
        onError={onError}
        onCollapseNode={(item) =>
          setCollapsed((current) => new Set([...current, item.id]))
        }
        onExpandNode={(item) =>
          setCollapsed((current) => {
            const next = new Set(current);
            next.delete(item.id);
            return next;
          })
        }
      />
      {selected && map.elements[selected] && (
        <figcaption>
          {map.elements[selected].label}: {map.elements[selected].description}
          {onSourceRangeOpen &&
            map.elements[selected].source.map((source, index) => (
              <button
                key={index}
                type="button"
                className="host-document-source-link"
                onClick={() => onSourceRangeOpen(source)}
              >
                {source.file}:{source.fromLine}–{source.toLine}
              </button>
            ))}
        </figcaption>
      )}
    </figure>
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
    <figure
      className="trace-quote host-document-trace"
      data-trace-id={trace.id}
      data-event-id={event.id}
    >
      <figcaption>
        <strong>{trace.label}</strong>
        {event.role && <span>{event.role}</span>}
        <small>Provided trace excerpt</small>
      </figcaption>
      <blockquote>
        <pre>{node.text}</pre>
      </blockquote>
    </figure>
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
    <figure className="host-document-image">
      {url && <img src={url} alt={node.alt} onError={() => setFailed(true)} />}
      {node.caption && <figcaption>{node.caption}</figcaption>}
    </figure>
  );
}
