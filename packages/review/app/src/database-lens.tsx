import { type JsonValue, isStringValue } from "@dev.fast/review-protocol";
import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import type { DatabaseLensBlockProps } from "../../src/database-lens-block";
import type {
  DatabaseField,
  DatabaseOperation,
  DatabaseStore,
} from "../../src/review-api/document";
import type { CodeEvidence as Source } from "../../src/source";
import { DiagramTourOverlay, useDiagramTourShell } from "./diagram-tour";
import { useReviewSession } from "./host/review-session";
import type { GuidedTour, PeekAnchor } from "./review-panel-model";
import { useTourPersist, useTourRestore } from "./review-view-state";
import { formatSchemaExample } from "./software-map/c4-projection";
import {
  type SoftwareMapDataStoreSchemaRowSnapshot,
  SoftwareMapFrame,
  type SoftwareMapNodeSnapshot,
  type SoftwareMapRelationshipSnapshot,
  type SoftwareMapResolvedSnapshot,
} from "./software-map/SoftwareMap";
import { captureUiEvent } from "./ui-telemetry";

type OperationKind = "read" | "write";

/** The canonical `database_lens` block as the document stores it. */
export type DatabaseLensProps = DatabaseLensBlockProps;

export type LensStores = Record<string, DatabaseStore>;

export type CollectionKind = "tables" | "documents";

export interface LensActor {
  id: string;
  label: string;
  softwareMapPath?: string;
}

/** One store collection (and optionally a field path inside it), resolved
 * from an operation's `store` / `collection` / `field` names. */
export interface LensTarget {
  storeId: string;
  storeKind: DatabaseStore["storage"];
  storeLabel: string;
  storeDataStoreKind?: DatabaseStore["dataStoreKind"];
  storeSoftwareMapPath?: string;
  collectionKind: CollectionKind;
  collectionId: string;
  collectionLabel: string;
  collectionKey?: string;
  path: string[];
}

export interface ParsedOperation {
  id: string;
  kind: OperationKind;
  actor: LensActor;
  target: LensTarget;
  label: string;
  detail?: string;
  source: Source;
}

export interface ParsedUseCase {
  id: string;
  label: string;
  summary?: string;
  operations: ParsedOperation[];
}

export type ResolvedOperation = ParsedOperation;

interface FieldRow {
  path: string[];
  label: string;
  depth: number;
  type?: string;
  pk?: boolean;
  fk?: DatabaseField["references"];
  example?: JsonValue;
}

export function collectionKindForStore(store: DatabaseStore): CollectionKind {
  return store.storage === "relational" ? "tables" : "documents";
}

/** Resolves an operation's names against the lens stores. The block was
 * validated at ingestion, so a missing name is a programming error. */
export function lensTarget(
  stores: LensStores,
  operation: Pick<DatabaseOperation, "store" | "collection" | "field">,
): LensTarget {
  const store = stores[operation.store];

  if (!store)
    throw new Error(`Database lens store "${operation.store}" is undefined.`);
  const collection = store.collections[operation.collection];

  if (!collection)
    throw new Error(
      `Database lens collection "${operation.store}.${operation.collection}" is undefined.`,
    );

  const target: LensTarget = {
    storeId: operation.store,
    storeKind: store.storage,
    storeLabel: store.label,
    collectionKind: collectionKindForStore(store),
    collectionId: operation.collection,
    collectionLabel: collection.label,
    path: operation.field ? operation.field.split(".") : [],
  };

  if (store.dataStoreKind) target.storeDataStoreKind = store.dataStoreKind;

  if (store.softwareMapPath)
    target.storeSoftwareMapPath = store.softwareMapPath;

  if (collection.key !== undefined) target.collectionKey = collection.key;

  return target;
}

export function lensActor(
  actors: DatabaseLensProps["actors"],
  name: string,
): LensActor {
  const definition = actors[name];

  if (definition === undefined) return { id: name, label: name };

  if (isStringValue(definition)) return { id: name, label: definition };
  const actor: LensActor = { id: name, label: definition.label };

  if (definition.softwareMapPath)
    actor.softwareMapPath = definition.softwareMapPath;

  return actor;
}

