import {
  type ChangeEvent,
  Children,
  type MouseEvent,
  type ReactNode,
  isValidElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import {
  type ActorRef,
  type AnchorRef,
  type CollectionKind,
  type CollectionRef,
  type DatabaseLensProps,
  type DbOperationProps,
  type DbReadProps,
  type DbUseCaseProps,
  type DbWriteProps,
  type PeekableAnchorRef,
  type StoreRef,
  type TargetRef,
  collectionSchema,
  collectionTargetRef,
  databaseLensPropsSchema,
  dbReadPropsSchema,
  dbUseCasePropsSchema,
  dbWritePropsSchema,
  resolveTargetRef,
  throwAuthoringIssue,
} from "../../src/authoring";
import {
  type ValidatedCodePeekInput,
  validatedCodePeekInputFromRef,
} from "./CodePeek";
import { DiagramTourOverlay, useDiagramTourShell } from "./diagram-tour";
import { useReviewSession } from "./host/review-session";
import { HoverCommentButton } from "./hover-comment-button";
import { useReview } from "./review-context";
import type { GuidedTour } from "./review-panel-model";
import { useTourPersist, useTourRestore } from "./review-view-state";
import {
  type DataStoreFieldExample,
  exampleForDataStoreField,
  exampleForDataStoreSchema,
  foreignKeyTarget,
  formatSchemaExample,
  isDataStoreFieldLeaf,
} from "./software-map/c4-projection";
import type {
  SoftwareDataStoreFieldLeaf,
  SoftwareDataStoreFieldSchema,
  SoftwareDataStoreForeignKeyRef,
} from "./software-map/model";
import {
  type SoftwareMapDataStoreSchemaRowSnapshot,
  SoftwareMapFrame,
  type SoftwareMapNodeSnapshot,
  type SoftwareMapRelationshipSnapshot,
  type SoftwareMapResolvedSnapshot,
} from "./software-map/SoftwareMap";
import {
  buildGraphTarget,
  targetKey as threadTargetKey,
} from "./target-fingerprint";
import { useRegisterLiveDiagram } from "./thread-target-model";
import { captureUiEvent } from "./ui-telemetry";

type OperationKind = "read" | "write";

export type {
  ActorRef,
  AnchorRef,
  DatabaseLensProps,
  DbOperationProps,
  DbUseCaseProps,
  StoreRef,
  TargetRef,
};

export type FieldLeaf = SoftwareDataStoreFieldLeaf;
export type FieldSchema = SoftwareDataStoreFieldSchema;
export type ForeignKeyRef = SoftwareDataStoreForeignKeyRef;

interface ParsedUseCase {
  id: string;
  label: string;
  summary?: string;
  operations: ParsedOperation[];
}

interface ParsedOperation {
  kind: OperationKind;
  from: ActorRef | TargetRef;
  to: ActorRef | TargetRef;
  label: string;
  anchor: PeekableAnchorRef;
}

interface ResolvedOperation {
  operation: ParsedOperation;
  actor: ActorRef;
  target: TargetRef;
}

interface FieldRow {
  path: string[];
  label: string;
  depth: number;
  type?: string;
  pk?: boolean;
  fk?: ForeignKeyRef;
  example?: DataStoreFieldExample;
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

export function DbUseCase(props: DbUseCaseProps) {
  dbUseCasePropsSchema.parse(props);
  return null;
}

export function DbRead(props: DbReadProps) {
  dbReadPropsSchema.parse(props);
  return null;
}

export function DbWrite(props: DbWriteProps) {
  dbWritePropsSchema.parse(props);
  return null;
}

export function DatabaseLens(props: DatabaseLensProps) {
  const session = useReviewSession();
  const {
    title,
    stores,
    height = 560,
    children,
  } = databaseLensPropsSchema.parse(props);
  const review = useReview();
  const locatorScope = `db:${slugPart(title ?? "database")}`;
  const lensId = locatorScope;
  const validatedInput = useMemo(
    () =>
      validateDatabaseLensProps({
        title,
        stores,
        height,
        children,
      }),
    [children, height, stores, title],
  );
  const { peekInputs, useCases } = validatedInput;
  const diagramLabel = title ?? "Database lens";
  useRegisterLiveDiagram({
    label: diagramLabel,
    elements: useCases.map((useCase) =>
      buildGraphTarget({
        diagram: diagramLabel,
        type: "node",
        path: [useCase.label],
        payload: {
          label: useCase.label,
          summary: useCase.summary,
          stores: storesForUseCase(useCase),
        },
        quote: useCase.label,
      }),
    ),
  });
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
          anchor: operation.anchor,
          label: operation.label,
          detail: databaseTourStopDetail({
            useCaseLabel: useCase.label,
            operationLabel: operation.label,
            anchorDetail: operation.anchor.detail,
          }),
          content: {
            kind: "resolved-code" as const,
            input: peekInputs.get(operation.anchor.id)!,
          },
        })),
      })),
    [lensId, peekInputs, title, useCases],
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
    const firstAnchor = useCase.operations[0]?.anchor.id;
    // Inline, the select only switches the diagram; with the tour open it
    // stays fullscreen and steps onto the new use case's tour.
    setTourState((state) =>
      state && firstAnchor
        ? { anchor: firstAnchor, revealRequest: state.revealRequest + 1 }
        : state,
    );
  };
  const activeUseCaseTarget = activeUseCase
    ? buildGraphTarget({
        diagram: diagramLabel,
        type: "node",
        path: [activeUseCase.label],
        payload: {
          label: activeUseCase.label,
          summary: activeUseCase.summary,
          stores: storesForUseCase(activeUseCase),
        },
        quote: activeUseCase.label,
      })
    : null;
  const openActiveUseCaseComment = (event: MouseEvent<HTMLButtonElement>) => {
    if (!activeUseCase || !activeUseCaseTarget) return;
    event.preventDefault();
    event.stopPropagation();
    review.openCommentDraft({
      target: activeUseCaseTarget,
      title: activeUseCase.label,
      body: "",
    });
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
        anchor ?? tourAnchor ?? activeUseCase?.operations[0]?.anchor.id;
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
            <div
              className="database-use-case-select-target"
              data-review-locator={
                activeUseCaseTarget
                  ? threadTargetKey(activeUseCaseTarget)
                  : undefined
              }
              data-review-target-kind="db-access-pattern"
              data-review-target-label={activeUseCase.label}
            >
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
              <HoverCommentButton onClick={openActiveUseCaseComment} />
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
  stores: Record<string, StoreRef>;
  activeAnchor: string | null;
  onOpenAnchor: (anchor: string) => void;
}) {
  const resolvedOperations = useMemo(
    () => resolveOperations(useCase),
    [useCase],
  );
  const highlights = selectDatabaseOperationHighlights(
    resolvedOperations.map((resolved) => ({
      anchorId: resolved.operation.anchor.id,
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
  stores: Record<string, StoreRef>;
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
      (resolved) => resolved.operation.anchor.id === relationshipId,
    )?.operation;
    if (!operation) return;
    onOpenAnchor(operation.anchor.id);
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
        viewName={`database:${useCase.id}`}
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
    resolvedOperations.flatMap((resolved) => {
      const target = resolveTargetRef(resolved.target);
      return target ? [storeNodeId(target)] : [];
    }),
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
  useCase: ParsedUseCase;
  stores: Record<string, StoreRef>;
  resolvedOperations: ResolvedOperation[];
  highlights: ReturnType<typeof selectDatabaseOperationHighlights>;
  selectedNodeId: string | null;
  expandedNodeIds: ReadonlySet<string>;
}): SoftwareMapResolvedSnapshot {
  const nodes = new Map<string, SoftwareMapNodeSnapshot>();
  const relationships: SoftwareMapResolvedSnapshot["relationships"] = [];
  const expandedStoresWithSchemaEdges = new Set<string>();
  for (const resolved of resolvedOperations) {
    const target = resolveTargetRef(resolved.target);
    if (!target) continue;
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
        store: operationStore,
        storeNodeId: storeId,
        highlights,
      })) {
        nodes.set(node.id, node);
      }
      if (!expandedStoresWithSchemaEdges.has(operationStore.id)) {
        relationships.push(
          ...softwareMapForeignKeyRelationshipsForStore(operationStore),
        );
        expandedStoresWithSchemaEdges.add(operationStore.id);
      }
    }
    const relationship: SoftwareMapRelationshipSnapshot = {
      id: resolved.operation.anchor.id,
      from: resolved.operation.kind === "write" ? actorId : targetNodeId,
      to: resolved.operation.kind === "write" ? targetNodeId : actorId,
      kind: "semantic",
      semanticKind: resolved.operation.kind,
      label: resolved.operation.label,
    };
    if (storeExpanded && resolved.operation.kind === "write") {
      relationship.toSchemaFieldPath = target.path;
      relationship.toSchemaEndpointKind = "field";
    }
    if (storeExpanded && resolved.operation.kind === "read") {
      relationship.fromSchemaFieldPath = target.path;
      relationship.fromSchemaEndpointKind = "field";
    }
    relationships.push(relationship);
  }
  const activeTarget = resolvedOperations
    .map((resolved) => resolveTargetRef(resolved.target))
    .find((target): target is TargetRef => {
      if (!target) return false;
      return highlights.activeTargetKeys.has(targetKey(target, target.path));
    });
  return {
    title: useCase.label,
    view: `database:${useCase.id}`,
    viewType: "inlineC4",
    nodes: [...nodes.values()],
    relationships,
    selectedNodeId:
      selectedNodeId ?? (activeTarget ? storeNodeId(activeTarget) : undefined),
  };
}