/** Pure view input: every use case with its operations resolved to actors
 * and store targets. */
export function lensUseCases(block: DatabaseLensProps): ParsedUseCase[] {
  return block.useCases.map((useCase, useCaseIndex) => {
    const parsed: ParsedUseCase = {
      id: useCase.id ?? `${block.id}-use-case-${useCaseIndex + 1}`,
      label: useCase.label,
      operations: useCase.operations.map((operation, index) => {
        const resolved: ParsedOperation = {
          id: operation.id ?? `${block.id}-operation-${index + 1}`,
          kind: operation.kind,
          actor: lensActor(block.actors, operation.actor),
          target: lensTarget(block.stores, operation),
          label: operation.label,
          source: operation.source,
        };

        if (operation.detail !== undefined) resolved.detail = operation.detail;

        return resolved;
      }),
    };

    if (useCase.summary !== undefined) parsed.summary = useCase.summary;

    return parsed;
  });
}

/** The side panel and guided tour key their state by anchor; an operation
 * is its own anchor. */
function panelAnchor(operation: ParsedOperation): PeekAnchor {
  const anchor: PeekAnchor = {
    id: operation.id,
    title: operation.label,
    peek: operation.source,
  };

  if (operation.detail !== undefined) anchor.detail = operation.detail;

  return anchor;
}

export type DatabaseOperationHighlightState = "active" | "inactive";

export interface DatabaseOperationHighlightInput {
  anchorId: string;
  targetKey: string;
}

export interface DatabaseOperationHighlights {
  activeAnchor: string | null;
  operationStates: Map<string, DatabaseOperationHighlightState>;
  activeTargetKeys: Set<string>;
}

export function selectDatabaseOperationHighlights(
  operations: DatabaseOperationHighlightInput[],
  requestedAnchor: string | null | undefined,
): DatabaseOperationHighlights {
  const activeAnchor =
    requestedAnchor &&
    operations.some((operation) => operation.anchorId === requestedAnchor)
      ? requestedAnchor
      : (operations[0]?.anchorId ?? null);

  const operationStates = new Map<string, DatabaseOperationHighlightState>();
  const activeTargetKeys = new Set<string>();

  for (const operation of operations) {
    if (operation.anchorId === activeAnchor) {
      operationStates.set(operation.anchorId, "active");
      activeTargetKeys.add(operation.targetKey);
    } else {
      operationStates.set(operation.anchorId, "inactive");
    }
  }

  return {
    activeAnchor,
    operationStates,
    activeTargetKeys,
  };
}

export function databaseTourStopDetail({
  useCaseLabel,
  operationLabel,
  anchorDetail,
}: {
  useCaseLabel: string;
  operationLabel: string;
  anchorDetail?: string;
}): string {
  return anchorDetail ?? `${useCaseLabel}: ${operationLabel}`;
}

export function DatabaseLens(block: DatabaseLensProps) {
  const { id: lensId, title, actors, stores, height = 560 } = block;

  // Memoize on the block's fields, not the props object: a live JSON snapshot
  // keeps its node references stable, so the tour entries and restored tour
  // state survive re-renders and edits elsewhere in the document.
  const useCases = useMemo(
    () =>
      lensUseCases({ id: lensId, actors, stores, useCases: block.useCases }),
    [lensId, actors, stores, block.useCases],
  );

  const session = useReviewSession();

  const [activeUseCaseId, setActiveUseCaseId] = useState<string | null>(
    () => useCases[0]?.id ?? null,
  );

  const activeUseCase =
    useCases.find((useCase) => useCase.id === activeUseCaseId) ??
    useCases[0] ??
    null;

  const tourEntries: GuidedTour[] = useMemo(
    () =>
      useCases.map((useCase) => ({
        id: tourIdFor(lensId, useCase.id),
        title: `${title ?? "Database lens"}: ${useCase.label}`,
        stops: useCase.operations.map((operation) => ({
          anchor: panelAnchor(operation),
          label: operation.label,
          detail: databaseTourStopDetail({
            useCaseLabel: useCase.label,
            operationLabel: operation.label,
            anchorDetail: operation.detail,
          }),
          content: {
            kind: "source" as const,
            source: operation.source,
          },
        })),
      })),
    [lensId, title, useCases],
  );

  const restoredTour = useTourRestore(tourEntries);

  // The tour IS the fullscreen mode, exactly as for sequence diagrams: the
  // lens card becomes the stage and GuidedTourPanel docks beside it.
  const [tourState, setTourState] = useState<{
    anchor: string;
    revealRequest: number;
  } | null>(null);

  const tourAnchor = tourState?.anchor ?? null;
  const tourOpen = tourState !== null;

  useEffect(() => {
    if (!restoredTour) return;

    const restoredUseCase = useCases.find(
      (useCase) => tourIdFor(lensId, useCase.id) === restoredTour.tour.id,
    );

    if (restoredUseCase) setActiveUseCaseId(restoredUseCase.id);
    setTourState({ anchor: restoredTour.activeAnchor, revealRequest: 0 });
  }, [lensId, restoredTour, useCases]);

  const tourForUseCase = (useCase: ParsedUseCase) =>
    tourEntries.find((tour) => tour.id === tourIdFor(lensId, useCase.id)) ??
    null;

  const openUseCase = (useCase: ParsedUseCase) => {
    setActiveUseCaseId(useCase.id);
    const firstAnchor = useCase.operations[0]?.id;
    // Inline, the select only switches the diagram; with the tour open it
    // stays fullscreen and steps onto the new use case's tour.
    setTourState((state) =>
      state && firstAnchor
        ? { anchor: firstAnchor, revealRequest: state.revealRequest + 1 }
        : state,
    );
  };

  const handleUseCaseChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const nextUseCase = useCases.find(
      (useCase) => useCase.id === event.currentTarget.value,
    );

    if (nextUseCase) openUseCase(nextUseCase);
  };

  const activeTour = activeUseCase ? tourForUseCase(activeUseCase) : null;
  const activeTourId = activeTour?.id ?? null;
  useTourPersist(tourOpen ? activeTour : null, tourAnchor);

  const openLensTour = useCallback(
    (anchor?: string) => {
      if (!activeTour) return;

      if (anchor) {
        captureUiEvent(session, "peek_opened", { via: "db_lens" });
      }

      const nextAnchor =
        anchor ?? tourAnchor ?? activeUseCase?.operations[0]?.id;

      if (!nextAnchor) return;

      if (!tourOpen) {
        captureUiEvent(session, "tour_started", {
          steps: activeUseCase?.operations.length ?? 0,
        });
      }

      setTourState((state) => ({
        anchor: nextAnchor,
        revealRequest: (state?.revealRequest ?? 0) + 1,
      }));
    },
    [activeTour, activeUseCase, session, tourAnchor, tourOpen],
  );

  const closeTour = useCallback(() => setTourState(null), []);

  const changeTourAnchor = useCallback(
    (anchor: string, options: { reveal: boolean }) => {
      setTourState((state) =>
        state
          ? {
              anchor,
              revealRequest: options.reveal
                ? state.revealRequest + 1
                : state.revealRequest,
            }
          : state,
      );
    },
    [],
  );

  const {
    overlayRef,
    portalTarget,
    paneResize: tourPaneResize,
  } = useDiagramTourShell(tourOpen, closeTour);

  const renderLensFigure = (stage: boolean) => (
    <figure
      className="database-lens"
      style={{ height: stage ? "100%" : height }}
    >
      <header className="diagram-header database-lens-header">
        <div className="diagram-header-main">
          <span className="diagram-kind-badge">DB</span>
          <span className="diagram-header-title">
            {title ?? "Database lens"}
          </span>
        </div>
        <div className="diagram-header-actions">
          {activeUseCase && (
            <div className="database-use-case-select-target">
              <select
                className="database-use-case-select"
                aria-label="Database use case"
                value={activeUseCase.id}
                onChange={handleUseCaseChange}
              >
                {useCases.map((useCase) => (
                  <option key={useCase.id} value={useCase.id}>
                    {databaseUseCaseOptionLabel(useCase)}
                  </option>
                ))}
              </select>
            </div>
          )}
          {!stage && activeTourId && (
            <button
              type="button"
              className="diagram-tour-button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                openLensTour();
              }}
            >
              Tour
            </button>
          )}
        </div>
      </header>
      <div className="database-lens-diagram">
        {activeUseCase ? (
          <DatabaseUseCaseDiagram
            useCase={activeUseCase}
            stores={stores}
            activeAnchor={stage ? tourAnchor : null}
            onOpenAnchor={(anchor) => openLensTour(anchor)}
          />
        ) : (
          <div className="database-empty">No database use-cases declared.</div>
        )}
      </div>
    </figure>
  );

  return (
    <>
      {renderLensFigure(false)}
      {tourOpen && activeTour && tourAnchor && portalTarget
        ? createPortal(
            <DiagramTourOverlay
              tour={activeTour}
              activeAnchor={tourAnchor}
              revealRequest={tourState?.revealRequest ?? 0}
              paneWidth={tourPaneResize.width}
              separatorProps={tourPaneResize.separatorProps}
              overlayRef={overlayRef}
              onActiveAnchorChange={changeTourAnchor}
              onClose={closeTour}
            >
              {renderLensFigure(true)}
            </DiagramTourOverlay>,
            portalTarget,
          )
        : null}
    </>
  );
}