function softwareMapNodeForActor(actor: ActorRef): SoftwareMapNodeSnapshot {
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
  target: TargetRef;
  store: StoreRef | undefined;
  expanded: boolean;
}): SoftwareMapNodeSnapshot {
  const childCount =
    Object.keys(store?.tables ?? {}).length +
    Object.keys(store?.documents ?? {}).length;
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
  store,
  storeNodeId,
  highlights,
}: {
  store: StoreRef;
  storeNodeId: string;
  highlights: ReturnType<typeof selectDatabaseOperationHighlights>;
}): SoftwareMapNodeSnapshot[] {
  return [
    ...Object.entries(store.tables ?? {}).map(([id, collection]) =>
      softwareMapCollectionNode({
        store,
        storeNodeId,
        collectionKind: "tables",
        collectionId: id,
        collection,
        highlights,
      }),
    ),
    ...Object.entries(store.documents ?? {}).map(([id, collection]) =>
      softwareMapCollectionNode({
        store,
        storeNodeId,
        collectionKind: "documents",
        collectionId: id,
        collection,
        highlights,
      }),
    ),
  ];
}

function softwareMapCollectionNode({
  store,
  storeNodeId,
  collectionKind,
  collectionId,
  collection,
  highlights,
}: {
  store: StoreRef;
  storeNodeId: string;
  collectionKind: CollectionKind;
  collectionId: string;
  collection: CollectionRef;
  highlights: ReturnType<typeof selectDatabaseOperationHighlights>;
}): SoftwareMapNodeSnapshot {
  const kind = collectionKind === "tables" ? "table" : "document";
  const collectionTarget = collectionTargetRef(collection);
  return {
    id: storeCollectionNodeIdForStore(store, collectionKind, collectionId),
    type: "dataStoreCollection",
    label: collectionTarget.collectionLabel,
    path: store.softwareMapPath
      ? `${store.softwareMapPath}.${collectionKind}.${collectionId}`
      : undefined,
    description: kind === "table" ? "Table" : "Document",
    parentId: storeNodeId,
    dataStoreSchemaSections: [
      {
        id: `${kind}:${collectionId}`,
        kind,
        label: collectionTarget.collectionLabel,
        key: collectionTarget.collectionKey,
        rows: softwareMapSchemaRowsForCollection({
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
  store: StoreRef,
): NonNullable<SoftwareMapResolvedSnapshot["relationships"]> {
  const relationships: NonNullable<
    SoftwareMapResolvedSnapshot["relationships"]
  > = [];
  for (const [collectionId, collection] of Object.entries(store.tables ?? {})) {
    const sourceCollectionNodeId = storeCollectionNodeIdForStore(
      store,
      "tables",
      collectionId,
    );
    for (const row of flattenSchemaRows(collectionSchema(collection))) {
      if (!row.fk) continue;
      const target = foreignKeyTarget(row.fk);
      if (!target || !store.tables?.[target.table]) continue;
      const targetCollectionNodeId = storeCollectionNodeIdForStore(
        store,
        "tables",
        target.table,
      );
      if (targetCollectionNodeId === sourceCollectionNodeId) continue;
      const id = `schema-fk:${sourceCollectionNodeId}.${row.path.join(".")}->${targetCollectionNodeId}.${target.fieldPath.join(".")}`;
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
  store,
  collectionKind,
  collectionId,
  collection,
  highlights,
}: {
  store: StoreRef;
  collectionKind: CollectionKind;
  collectionId: string;
  collection: CollectionRef;
  highlights: ReturnType<typeof selectDatabaseOperationHighlights>;
}): SoftwareMapDataStoreSchemaRowSnapshot[] {
  const collectionTarget = collectionTargetRef(collection);
  return flattenSchemaRows(collectionSchema(collection)).map((row) => {
    const rowTargetKey = targetKey(
      {
        __kind: "db-target-ref",
        storeId: store.id,
        storeKind: store.kind,
        storeLabel: store.label,
        storeDataStoreKind: store.dataStoreKind,
        storeSoftwareMapPath: store.softwareMapPath,
        collectionKind,
        collectionId,
        collectionLabel: collectionTarget.collectionLabel,
        collectionKey: collectionTarget.collectionKey,
        path: row.path,
      },
      row.path,
    );
    return {
      id: `${collectionId}:${row.path.join(".")}`,
      label: row.label,
      depth: row.depth,
      type: schemaValue(row),
      example: formatSchemaExample(row.example),
      primaryKey: row.pk,
      foreignKey: Boolean(row.fk),
      state: highlights.activeTargetKeys.has(rowTargetKey)
        ? "active"
        : "inactive",
    };
  });
}

function storeNodeId(target: TargetRef): string {
  return `store:${target.storeId}`;
}

function storeCollectionNodeId(target: TargetRef): string {
  return target.storeSoftwareMapPath
    ? `${target.storeSoftwareMapPath}.${target.collectionKind}.${target.collectionId}`
    : `store:${target.storeId}.${target.collectionKind}.${target.collectionId}`;
}

function storeCollectionNodeIdForStore(
  store: StoreRef,
  collectionKind: CollectionKind,
  collectionId: string,
): string {
  return store.softwareMapPath
    ? `${store.softwareMapPath}.${collectionKind}.${collectionId}`
    : `store:${store.id}.${collectionKind}.${collectionId}`;
}

function slugPart(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "database";
}

function validateDatabaseLensProps(props: DatabaseLensProps) {
  databaseLensPropsSchema.parse(props);
  const useCases = parseUseCases(props.children);
  if (useCases.length === 0) {
    throwAuthoringIssue(["children"], "Must contain at least one DbUseCase");
  }
  const labels = new Set<string>();
  for (const useCase of useCases) {
    if (labels.has(useCase.label)) {
      throwAuthoringIssue(
        ["children"],
        `DbUseCase label "${useCase.label}" must be unique within the lens`,
      );
    }
    labels.add(useCase.label);
  }
  const peekInputs = new Map<string, ValidatedCodePeekInput>();
  const validateAnchor = (anchor: PeekableAnchorRef) => {
    if (!peekInputs.has(anchor.id)) {
      peekInputs.set(anchor.id, validatedCodePeekInputFromRef(anchor.peek));
    }
  };
  for (const useCase of useCases) {
    for (const operation of useCase.operations) {
      validateAnchor(operation.anchor);
    }
  }
  return { peekInputs, useCases };
}

function parseUseCases(children: ReactNode): ParsedUseCase[] {
  const useCases: ParsedUseCase[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement(child) || child.type !== DbUseCase) return;
    const props = dbUseCasePropsSchema.parse(child.props);
    useCases.push({
      id: props.id,
      label: props.label,
      summary: props.summary,
      operations: parseOperations(props.children),
    });
  });
  return useCases;
}

function parseOperations(children: ReactNode): ParsedOperation[] {
  const operations: ParsedOperation[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    if (child.type !== DbRead && child.type !== DbWrite) return;
    const operationProps =
      child.type === DbRead
        ? dbReadPropsSchema.parse(child.props)
        : dbWritePropsSchema.parse(child.props);
    operations.push({
      kind: child.type === DbRead ? "read" : "write",
      from: operationProps.from,
      to: operationProps.to,
      label: operationProps.label,
      anchor: operationProps.anchor,
    });
  });
  return operations;
}

function resolveOperations(useCase: ParsedUseCase): ResolvedOperation[] {
  return useCase.operations.map((operation) => {
    const actor =
      operation.kind === "write"
        ? actorRef(operation.from)
        : actorRef(operation.to);
    const target =
      operation.kind === "write"
        ? targetRef(operation.to)
        : targetRef(operation.from);
    // The discriminated schemas make this unreachable; if a ref still slips
    // through, a loud error beats a silently blank diagram.
    if (!actor || !target) {
      throwAuthoringIssue(
        ["children"],
        `Db${operation.kind === "write" ? "Write" : "Read"} "${operation.label}" in DbUseCase "${useCase.label}" must ${
          operation.kind === "write"
            ? "flow from an actor to a store target"
            : "flow from a store target to an actor"
        }`,
      );
    }
    return { operation, actor, target };
  });
}

function actorNodeId(actor: ActorRef): string {
  return `actor:${actor.id}`;
}

function storesForUseCase(useCase: ParsedUseCase): string[] {
  const stores = new Set<string>();
  for (const operation of useCase.operations) {
    const target =
      operation.kind === "write"
        ? targetRef(operation.to)
        : targetRef(operation.from);
    if (target) stores.add(target.collectionLabel);
  }
  return [...stores];
}

function actorRef(value: ActorRef | TargetRef): ActorRef | null {
  return value.__kind === "db-actor-ref" ? value : null;
}

function targetRef(value: ActorRef | TargetRef): TargetRef | null {
  return resolveTargetRef(value);
}

function collectionKey(target: TargetRef): string {
  return `${target.storeId}.${target.collectionKind}.${target.collectionId}`;
}

function targetKey(target: TargetRef, path = target.path): string {
  return `${collectionKey(target)}.${path.join(".")}`;
}

function schemaValue(row: FieldRow): string {
  return row.type ?? "object";
}

function flattenSchemaRows(schema: FieldSchema): FieldRow[] {
  const rows: FieldRow[] = [];
  const visit = (node: FieldSchema, prefix: string[], depth: number) => {
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

function tourIdFor(lensId: string, useCaseId: string): string {
  return `${lensId}-${useCaseId}`;
}