function databaseUseCaseOptionLabel(useCase: ParsedUseCase) {
  const operations = useCase.operations;

  const writeCount = operations.filter(
    (operation) => operation.kind === "write",
  ).length;

  const readCount = operations.length - writeCount;

  return `${useCase.label} · ${writeCount}W/${readCount}R`;
}

function DatabaseUseCaseDiagram({
  useCase,
  stores,
  activeAnchor,
  onOpenAnchor,
}: {
  useCase: ParsedUseCase;
  stores: LensStores;
  activeAnchor: string | null;
  onOpenAnchor: (anchor: string) => void;
}) {
  const resolvedOperations = useCase.operations;

  const highlights = selectDatabaseOperationHighlights(
    resolvedOperations.map((resolved) => ({
      anchorId: resolved.id,
      targetKey: targetKey(resolved.target, resolved.target.path),
    })),
    activeAnchor,
  );

  return (
    <DatabaseC4UseCaseDiagram
      useCase={useCase}
      stores={stores}
      resolvedOperations={resolvedOperations}
      highlights={highlights}
      onOpenAnchor={onOpenAnchor}
    />
  );
}

function DatabaseC4UseCaseDiagram({
  useCase,
  stores,
  resolvedOperations,
  highlights,
  onOpenAnchor,
}: {
  useCase: ParsedUseCase;
  stores: LensStores;
  resolvedOperations: ResolvedOperation[];
  highlights: ReturnType<typeof selectDatabaseOperationHighlights>;
  onOpenAnchor: (anchor: string) => void;
}) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const defaultExpandedNodeIds = useMemo(
    () => initialDatabaseC4ExpandedNodeIds(resolvedOperations),
    [resolvedOperations],
  );

  const [expandedNodeIds, setExpandedNodeIds] = useState<Set<string>>(
    () => new Set(defaultExpandedNodeIds),
  );

  const seededDefaultNodeIdsRef = useRef<Set<string>>(
    new Set(defaultExpandedNodeIds),
  );

  const defaultExpandedNodeIdKey = useMemo(
    () => [...defaultExpandedNodeIds].sort().join("\0"),
    [defaultExpandedNodeIds],
  );

  const [viewportFocusNodeId, setViewportFocusNodeId] = useState<string | null>(
    null,
  );

  useEffect(() => {
    setExpandedNodeIds((current) => {
      const next = seedDatabaseC4DefaultExpandedNodeIds({
        expandedNodeIds: current,
        seededDefaultNodeIds: seededDefaultNodeIdsRef.current,
        defaultExpandedNodeIds,
      });

      seededDefaultNodeIdsRef.current = next.seededDefaultNodeIds;

      return sameNodeIdSet(current, next.expandedNodeIds)
        ? current
        : next.expandedNodeIds;
    });
  }, [defaultExpandedNodeIdKey, defaultExpandedNodeIds]);

  const snapshot = useMemo(
    () =>
      databaseC4Snapshot({
        useCase,
        stores,
        resolvedOperations,
        highlights,
        selectedNodeId,
        expandedNodeIds,
      }),
    [
      useCase,
      stores,
      resolvedOperations,
      highlights,
      selectedNodeId,
      expandedNodeIds,
    ],
  );

  const selectedNodeIdForFrame =
    selectedNodeId && snapshot.nodes?.some((node) => node.id === selectedNodeId)
      ? selectedNodeId
      : (snapshot.selectedNodeId ?? snapshot.nodes?.[0]?.id ?? null);

  const frameSnapshot = {
    ...snapshot,
    selectedNodeId: selectedNodeIdForFrame,
  };

  const openRelationship = (relationshipId: string) => {
    const operation = resolvedOperations.find(
      (resolved) => resolved.id === relationshipId,
    );

    if (!operation) return;
    onOpenAnchor(operation.id);
  };

  const handleSelectNode = (node: SoftwareMapNodeSnapshot) => {
    setSelectedNodeId(node.id);
    setViewportFocusNodeId(null);
  };

  const handleToggleNodeExpansion = (node: SoftwareMapNodeSnapshot) => {
    if (!node.expandable) return;
    setSelectedNodeId(node.id);
    setViewportFocusNodeId(node.expanded ? null : node.id);
    setExpandedNodeIds((current) => {
      const next = new Set(current);

      if (node.expanded) next.delete(node.id);
      else next.add(node.id);

      return next;
    });
  };

  const handleExpandNode = (node: SoftwareMapNodeSnapshot) => {
    if (!node.expandable) return;
    setSelectedNodeId(node.id);
    setViewportFocusNodeId(node.id);
    setExpandedNodeIds((current) => new Set(current).add(node.id));
  };

  const handleCollapseNode = (node: SoftwareMapNodeSnapshot) => {
    setSelectedNodeId(node.id);
    setViewportFocusNodeId(null);
    setExpandedNodeIds((current) => {
      const next = new Set(current);
      next.delete(node.id);

      return next;
    });
  };

  const relationshipStateById = highlights.operationStates;

  return (
    <div className="database-diagram-canvas database-diagram-canvas--c4">
      <SoftwareMapFrame
        snapshot={frameSnapshot}
        hasResolvedSnapshot
        title={useCase.label}
        height="100%"
        expanded={false}
        showChrome={false}
        showFloatingActions={false}
        interactionMode="inline"
        onSelectNode={handleSelectNode}
        onExpandNode={handleExpandNode}
        onCollapseNode={handleCollapseNode}
        onToggleNodeExpansion={handleToggleNodeExpansion}
        onFocusNode={(node) => setViewportFocusNodeId(node.id)}
        relationshipStateById={relationshipStateById}
        onOpenRelationship={openRelationship}
        viewportFocusNodeId={viewportFocusNodeId}
        onViewportFocusComplete={(nodeId) => {
          setViewportFocusNodeId((current) =>
            current === nodeId ? null : current,
          );
        }}
      />
    </div>
  );
}

export function initialDatabaseC4ExpandedNodeIds(
  resolvedOperations: readonly ResolvedOperation[],
): Set<string> {
  return new Set(
    resolvedOperations.map((resolved) => storeNodeId(resolved.target)),
  );
}

export interface DatabaseC4ExpandedNodeIds {
  expandedNodeIds: Set<string>;
  seededDefaultNodeIds: Set<string>;
}

export function seedDatabaseC4DefaultExpandedNodeIds({
  expandedNodeIds,
  seededDefaultNodeIds,
  defaultExpandedNodeIds,
}: {
  expandedNodeIds: ReadonlySet<string>;
  seededDefaultNodeIds: ReadonlySet<string>;
  defaultExpandedNodeIds: ReadonlySet<string>;
}): DatabaseC4ExpandedNodeIds {
  const nextExpandedNodeIds = new Set(expandedNodeIds);
  const nextSeededDefaultNodeIds = new Set(seededDefaultNodeIds);

  for (const nodeId of defaultExpandedNodeIds) {
    if (nextSeededDefaultNodeIds.has(nodeId)) continue;
    nextSeededDefaultNodeIds.add(nodeId);
    nextExpandedNodeIds.add(nodeId);
  }

  return {
    expandedNodeIds: nextExpandedNodeIds,
    seededDefaultNodeIds: nextSeededDefaultNodeIds,
  };
}

function sameNodeIdSet(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  if (left.size !== right.size) return false;

  for (const value of left) {
    if (!right.has(value)) return false;
  }

  return true;
}

export function databaseC4Snapshot({
  useCase,
  stores,
  resolvedOperations,
  highlights,
  selectedNodeId,
  expandedNodeIds,
}: {
  useCase: Pick<ParsedUseCase, "id" | "label">;
  stores: LensStores;
  resolvedOperations: readonly ResolvedOperation[];
  highlights: ReturnType<typeof selectDatabaseOperationHighlights>;
  selectedNodeId: string | null;
  expandedNodeIds: ReadonlySet<string>;
}): SoftwareMapResolvedSnapshot {
  const nodes = new Map<string, SoftwareMapNodeSnapshot>();
  const relationships: SoftwareMapResolvedSnapshot["relationships"] = [];
  const expandedStoresWithSchemaEdges = new Set<string>();

  for (const resolved of resolvedOperations) {
    const { target } = resolved;
    const actorId = actorNodeId(resolved.actor);
    const storeId = storeNodeId(target);
    const storeExpanded = expandedNodeIds.has(storeId);
    const operationStore = stores[target.storeId];

    const targetNodeId = storeExpanded
      ? storeCollectionNodeId(target)
      : storeId;

    nodes.set(actorId, softwareMapNodeForActor(resolved.actor));
    nodes.set(
      storeId,
      softwareMapNodeForStore({
        target,
        store: operationStore,
        expanded: storeExpanded,
      }),
    );

    if (storeExpanded && operationStore) {
      for (const node of softwareMapCollectionNodesForStore({
        storeId: target.storeId,
        store: operationStore,
        storeNodeId: storeId,
        highlights,
      })) {
        nodes.set(node.id, node);
      }

      if (!expandedStoresWithSchemaEdges.has(target.storeId)) {
        relationships.push(
          ...softwareMapForeignKeyRelationshipsForStore(
            target.storeId,
            operationStore,
            stores,
            expandedNodeIds,
          ),
        );
        expandedStoresWithSchemaEdges.add(target.storeId);
      }
    }

    const relationship: SoftwareMapRelationshipSnapshot = {
      id: resolved.id,
      from: resolved.kind === "write" ? actorId : targetNodeId,
      to: resolved.kind === "write" ? targetNodeId : actorId,
      kind: "semantic",
      semanticKind: resolved.kind,
      label: resolved.label,
    };

    if (storeExpanded && resolved.kind === "write") {
      relationship.toSchemaFieldPath = target.path;
      relationship.toSchemaEndpointKind = "field";
    }

    if (storeExpanded && resolved.kind === "read") {
      relationship.fromSchemaFieldPath = target.path;
      relationship.fromSchemaEndpointKind = "field";
    }

    relationships.push(relationship);
  }

  const activeTarget = resolvedOperations
    .map((resolved) => resolved.target)
    .find((target) =>
      highlights.activeTargetKeys.has(targetKey(target, target.path)),
    );

  return {
    title: useCase.label,
    view: `database:${useCase.id}`,
    viewType: "inlineC4",
    nodes: [...nodes.values()],
    // A referenced store joins the snapshot only through its own operations.
    relationships: relationships.filter(
      (relationship) =>
        relationship.semanticKind !== "foreign key" ||
        nodes.has(relationship.to),
    ),
    selectedNodeId:
      selectedNodeId ?? (activeTarget ? storeNodeId(activeTarget) : undefined),
  };
}

function softwareMapNodeForActor(actor: LensActor): SoftwareMapNodeSnapshot {
  return {
    id: actorNodeId(actor),
    type: "component",
    label: actor.label,
    path: actor.softwareMapPath,
  };
}

function softwareMapNodeForStore({
  target,
  store,
  expanded,
}: {
  target: LensTarget;
  store: DatabaseStore | undefined;
  expanded: boolean;
}): SoftwareMapNodeSnapshot {
  const childCount = Object.keys(store?.collections ?? {}).length;
  const id = storeNodeId(target);

  return {
    id,
    type: "dataStore",
    label: target.storeLabel,
    path: target.storeSoftwareMapPath,
    description: target.collectionLabel,
    dataStoreKind:
      target.storeDataStoreKind ??
      (target.storeKind === "relational" ? "database" : "artifactStore"),
    expanded,
    expandable: childCount > 0,
    childCount,
  };
}

function softwareMapCollectionNodesForStore({
  storeId,
  store,
  storeNodeId,
  highlights,
}: {
  storeId: string;
  store: DatabaseStore;
  storeNodeId: string;
  highlights: ReturnType<typeof selectDatabaseOperationHighlights>;
}): SoftwareMapNodeSnapshot[] {
  const collectionKind = collectionKindForStore(store);

  return Object.entries(store.collections).map(([collectionId, collection]) =>
    softwareMapCollectionNode({
      storeId,
      store,
      storeNodeId,
      collectionKind,
      collectionId,
      collection,
      highlights,
    }),
  );
}

function softwareMapCollectionNode({
  storeId,
  store,
  storeNodeId,
  collectionKind,
  collectionId,
  collection,
  highlights,
}: {
  storeId: string;
  store: DatabaseStore;
  storeNodeId: string;
  collectionKind: CollectionKind;
  collectionId: string;
  collection: DatabaseStore["collections"][string];
  highlights: ReturnType<typeof selectDatabaseOperationHighlights>;
}): SoftwareMapNodeSnapshot {
  const kind = collectionKind === "tables" ? "table" : "document";

  return {
    id: storeCollectionNodeIdForStore(
      storeId,
      store,
      collectionKind,
      collectionId,
    ),
    type: "dataStoreCollection",
    label: collection.label,
    path: store.softwareMapPath
      ? `${store.softwareMapPath}.${collectionKind}.${collectionId}`
      : undefined,
    description: kind === "table" ? "Table" : "Document",
    parentId: storeNodeId,
    dataStoreSchemaSections: [
      {
        id: `${kind}:${collectionId}`,
        kind,
        label: collection.label,
        key: collection.key,
        rows: softwareMapSchemaRowsForCollection({
          storeId,
          store,
          collectionKind,
          collectionId,
          collection,
          highlights,
        }),
      },
    ],
  };
}

function softwareMapForeignKeyRelationshipsForStore(
  storeId: string,
  store: DatabaseStore,
  stores: LensStores,
  expandedNodeIds: ReadonlySet<string>,
): NonNullable<SoftwareMapResolvedSnapshot["relationships"]> {
  const relationships: NonNullable<
    SoftwareMapResolvedSnapshot["relationships"]
  > = [];

  const collectionKind = collectionKindForStore(store);

  for (const [collectionId, collection] of Object.entries(store.collections)) {
    const sourceCollectionNodeId = storeCollectionNodeIdForStore(
      storeId,
      store,
      collectionKind,
      collectionId,
    );

    for (const row of flattenSchemaRows(collection.fields)) {
      if (!row.fk) continue;
      const targetStore = stores[row.fk.store];

      if (!targetStore) continue;
      const targetKind = collectionKindForStore(targetStore);

      if (!targetStore.collections[row.fk.collection]) continue;
      const fieldPath = row.fk.field.split(".").filter(Boolean);

      const targetCollectionNodeId = expandedNodeIds.has(
        `store:${row.fk.store}`,
      )
        ? storeCollectionNodeIdForStore(
            row.fk.store,
            targetStore,
            targetKind,
            row.fk.collection,
          )
        : `store:${row.fk.store}`;

      if (targetCollectionNodeId === sourceCollectionNodeId) continue;
      const id = `schema-fk:${sourceCollectionNodeId}.${row.path.join(".")}->${targetCollectionNodeId}.${fieldPath.join(".")}`;
      relationships.push({
        id,
        from: sourceCollectionNodeId,
        to: targetCollectionNodeId,
        kind: "semantic",
        semanticKind: "foreign key",
        hideLabel: true,
        fromSchemaFieldPath: row.path,
        fromSchemaEndpointKind: "field",
        toSchemaFieldPath: [],
        toSchemaEndpointKind: "header",
      });
    }
  }

  return relationships;
}

function softwareMapSchemaRowsForCollection({
  storeId,
  store,
  collectionKind,
  collectionId,
  collection,
  highlights,
}: {
  storeId: string;
  store: DatabaseStore;
  collectionKind: CollectionKind;
  collectionId: string;
  collection: DatabaseStore["collections"][string];
  highlights: ReturnType<typeof selectDatabaseOperationHighlights>;
}): SoftwareMapDataStoreSchemaRowSnapshot[] {
  return flattenSchemaRows(collection.fields).map((row) => {
    const rowTargetKey = targetKey(
      {
        storeId,
        storeKind: store.storage,
        storeLabel: store.label,
        collectionKind,
        collectionId,
        collectionLabel: collection.label,
        path: row.path,
      },
      row.path,
    );

    return {
      id: `${collectionId}:${row.path.join(".")}`,
      label: row.label,
      depth: row.depth,
      type: row.type ?? "object",
      example: formatSchemaExample(row.example),
      primaryKey: row.pk,
      foreignKey: Boolean(row.fk),
      state: highlights.activeTargetKeys.has(rowTargetKey)
        ? "active"
        : "inactive",
    };
  });
}

function storeNodeId(target: Pick<LensTarget, "storeId">): string {
  return `store:${target.storeId}`;
}

function storeCollectionNodeId(target: LensTarget): string {
  return target.storeSoftwareMapPath
    ? `${target.storeSoftwareMapPath}.${target.collectionKind}.${target.collectionId}`
    : `store:${target.storeId}.${target.collectionKind}.${target.collectionId}`;
}

function storeCollectionNodeIdForStore(
  storeId: string,
  store: DatabaseStore,
  collectionKind: CollectionKind,
  collectionId: string,
): string {
  return store.softwareMapPath
    ? `${store.softwareMapPath}.${collectionKind}.${collectionId}`
    : `store:${storeId}.${collectionKind}.${collectionId}`;
}

function actorNodeId(actor: LensActor): string {
  return `actor:${actor.id}`;
}

function collectionKey(target: LensTarget): string {
  return `${target.storeId}.${target.collectionKind}.${target.collectionId}`;
}

function targetKey(target: LensTarget, path = target.path): string {
  return `${collectionKey(target)}.${path.join(".")}`;
}

/** Nested document fields flatten to indented rows, exactly as the legacy
 * schema objects did. Nullability shows as the old `type?` suffix. */
function flattenSchemaRows(fields: Record<string, DatabaseField>): FieldRow[] {
  const rows: FieldRow[] = [];

  const visit = (
    node: Record<string, DatabaseField>,
    prefix: string[],
    depth: number,
  ) => {
    for (const [name, field] of Object.entries(node)) {
      const nextPath = [...prefix, name];

      const row: FieldRow = {
        path: nextPath,
        label: name,
        depth,
        type: field.nullable ? `${field.dataType}?` : field.dataType,
      };

      if (field.primaryKey) row.pk = true;

      if (field.references) row.fk = field.references;
      const example = fieldExample(field);

      if (example !== undefined) row.example = example;
      rows.push(row);

      if (field.fields) visit(field.fields, nextPath, depth + 1);
    }
  };

  visit(fields, [], 0);

  return rows;
}

/** A field's own example, else the examples of its nested fields keyed by
 * name, nested like the schema they illustrate. */
function fieldExample(field: DatabaseField): JsonValue | undefined {
  if (field.example !== undefined) return field.example;

  if (!field.fields) return undefined;
  const nested: Record<string, JsonValue> = {};

  for (const [name, child] of Object.entries(field.fields)) {
    const example = fieldExample(child);

    if (example !== undefined) nested[name] = example;
  }

  return nested;
}

function tourIdFor(lensId: string, useCaseId: string): string {
  return `${lensId}-${useCaseId}`;
}
