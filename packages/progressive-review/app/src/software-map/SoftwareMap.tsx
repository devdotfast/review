import { isJsonObject } from "@dev.fast/review-protocol";
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Edge as ReactFlowEdge,
  type EdgeProps as ReactFlowEdgeProps,
  type ReactFlowInstance,
  type NodeProps as ReactFlowNodeProps,
} from "@xyflow/react";
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { CodePeekGroup } from "../CodePeek";
import { useReviewDebugSettings } from "../debug-settings";
import { hasTextSelectionWithin } from "../diagram-text-selection";
import { type ReviewSession, useReviewSession } from "../host/review-session";
import { HoverCommentButton } from "../hover-comment-button";
import { CloseIcon, RefreshIcon } from "../icons";
import {
  type CommentDraftPlacement,
  useReviewActions,
} from "../review-context";
import { useReviewInitialData } from "../review-initial-data-context";
import { useRightPanelResize } from "../side-panel-resizer";
import { buildGraphTarget, targetKey } from "../target-fingerprint";
import { useRegisterLiveDiagram } from "../thread-target-model";
import { captureUiEvent } from "../ui-telemetry";
import {
  c4EdgeLabelPoint,
  c4EdgePointsFromSections,
} from "./c4-edge-label-geometry";
import {
  C4_FIT_VIEW_PADDING,
  C4_FLOW_MAX_ZOOM,
  C4_FLOW_MIN_ZOOM,
  type SoftwareMapDataStoreOutlineKind,
  c4DataStoreSchemaSignature,
  c4EdgeEndpointBubbles,
  c4LayoutSignature,
  c4PreviousInlineLayoutForRelationships,
  createC4MapFlowFromLayout,
  fitC4MapView,
  focusC4MapNodeAndKeyboard,
  revealC4MapNode,
  runInlineC4Layout,
  runSerializedC4Layout,
  softwareMapDataStoreOutlineKind,
} from "./c4-layout-geometry";
import type {
  C4ElkPoint,
  C4LayoutResult,
  C4MapAnyFlowNode,
  C4MapEdgeData,
  C4MapFlowGroupNode,
  C4MapFlowNode,
  C4MapInteractionMode,
  C4NodeDimensions,
  InlineC4LayoutResult,
} from "./c4-map-flow-types";
import { scheduleC4NodeMeasurements } from "./c4-node-measurement";
import { collapseInlineC4Node, projectInlineC4 } from "./c4-projection";
import { SoftwareMapHotkeysTab } from "./hotkeys-tab";
import type {
  NormalizedSoftwareModel,
  SoftwareChangeStatus,
  SoftwareDataStoreKind,
} from "./model";
import {
  SoftwareMapUnavailable,
  softwareMapCssLength,
} from "./software-map-absence";
import {
  C4_MAP_HOTKEY_GROUPS,
  type SoftwareMapViewportFocusRequest,
  c4MapReactFlowInteractionProps,
  c4SpatialDirectionForKey,
  c4SpatialPositions,
  findSpatialC4Node,
  focusSoftwareMapKeyboardTarget,
  isSoftwareMapEditableTarget,
  observeSoftwareMapVisibility,
  parentSoftwareMapNodeId,
  selectedSoftwareMapNodeIdForNodes,
  shouldAutoFocusC4MapKeyboardTarget,
  shouldShowSoftwareMapFloatingActions,
  softwareMapChildNodeIdForDrill,
  softwareMapEventTargetNodeId,
  softwareMapNodeForKeyboardExpansion,
  softwareMapNodeIdForDrill,
  softwareMapOverlayClassName,
  softwareMapViewportFocusNodeId,
  softwareMapViewportFocusTargetReady,
  toggledSoftwareMapExpandedNodeIds,
  toggledSoftwareMapViewportFocusRequest,
} from "./software-map-keyboard-navigation";
import {
  hasStoredSoftwareMapNavigationState,
  initialSoftwareMapExpandedNodeIds,
  rememberSoftwareMapNavigationState,
  restoreSoftwareMapNavigationState,
  seedSoftwareMapDefaultExpandedNodeIds,
  softwareMapAncestorPaths,
  softwareMapNavigationKey,
} from "./software-map-navigation-state";
import { refreshSoftwareMapArtifacts } from "./software-map-patch-client";
import {
  softwareMapLiveDiagram,
  softwareMapNodeTargetPayload,
  softwareMapRelationshipTargetPayload,
} from "./software-map-paths";
import {
  type SoftwareMapResolvedDataInput,
  shouldApplySoftwareMapModifiedOnly,
  softwareMapModelKey,
  softwareMapResolvedDataInputForModel,
  softwareMapResolvedDataInputHasWork,
  softwareMapResolvedDataInputKey,
} from "./software-map-resolved-data";
import {
  type SoftwareMapDataStoreSchemaSectionSnapshot,
  type SoftwareMapElementType,
  type SoftwareMapNodeDiffPeek,
  type SoftwareMapNodeSnapshot,
  type SoftwareMapRelationshipSnapshot,
  type SoftwareMapResolvedDataPayload,
  type SoftwareMapResolvedDataState,
  type SoftwareMapResolvedSnapshot,
  type SoftwareMapViewType,
  buildSoftwareMapChangeSummaries,
  c4DisplayedSnapshotForCurrentState,
  parseSoftwareMapResolvedDataResponse,
  softwareMapNodeDiffPeeks,
  softwareMapSnapshotFromInlineC4Projection,
  visibleSoftwareMapChangeCount,
} from "./software-map-snapshot";

export type {
  SoftwareMapDataStoreSchemaRowSnapshot,
  SoftwareMapNodeSnapshot,
  SoftwareMapRelationshipSnapshot,
  SoftwareMapResolvedSnapshot,
} from "./software-map-snapshot";

import "./styles.css";
import "@xyflow/react/dist/style.css";

const DEFAULT_CODE_INSPECTOR_WIDTH = 420;
const MIN_CODE_INSPECTOR_WIDTH = 340;
const MAX_CODE_INSPECTOR_WIDTH = 760;
const MIN_SOFTWARE_MAP_CANVAS_WIDTH = 420;

interface SoftwareMapProps {
  model?: NormalizedSoftwareModel;
  title?: string;
  view?: string;
  focusRequest?: { requestId: number; elementPath: string } | null;
  height?: number | string;
  snapshot?: SoftwareMapResolvedSnapshot | null;
  resolvedSnapshot?: SoftwareMapResolvedSnapshot | null;
  status?: string | null;
  error?: string | null;
  className?: string;
  placeholderLabel?: string;
  showChrome?: boolean;
  showFloatingActions?: boolean;
  registerTargets?: boolean;
}

interface SoftwareMapFrameProps {
  snapshot: SoftwareMapResolvedSnapshot;
  hasResolvedSnapshot: boolean;
  title: string;
  viewName: string;
  height?: number | string;
  status?: string | null;
  error?: string | null;
  refreshing?: boolean;
  expanded: boolean;
  showChrome: boolean;
  showFloatingActions: boolean;
  interactionMode: C4MapInteractionMode;
  onRefresh?: () => void;
  onExpand?: () => void;
  onClose?: () => void;
  inspectedNode?: SoftwareMapNodeSnapshot | null;
  inspectedNodeDiffPeeks?: readonly SoftwareMapNodeDiffPeek[];
  onCloseCodeInspector?: () => void;
  onSelectNode?: (node: SoftwareMapNodeSnapshot) => void;
  onExpandNode?: (node: SoftwareMapNodeSnapshot) => void;
  onCollapseNode?: (node: SoftwareMapNodeSnapshot) => void;
  onToggleNodeExpansion?: (node: SoftwareMapNodeSnapshot) => void;
  onFocusNode?: (node: SoftwareMapNodeSnapshot) => void;
  relationshipStateById?: ReadonlyMap<string, "active" | "inactive">;
  onOpenRelationship?: (relationshipId: string) => void;
  selectChildNodeIdForDrill?: (
    parentId: string,
    nodes: readonly Pick<SoftwareMapNodeSnapshot, "id" | "parentId">[],
  ) => string | null;
  viewportFocusNodeId?: string | null;
  viewportFocusRequiresExpanded?: boolean;
  onViewportFocusComplete?: (nodeId: string) => void;
}

interface C4DisplayedLayoutState {
  signature: string;
  snapshot: SoftwareMapResolvedSnapshot;
  layout: C4LayoutResult;
}

const ELEMENT_TYPE_LABELS: Record<SoftwareMapElementType, string> = {
  person: "Person",
  softwareSystem: "System",
  container: "Container",
  dataStore: "Data Store",
  dataStoreCollection: "Table",
  component: "Component",
  codeElement: "Code",
};

const DATA_STORE_KIND_LABELS: Record<SoftwareDataStoreKind, string> = {
  database: "Database",
  objectStore: "Object Store",
  bucket: "Bucket",
  artifactStore: "Artifact Store",
  fileStore: "File Store",
};

const VIEW_TYPE_LABELS: Record<SoftwareMapViewType, string> = {
  inlineC4: "Inline map",
};

function softwareMapNodeTypeLabel(
  node: Pick<
    SoftwareMapNodeSnapshot,
    "type" | "dataStoreKind" | "dataStoreSchemaSections"
  >,
) {
  if (node.type === "dataStore") {
    return DATA_STORE_KIND_LABELS[node.dataStoreKind ?? "database"];
  }
  if (node.type === "dataStoreCollection") {
    const sectionKind = node.dataStoreSchemaSections?.[0]?.kind;
    return sectionKind === "document" ? "Document" : "Table";
  }
  return ELEMENT_TYPE_LABELS[node.type];
}

const softwareMapC4NodeTypes = {
  softwareMapC4: SoftwareMapC4Node,
  softwareMapC4Group: SoftwareMapC4GroupNode,
};
const softwareMapC4EdgeTypes = {
  softwareMapC4Edge: SoftwareMapC4Edge,
};
const c4NodeTypes = softwareMapC4NodeTypes;
const c4EdgeTypes = softwareMapC4EdgeTypes;
const C4HoveredNodeContext = createContext<string | null>(null);
export function SoftwareMap(props: SoftwareMapProps) {
  if (!props.model && !props.snapshot && !props.resolvedSnapshot) {
    return (
      <SoftwareMapUnavailable
        title={props.title}
        height={props.height ?? 520}
        className={props.className}
      />
    );
  }
  return <SoftwareMapWithModel {...props} />;
}

function SoftwareMapWithModel({
  model,
  title,
  view,
  focusRequest,
  height = 520,
  snapshot,
  resolvedSnapshot,
  status,
  error,
  className,
  placeholderLabel = "Software map",
  showChrome = true,
  showFloatingActions = true,
  registerTargets = true,
}: SoftwareMapProps) {
  const session = useReviewSession();
  const debugSettings = useReviewDebugSettings();
  const { showModifiedOnly, showRemovedNodes } = debugSettings;
  const modelKey = useMemo(
    () =>
      softwareMapModelKey({
        model,
        view,
        showModifiedOnly,
        showRemovedNodes,
      }),
    [model, showModifiedOnly, showRemovedNodes, view],
  );
  const navigationKey = softwareMapNavigationKey({
    title,
    view,
    placeholderLabel,
  });
  const resolvedDataRequestPath = useMemo(
    () => session.apiUrl("/software-map/resolved-data"),
    [session],
  );
  const initialData = useReviewInitialData();
  const initialNavigation = restoreSoftwareMapNavigationState(
    session,
    navigationKey,
    modelKey,
  );
  const hasInitialNavigation = hasStoredSoftwareMapNavigationState(
    session,
    navigationKey,
    modelKey,
  );
  const initialExpandedNodeIds = hasInitialNavigation
    ? new Set(initialNavigation.expandedNodeIds)
    : initialSoftwareMapExpandedNodeIds(model);
  const [expanded, setExpanded] = useState(initialNavigation.expanded);
  const [expandedNodeIds, setExpandedNodeIds] = useState<Set<string>>(
    () => initialExpandedNodeIds,
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(
    initialNavigation.selectedNodeId,
  );
  const [inspectedNode, setInspectedNode] =
    useState<SoftwareMapNodeSnapshot | null>(null);
  useEffect(() => setInspectedNode(null), [modelKey, navigationKey]);
  const softwareMapResolvedDataInput = useMemo(
    () =>
      model
        ? softwareMapResolvedDataInputForModel(model, {
            expandedElementPaths: expandedNodeIds,
          })
        : null,
    [expandedNodeIds, model],
  );
  const resolvedDataKey = useMemo(
    () =>
      softwareMapResolvedDataInput
        ? softwareMapResolvedDataInputKey(softwareMapResolvedDataInput)
        : "",
    [softwareMapResolvedDataInput],
  );
  const [viewportFocusRequest, setViewportFocusRequest] =
    useState<SoftwareMapViewportFocusRequest | null>(null);
  // Resolved diff data is applied only once the map is visible after
  // hydration.
  const [resolvedDataState, setResolvedDataState] =
    useState<SoftwareMapResolvedDataState>({
      key: "",
      counts: new Map(),
      unmappedByElementPath: new Map(),
    });
  const [pendingResolvedDataKey, setPendingResolvedDataKey] = useState<
    string | null
  >(null);
  const [resolvedDataError, setResolvedDataError] = useState<string | null>(
    null,
  );
  const [artifactRefreshPending, setArtifactRefreshPending] = useState(false);
  const [refreshEpoch, setRefreshEpoch] = useState(0);
  const appliedResolvedDataKeyRef = useRef(resolvedDataState.key);
  const mapRootRef = useRef<HTMLElement | null>(null);
  const [resolveDataWhenVisible, setResolveDataWhenVisible] = useState(false);
  const previousBaseView = useRef(view);
  const defaultExpansionActiveRef = useRef(!hasInitialNavigation);
  const rememberedChildNodeIdsRef = useRef(new Map<string, string>());

  useEffect(() => {
    if (resolveDataWhenVisible) return;
    const mapRoot = mapRootRef.current;
    if (!mapRoot) return;
    return observeSoftwareMapVisibility(mapRoot, () =>
      setResolveDataWhenVisible(true),
    );
  }, [resolveDataWhenVisible]);

  useEffect(() => {
    if (previousBaseView.current === view) {
      return;
    }
    previousBaseView.current = view;
    setSelectedNodeId(null);
    setExpandedNodeIds(new Set());
  }, [view]);

  useEffect(() => {
    if (!focusRequest) return;
    const targetPath = focusRequest.elementPath;
    setExpandedNodeIds((current) => {
      const next = new Set(current);
      for (const ancestorPath of softwareMapAncestorPaths(targetPath)) {
        next.add(ancestorPath);
      }
      return next;
    });
    setSelectedNodeId(targetPath);
    setViewportFocusRequest({
      nodeId: targetPath,
      requireExpanded: false,
    });
  }, [focusRequest]);

  useEffect(() => {
    rememberSoftwareMapNavigationState(session, navigationKey, {
      modelKey,
      expandedNodeIds: [...expandedNodeIds],
      selectedNodeId,
      expanded,
    });
  }, [
    expanded,
    expandedNodeIds,
    modelKey,
    navigationKey,
    selectedNodeId,
    session,
  ]);

  const resolvedDataReady =
    Boolean(resolvedDataKey) && resolvedDataState.key === resolvedDataKey;

  useEffect(() => {
    const applyResolvedDataState = (state: SoftwareMapResolvedDataState) => {
      appliedResolvedDataKeyRef.current = state.key;
      setResolvedDataState(state);
      setResolvedDataError(null);
      setPendingResolvedDataKey(null);
    };

    if (!softwareMapResolvedDataInput || !resolvedDataKey) {
      applyResolvedDataState({
        key: "",
        counts: new Map(),
        unmappedByElementPath: new Map(),
      });
      return;
    }
    if (!softwareMapResolvedDataInputHasWork(softwareMapResolvedDataInput)) {
      applyResolvedDataState({
        key: resolvedDataKey,
        counts: new Map(),
        unmappedByElementPath: new Map(),
      });
      return;
    }
    if (!resolveDataWhenVisible) return;
    if (
      appliedResolvedDataKeyRef.current === resolvedDataKey &&
      refreshEpoch === 0
    ) {
      return;
    }
    const initialEntry = initialData?.softwareMapResolvedData.find(
      (entry) => entry.key === resolvedDataKey,
    );
    if (initialEntry && refreshEpoch === 0) {
      applyResolvedDataState({
        key: initialEntry.key,
        ...parseSoftwareMapResolvedDataResponse(
          isJsonObject(initialEntry.response) ? initialEntry.response : null,
        ),
      });
      return;
    }
    let cancelled = false;
    setResolvedDataError(null);
    setPendingResolvedDataKey(resolvedDataKey);
    void fetchSoftwareMapResolvedData(
      session,
      softwareMapResolvedDataInput,
      resolvedDataRequestPath,
    )
      .then((resolvedData) => {
        if (
          !cancelled &&
          appliedResolvedDataKeyRef.current !== resolvedDataKey
        ) {
          applyResolvedDataState({
            key: resolvedDataKey,
            ...resolvedData,
          });
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setPendingResolvedDataKey(null);
          setResolvedDataError(
            cause instanceof Error ? cause.message : String(cause),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    initialData,
    refreshEpoch,
    resolveDataWhenVisible,
    resolvedDataRequestPath,
    resolvedDataKey,
    session,
    softwareMapResolvedDataInput,
  ]);

  const projectionModel = useMemo(
    () => (model && resolvedDataReady ? model : null),
    [model, resolvedDataReady],
  );

  useEffect(() => {
    if (!projectionModel || !defaultExpansionActiveRef.current) return;
    setExpandedNodeIds((current) => {
      const next = seedSoftwareMapDefaultExpandedNodeIds({
        expandedNodeIds: current,
        model: projectionModel,
        defaultExpansionActive: defaultExpansionActiveRef.current,
      });
      if (
        next.size === current.size &&
        [...current].every((nodeId) => next.has(nodeId))
      ) {
        return current;
      }
      return next;
    });
  }, [projectionModel]);

  const changeSummaries = useMemo(
    () =>
      projectionModel
        ? buildSoftwareMapChangeSummaries(
            projectionModel,
            resolvedDataReady ? resolvedDataState.counts : new Map(),
            resolvedDataReady
              ? resolvedDataState.unmappedByElementPath
              : new Map(),
          )
        : new Map(),
    [projectionModel, resolvedDataReady, resolvedDataState],
  );
  const modifiedOnlyNodeIds = useMemo(
    () =>
      new Set(
        [...changeSummaries.entries()]
          .filter(([, summary]) => summary.changeStatus !== "unchanged")
          .map(([path]) => path),
      ),
    [changeSummaries],
  );
  const shouldApplyModifiedOnly = shouldApplySoftwareMapModifiedOnly({
    showModifiedOnly,
    resolvedDataReady,
    resolvedDataInput: softwareMapResolvedDataInput,
  });

  const modelSnapshotState = useMemo(() => {
    if (!projectionModel) {
      return {
        snapshot: null,
        error: null,
      };
    }
    try {
      return {
        snapshot: softwareMapSnapshotFromInlineC4Projection({
          projection: projectInlineC4({
            model: projectionModel,
            expandedNodeIds,
            selectedNodeId: selectedNodeId ?? undefined,
            modifiedOnly: shouldApplyModifiedOnly,
            showRemovedNodes,
            changedNodeIds: modifiedOnlyNodeIds,
          }),
          changeSummaries,
        }),
        error: null,
      };
    } catch (caught) {
      return {
        snapshot: null,
        error: caught instanceof Error ? caught.message : String(caught),
      };
    }
  }, [
    changeSummaries,
    expandedNodeIds,
    modifiedOnlyNodeIds,
    selectedNodeId,
    shouldApplyModifiedOnly,
    showRemovedNodes,
    projectionModel,
  ]);

  const resolvingModelData = Boolean(
    model && pendingResolvedDataKey === resolvedDataKey && !resolvedDataReady,
  );
  const refreshingModelData = artifactRefreshPending;
  const activeModelSnapshot = modelSnapshotState.snapshot;
  const providedSnapshot =
    snapshot ?? resolvedSnapshot ?? activeModelSnapshot ?? null;
  const hasResolvedSnapshot = Boolean(providedSnapshot);
  const mapSnapshot = useMemo(() => {
    const base =
      providedSnapshot ?? createPlaceholderSnapshot(placeholderLabel, view);
    const selectedForView = selectedSoftwareMapNodeIdForNodes({
      nodes: base.nodes ?? [],
      selectedNodeId,
    });
    return selectedForView
      ? { ...base, selectedNodeId: selectedForView }
      : base;
  }, [view, placeholderLabel, providedSnapshot, selectedNodeId]);
  const inspectedNodeDiffPeeks = useMemo(() => {
    if (!inspectedNode) return [];
    if (projectionModel && inspectedNode.path) {
      return softwareMapNodeDiffPeeks({
        model: projectionModel,
        elementPath: inspectedNode.path,
        changeSummaries,
      });
    }
    if (!inspectedNode.file || !inspectedNode.line) return [];
    const graph = inspectedNode.changeStatus === "removed" ? "base" : "head";
    return [
      {
        file: inspectedNode.file,
        fromLine: inspectedNode.line,
        toLine: inspectedNode.line,
        graph,
      } satisfies SoftwareMapNodeDiffPeek,
    ];
  }, [changeSummaries, inspectedNode, projectionModel]);
  const targetModelSnapshot = useMemo(() => {
    if (!projectionModel) return mapSnapshot;
    return softwareMapSnapshotFromInlineC4Projection({
      projection: projectInlineC4({
        model: projectionModel,
        expandedNodeIds: new Set(
          projectionModel.elements.map((element) => element.path),
        ),
        showRemovedNodes: true,
      }),
      changeSummaries,
    });
  }, [changeSummaries, mapSnapshot, projectionModel]);

  useEffect(() => {
    const nextSelectedNodeId = selectedSoftwareMapNodeIdForNodes({
      nodes: mapSnapshot.nodes ?? [],
      selectedNodeId,
    });
    if (nextSelectedNodeId !== selectedNodeId) {
      setSelectedNodeId(nextSelectedNodeId);
    }
  }, [mapSnapshot.nodes, selectedNodeId]);

  const frameTitle = title ?? mapSnapshot.title ?? placeholderLabel;
  const frameView = mapSnapshot.view ?? view ?? "inline-c4";
  const liveDiagram = useMemo(
    () => softwareMapLiveDiagram(frameTitle, frameView, targetModelSnapshot),
    [frameTitle, frameView, targetModelSnapshot],
  );
  useRegisterLiveDiagram(registerTargets ? liveDiagram : null);
  const statusMessage =
    status ??
    mapSnapshot.status ??
    modelSnapshotState.error ??
    resolvedDataError ??
    (refreshingModelData
      ? "Refreshing software map..."
      : resolvingModelData
        ? "Resolving software map..."
        : null);
  const errorMessage = error;
  const handleRefreshSoftwareMap = useCallback(() => {
    setArtifactRefreshPending(true);
    setResolvedDataError(null);
    void refreshSoftwareMapArtifacts(session)
      .then(() => {
        setRefreshEpoch((current) => current + 1);
      })
      .catch((cause: unknown) => {
        setResolvedDataError(
          cause instanceof Error ? cause.message : String(cause),
        );
      })
      .finally(() => {
        setArtifactRefreshPending(false);
      });
  }, [session]);
  const overlayClassName = softwareMapOverlayClassName({
    theme: debugSettings.theme,
    nodeTint: debugSettings.nodeTint,
  });
  const rememberChildNodeFocus = useCallback(
    (node: Pick<SoftwareMapNodeSnapshot, "id" | "parentId">) => {
      if (node.parentId) {
        rememberedChildNodeIdsRef.current.set(node.parentId, node.id);
      }
    },
    [],
  );
  const selectChildNodeIdForDrill = useCallback(
    (
      parentId: string,
      nodes: readonly Pick<SoftwareMapNodeSnapshot, "id" | "parentId">[],
    ) =>
      softwareMapChildNodeIdForDrill({
        nodes,
        parentId,
        rememberedChildNodeId:
          rememberedChildNodeIdsRef.current.get(parentId) ?? null,
      }),
    [],
  );
  const handleSelectNode = (node: SoftwareMapNodeSnapshot) => {
    rememberChildNodeFocus(node);
    setViewportFocusRequest(null);
    setSelectedNodeId(node.id);
    setInspectedNode(node);
  };
  const handleFocusNode = (node: SoftwareMapNodeSnapshot) => {
    setViewportFocusRequest({
      nodeId: node.id,
      requireExpanded: false,
    });
  };
  const handleExpandNode = (node: SoftwareMapNodeSnapshot) => {
    if (!node.path || !node.expandable) return;
    defaultExpansionActiveRef.current = false;
    setInspectedNode(node);
    if (!projectionModel) {
      setSelectedNodeId(node.id);
      return;
    }
    const nextExpandedNodeIds = new Set(expandedNodeIds);
    nextExpandedNodeIds.add(node.path);
    const nextProjection = projectInlineC4({
      model: projectionModel,
      expandedNodeIds: nextExpandedNodeIds,
      selectedNodeId: node.id,
      modifiedOnly: shouldApplyModifiedOnly,
      showRemovedNodes,
      changedNodeIds: modifiedOnlyNodeIds,
    });
    const nextNodes = nextProjection.nodes.map((element) => ({
      id: element.id,
      parentId: element.parentPath ?? null,
    }));
    const childNodeId =
      selectChildNodeIdForDrill(node.id, nextNodes) ?? node.id;
    if (childNodeId !== node.id) {
      rememberChildNodeFocus({
        id: childNodeId,
        parentId: node.id,
      });
    }
    setSelectedNodeId(childNodeId);
    setViewportFocusRequest({
      nodeId: node.id,
      requireExpanded: true,
    });
    setExpandedNodeIds(nextExpandedNodeIds);
  };
  const handleCollapseNode = (node: SoftwareMapNodeSnapshot) => {
    if (!node.path) return;
    defaultExpansionActiveRef.current = false;
    setViewportFocusRequest({
      nodeId: node.id,
      requireExpanded: false,
    });
    setSelectedNodeId(node.id);
    setExpandedNodeIds((current) => collapseInlineC4Node(current, node.path!));
  };
  const handleToggleNodeExpansion = (node: SoftwareMapNodeSnapshot) => {
    if (!node.path || !node.expandable) return;
    defaultExpansionActiveRef.current = false;
    setSelectedNodeId(node.id);
    setViewportFocusRequest(toggledSoftwareMapViewportFocusRequest(node));
    setExpandedNodeIds((current) =>
      toggledSoftwareMapExpandedNodeIds({
        expandedNodeIds: current,
        node,
      }),
    );
  };
  const handleCloseCodeInspector = () => setInspectedNode(null);

  useEffect(() => {
    if (!expanded) return;
    // Lock the canvas scroller (not document.body: the canvas composes into
    // the host DOM, so the element that actually scrolls the review is the
    // view region).
    const scroller = document.querySelector<HTMLElement>(
      ".review-view-region--review",
    );
    const originalOverflow = scroller?.style.overflow ?? "";
    if (scroller) scroller.style.overflow = "hidden";
    return () => {
      if (scroller) scroller.style.overflow = originalOverflow;
    };
  }, [expanded]);

  const frame = (
    <SoftwareMapFrame
      snapshot={mapSnapshot}
      hasResolvedSnapshot={hasResolvedSnapshot}
      title={frameTitle}
      viewName={frameView}
      height={height}
      status={statusMessage}
      error={errorMessage}
      refreshing={refreshingModelData}
      expanded={false}
      showChrome={showChrome}
      showFloatingActions={showFloatingActions}
      interactionMode={showChrome ? "inline" : "standalone"}
      onRefresh={handleRefreshSoftwareMap}
      onExpand={() => setExpanded(true)}
      onCloseCodeInspector={handleCloseCodeInspector}
      inspectedNode={inspectedNode}
      inspectedNodeDiffPeeks={inspectedNodeDiffPeeks}
      onSelectNode={handleSelectNode}
      onExpandNode={handleExpandNode}
      onCollapseNode={handleCollapseNode}
      onToggleNodeExpansion={handleToggleNodeExpansion}
      onFocusNode={handleFocusNode}
      selectChildNodeIdForDrill={selectChildNodeIdForDrill}
      viewportFocusNodeId={viewportFocusRequest?.nodeId ?? null}
      viewportFocusRequiresExpanded={viewportFocusRequest?.requireExpanded}
      onViewportFocusComplete={(nodeId) => {
        setViewportFocusRequest((current) =>
          current?.nodeId === nodeId ? null : current,
        );
      }}
    />
  );

  return (
    <section
      ref={mapRootRef}
      className={["software-map", className].filter(Boolean).join(" ")}
      aria-label={frameTitle}
    >
      {frame}
      {/* The desktop build wraps every canvas rule in
          @scope (.review-canvas-root), so the overlay must portal INSIDE the
          canvas root or it renders unstyled. */}
      {expanded && typeof document !== "undefined"
        ? createPortal(
            <div
              className={overlayClassName}
              role="dialog"
              aria-modal="true"
              aria-label={`${frameTitle} expanded`}
            >
              <SoftwareMapFrame
                snapshot={mapSnapshot}
                hasResolvedSnapshot={hasResolvedSnapshot}
                title={frameTitle}
                viewName={frameView}
                status={statusMessage}
                error={errorMessage}
                refreshing={refreshingModelData}
                expanded
                showChrome
                showFloatingActions={showFloatingActions}
                interactionMode="standalone"
                onRefresh={handleRefreshSoftwareMap}
                onClose={() => setExpanded(false)}
                onCloseCodeInspector={handleCloseCodeInspector}
                inspectedNode={inspectedNode}
                inspectedNodeDiffPeeks={inspectedNodeDiffPeeks}
                onSelectNode={handleSelectNode}
                onExpandNode={handleExpandNode}
                onCollapseNode={handleCollapseNode}
                onToggleNodeExpansion={handleToggleNodeExpansion}
                onFocusNode={handleFocusNode}
                selectChildNodeIdForDrill={selectChildNodeIdForDrill}
                viewportFocusNodeId={viewportFocusRequest?.nodeId ?? null}
                viewportFocusRequiresExpanded={
                  viewportFocusRequest?.requireExpanded
                }
                onViewportFocusComplete={(nodeId) => {
                  setViewportFocusRequest((current) =>
                    current?.nodeId === nodeId ? null : current,
                  );
                }}
              />
            </div>,
            document.body,
          )
        : null}
    </section>
  );
}

async function fetchSoftwareMapResolvedData(
  session: ReviewSession,
  input: SoftwareMapResolvedDataInput,
  requestPath: string,
): Promise<SoftwareMapResolvedDataPayload> {
  return fetchSoftwareMapResolvedDataUncached(session, input, requestPath);
}

async function fetchSoftwareMapResolvedDataUncached(
  session: ReviewSession,
  input: SoftwareMapResolvedDataInput,
  requestPath: string,
): Promise<SoftwareMapResolvedDataPayload> {
  const response = await session.fetchUrl(requestPath, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const json: unknown = await response.json();
  if (!response.ok || !isJsonObject(json)) {
    return parseSoftwareMapResolvedDataResponse(null);
  }
  return parseSoftwareMapResolvedDataResponse(json);
}

export function SoftwareMapFrame({
  snapshot,
  hasResolvedSnapshot,
  title,
  viewName,
  height,
  status,
  error,
  refreshing,
  expanded,
  showChrome,
  showFloatingActions,
  interactionMode,
  onRefresh,
  onExpand,
  onClose,
  inspectedNode,
  inspectedNodeDiffPeeks = [],
  onCloseCodeInspector,
  onSelectNode,
  onExpandNode,
  onCollapseNode,
  onToggleNodeExpansion,
  onFocusNode,
  relationshipStateById,
  onOpenRelationship,
  selectChildNodeIdForDrill,
  viewportFocusNodeId,
  viewportFocusRequiresExpanded,
  onViewportFocusComplete,
}: SoftwareMapFrameProps) {
  const session = useReviewSession();
  const { openCommentDraft } = useReviewActions();
  const frameRef = useRef<HTMLElement | null>(null);
  const codeInspectorResize = useRightPanelResize({
    // The expanded overlay is far wider than the inline frame, so it keeps its
    // own width instead of having a wide drag clamped down over the inline one.
    stateKey: expanded
      ? "code-inspector-width-expanded"
      : "code-inspector-width",
    defaultWidth: DEFAULT_CODE_INSPECTOR_WIDTH,
    minWidth: MIN_CODE_INSPECTOR_WIDTH,
    maxWidth: MAX_CODE_INSPECTOR_WIDTH,
    minMainWidth: MIN_SOFTWARE_MAP_CANVAS_WIDTH,
    separatorWidth: 10,
    label: "Resize code inspector",
    containerRef: frameRef,
  });

  const viewType = snapshot.viewType ?? "inlineC4";
  const viewTarget = buildGraphTarget({
    diagram: title,
    type: "node",
    path: [title],
    payload: { title, viewName, viewType },
    quote: title,
  });
  // SAFETY: React passes "--*" keys through to style.setProperty; CSSProperties
  // only lacks an index signature for custom properties.
  const style =
    height && !expanded
      ? ({
          "--software-map-height": softwareMapCssLength(height),
        } as CSSProperties)
      : undefined;
  // SAFETY: React passes "--*" keys through to style.setProperty; CSSProperties
  // only lacks an index signature for custom properties.
  const bodyStyle = inspectedNode
    ? ({
        "--software-map-inspector-width": `${codeInspectorResize.width}px`,
      } as CSSProperties)
    : undefined;
  const showMapFloatingActions = shouldShowSoftwareMapFloatingActions({
    showChrome,
    showFloatingActions,
    hasCodeInspector: inspectedNode !== null,
    hasRefreshAction: Boolean(onRefresh),
  });
  const captureNodeExpansion = (node: SoftwareMapNodeSnapshot) => {
    if (!node.expandable || node.expanded) return;
    captureUiEvent(session, "map_expanded", {
      level: mapExpansionLevelForNode(node),
    });
  };
  const selectNodeWithTelemetry = (node: SoftwareMapNodeSnapshot) => {
    captureUiEvent(session, "peek_opened", { via: "map" });
    onSelectNode?.(node);
  };
  const expandNodeWithTelemetry = (node: SoftwareMapNodeSnapshot) => {
    captureNodeExpansion(node);
    captureUiEvent(session, "peek_opened", { via: "map" });
    onExpandNode?.(node);
  };
  const toggleNodeExpansionWithTelemetry = (node: SoftwareMapNodeSnapshot) => {
    captureNodeExpansion(node);
    onToggleNodeExpansion?.(node);
  };

  return (
    <figure
      ref={frameRef}
      className={[
        "software-map-frame",
        expanded ? "software-map-frame--expanded" : "",
        showChrome ? "" : "software-map-frame--chrome-hidden",
        hasResolvedSnapshot ? "" : "software-map-frame--placeholder",
      ]
        .filter(Boolean)
        .join(" ")}
      style={style}
      data-review-locator={targetKey(viewTarget)}
    >
      {showChrome && (
        <header className="software-map-header">
          <div className="diagram-header-main software-map-title-block software-map-view-comment-target">
            <span className="diagram-kind-badge software-map-kind-badge">
              {VIEW_TYPE_LABELS[viewType]}
            </span>
            <figcaption className="diagram-header-title">{title}</figcaption>
            <HoverCommentButton
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                openCommentDraft({
                  target: viewTarget,
                  title,
                  body: "",
                });
              }}
            />
          </div>
          <div className="software-map-actions">
            {onRefresh ? (
              <button
                type="button"
                className={[
                  "software-map-icon-button",
                  "software-map-icon-button--visible",
                  refreshing ? "software-map-refresh-button--active" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={onRefresh}
                aria-label="Refresh software map"
                title="Refresh software map"
              >
                <RefreshIcon />
              </button>
            ) : null}
            {expanded ? (
              <button
                type="button"
                className="software-map-icon-button software-map-icon-button--visible"
                onClick={onClose}
                aria-label="Close expanded software map"
              >
                <CloseIcon />
              </button>
            ) : (
              <button
                type="button"
                className="software-map-icon-button software-map-expand-button"
                onClick={onExpand}
                aria-label="Expand software map"
              >
                <span className="software-map-expand-icon" aria-hidden="true" />
              </button>
            )}
          </div>
        </header>
      )}
      {showMapFloatingActions && onRefresh ? (
        <div className="software-map-floating-actions">
          <button
            type="button"
            className={[
              "software-map-icon-button",
              "software-map-icon-button--visible",
              refreshing ? "software-map-refresh-button--active" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            onClick={onRefresh}
            aria-label="Refresh software map"
            title="Refresh software map"
          >
            <RefreshIcon />
          </button>
        </div>
      ) : null}

      <div
        className={[
          "software-map-body",
          inspectedNode ? "software-map-body--with-inspector" : "",
          codeInspectorResize.isResizing ? "software-map-body--resizing" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        style={bodyStyle}
      >
        <div className="software-map-canvas">
          {(status || error || !hasResolvedSnapshot) && (
            <div
              className={
                error ? "software-map-status error" : "software-map-status"
              }
            >
              {error ?? status ?? "Loading software map..."}
            </div>
          )}

          <C4MapCanvas
            snapshot={snapshot}
            viewName={viewName}
            diagram={title}
            expanded={expanded}
            interactionMode={interactionMode}
            onSelectNode={selectNodeWithTelemetry}
            onExpandNode={expandNodeWithTelemetry}
            onCollapseNode={onCollapseNode}
            onToggleNodeExpansion={toggleNodeExpansionWithTelemetry}
            onFocusNode={onFocusNode}
            relationshipStateById={relationshipStateById}
            onOpenRelationship={onOpenRelationship}
            selectChildNodeIdForDrill={selectChildNodeIdForDrill}
            viewportFocusNodeId={viewportFocusNodeId}
            viewportFocusRequiresExpanded={viewportFocusRequiresExpanded}
            onViewportFocusComplete={onViewportFocusComplete}
          />
        </div>
        {inspectedNode ? (
          <>
            <button
              type="button"
              className="software-map-code-inspector-backdrop"
              aria-label="Close code inspector"
              onClick={onCloseCodeInspector}
            />
            <div
              className="side-panel-resizer software-map-code-inspector-resizer"
              {...codeInspectorResize.separatorProps}
            />
            <SoftwareMapCodeInspector
              node={inspectedNode}
              diffPeeks={inspectedNodeDiffPeeks}
              onClose={onCloseCodeInspector}
            />
          </>
        ) : null}
      </div>
    </figure>
  );
}

function SoftwareMapCodeInspector({
  node,
  diffPeeks,
  onClose,
}: {
  node: SoftwareMapNodeSnapshot;
  diffPeeks: readonly SoftwareMapNodeDiffPeek[];
  onClose?: () => void;
}) {
  const [diffsCollapsed, setDiffsCollapsed] = useState(false);
  const collapseActionLabel = diffsCollapsed
    ? "Expand all diffs"
    : "Collapse all diffs";

  return (
    <aside
      className="software-map-code-inspector"
      aria-label={`${node.label} diff`}
    >
      <header className="software-map-code-inspector-header">
        <div className="software-map-code-inspector-title">
          <span>{softwareMapNodeTypeLabel(node)}</span>
          <strong title={node.label}>{node.label}</strong>
        </div>
        <div className="software-map-code-inspector-actions">
          {diffPeeks.length > 0 ? (
            <button
              type="button"
              className="software-map-icon-button software-map-icon-button--visible"
              onClick={() => setDiffsCollapsed((current) => !current)}
              aria-expanded={!diffsCollapsed}
              aria-label={collapseActionLabel}
              title={collapseActionLabel}
            >
              <span
                className={`codicon ${
                  diffsCollapsed ? "codicon-unfold" : "codicon-fold"
                }`}
                aria-hidden="true"
              />
            </button>
          ) : null}
          <SoftwareMapChangeBadge
            additions={node.additions}
            deletions={node.deletions}
          />
          <button
            type="button"
            className="software-map-icon-button software-map-icon-button--visible"
            onClick={onClose}
            aria-label="Close code inspector"
          >
            <CloseIcon />
          </button>
        </div>
      </header>
      <div className="software-map-code-inspector-diffs">
        {diffPeeks.length > 0 ? (
          <CodePeekGroup peeks={diffPeeks} collapsed={diffsCollapsed} />
        ) : (
          <div className="software-map-code-inspector-empty">
            No changed code is mapped to this node.
          </div>
        )}
      </div>
    </aside>
  );
}

function mapExpansionLevelForNode(
  node: Pick<SoftwareMapNodeSnapshot, "type">,
): "system" | "container" | "component" | "code" {
  switch (node.type) {
    case "person":
      return "system";
    case "softwareSystem":
      return "container";
    case "container":
    case "dataStore":
      return "component";
    case "component":
    case "dataStoreCollection":
    case "codeElement":
      return "code";
  }
}

function C4MapCanvas({
  snapshot,
  viewName,
  diagram,
  expanded,
  interactionMode,
  onSelectNode,
  onExpandNode,
  onCollapseNode,
  onToggleNodeExpansion,
  onFocusNode,
  relationshipStateById,
  onOpenRelationship,
  selectChildNodeIdForDrill,
  viewportFocusNodeId,
  viewportFocusRequiresExpanded,
  onViewportFocusComplete,
}: {
  snapshot: SoftwareMapResolvedSnapshot;
  viewName: string;
  diagram: string;
  expanded: boolean;
  interactionMode: C4MapInteractionMode;
  onSelectNode?: (node: SoftwareMapNodeSnapshot) => void;
  onExpandNode?: (node: SoftwareMapNodeSnapshot) => void;
  onCollapseNode?: (node: SoftwareMapNodeSnapshot) => void;
  onToggleNodeExpansion?: (node: SoftwareMapNodeSnapshot) => void;
  onFocusNode?: (node: SoftwareMapNodeSnapshot) => void;
  relationshipStateById?: ReadonlyMap<string, "active" | "inactive">;
  onOpenRelationship?: (relationshipId: string) => void;
  selectChildNodeIdForDrill?: (
    parentId: string,
    nodes: readonly Pick<SoftwareMapNodeSnapshot, "id" | "parentId">[],
  ) => string | null;
  viewportFocusNodeId?: string | null;
  viewportFocusRequiresExpanded?: boolean;
  onViewportFocusComplete?: (nodeId: string) => void;
}) {
  const session = useReviewSession();
  const [layoutState, setLayoutState] = useState<C4DisplayedLayoutState | null>(
    null,
  );
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const keyboardTargetRef = useRef<HTMLDivElement | null>(null);
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<
    C4MapAnyFlowNode,
    ReactFlowEdge
  > | null>(null);
  const [hotkeysOpen, setHotkeysOpen] = useState(true);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const flowRef = useRef<ReactFlowInstance<
    C4MapAnyFlowNode,
    ReactFlowEdge
  > | null>(null);
  const previousInlineLayoutRef = useRef<{
    layout: InlineC4LayoutResult;
    relationships: readonly SoftwareMapRelationshipSnapshot[];
  } | null>(null);
  const appliedLayoutSignatureRef = useRef<string | null>(null);
  const [nodeMeasurement, setNodeMeasurement] = useState<{
    key: string;
    dimensions: ReadonlyMap<string, C4NodeDimensions>;
  } | null>(null);
  const measuredNodes = snapshot.nodes ?? [];
  const measuredRelationships = snapshot.relationships ?? [];
  const displayedSnapshot = useMemo(
    () =>
      layoutState
        ? c4DisplayedSnapshotForCurrentState(layoutState.snapshot, snapshot)
        : snapshot,
    [layoutState, snapshot],
  );
  const layout = layoutState?.layout ?? null;
  const nodes = displayedSnapshot.nodes ?? [];
  const { theme } = useReviewDebugSettings();
  const reactFlowInteractionProps =
    c4MapReactFlowInteractionProps(interactionMode);
  const measurementKey = useMemo(
    () => c4MeasurementKey(measuredNodes),
    [measuredNodes],
  );
  const nodeDimensions =
    nodeMeasurement?.key === measurementKey ? nodeMeasurement.dimensions : null;
  const hasMeasuredNodes =
    measuredNodes.length === 0 ||
    (nodeDimensions !== null &&
      measuredNodes.every((node) => nodeDimensions.has(node.id)));

  const handleMeasuredNodes = useCallback(
    (nextDimensions: ReadonlyMap<string, C4NodeDimensions>) => {
      setNodeMeasurement((currentMeasurement) =>
        currentMeasurement?.key === measurementKey &&
        c4DimensionsEqual(currentMeasurement.dimensions, nextDimensions)
          ? currentMeasurement
          : { key: measurementKey, dimensions: nextDimensions },
      );
    },
    [measurementKey],
  );
  const layoutSignature = useMemo(
    () =>
      hasMeasuredNodes
        ? c4LayoutSignature(
            measuredNodes,
            measuredRelationships,
            nodeDimensions,
          )
        : "",
    [hasMeasuredNodes, measuredNodes, measuredRelationships, nodeDimensions],
  );
  const layoutInputRef = useRef({
    snapshot,
    nodes: measuredNodes,
    relationships: measuredRelationships,
    nodeDimensions,
  });
  layoutInputRef.current = {
    snapshot,
    nodes: measuredNodes,
    relationships: measuredRelationships,
    nodeDimensions,
  };

  useEffect(() => {
    if (!hasMeasuredNodes || !layoutSignature) return;
    if (appliedLayoutSignatureRef.current === layoutSignature) return;
    let cancelled = false;
    setLayoutError(null);
    const {
      nodes: layoutNodes,
      relationships: layoutRelationships,
      nodeDimensions: layoutNodeDimensions,
      snapshot: layoutSnapshot,
    } = layoutInputRef.current;
    const previousInlineLayout = c4PreviousInlineLayoutForRelationships({
      previousLayout: previousInlineLayoutRef.current?.layout,
      previousRelationships: previousInlineLayoutRef.current?.relationships,
      currentRelationships: layoutRelationships,
    });
    void runSerializedC4Layout(() =>
      cancelled
        ? Promise.resolve(null)
        : runInlineC4Layout(
            layoutNodes,
            layoutRelationships,
            layoutNodeDimensions ?? undefined,
            // A newly resolved edge changes the graph that determines node
            // placement. Reusing a no-edge layout keeps the graph in its old
            // stack, even though the edge itself is present.
            previousInlineLayout,
            session.wasmUrl(),
          ),
    )
      .then((nextLayout) => {
        if (cancelled || !nextLayout) return;
        appliedLayoutSignatureRef.current = layoutSignature;
        previousInlineLayoutRef.current = {
          layout: nextLayout.inlineLayout,
          relationships: layoutRelationships,
        };
        setLayoutState({
          signature: layoutSignature,
          snapshot: layoutSnapshot,
          layout: nextLayout.layout,
        });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLayoutError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [hasMeasuredNodes, layoutSignature, session]);
  const layoutRefreshing = Boolean(
    layoutState && layoutSignature && layoutState.signature !== layoutSignature,
  );

  const drillNode = useCallback(
    (node: SoftwareMapNodeSnapshot) => {
      const drillNodeId = softwareMapNodeIdForDrill({
        node,
        nodes,
        preferredChildNodeId: selectChildNodeIdForDrill?.(node.id, nodes),
      });
      if (drillNodeId !== node.id) {
        const childNode = nodes.find(
          (candidate) => candidate.id === drillNodeId,
        );
        if (childNode) onSelectNode?.(childNode);
        return;
      }

      onExpandNode?.(node);
    },
    [nodes, onExpandNode, onSelectNode, selectChildNodeIdForDrill],
  );

  const flow = useMemo(
    () =>
      layout
        ? createC4MapFlowFromLayout(displayedSnapshot, layout, {
            viewName,
            diagram,
            onSelectNode,
            onExpandNode,
            onCollapseNode,
            onDrillNode: drillNode,
            nodeDimensions: nodeDimensions ?? undefined,
            relationshipStateById,
            onOpenRelationship,
          })
        : null,
    [
      diagram,
      drillNode,
      layout,
      nodeDimensions,
      onCollapseNode,
      onExpandNode,
      onSelectNode,
      onOpenRelationship,
      relationshipStateById,
      displayedSnapshot,
      viewName,
    ],
  );
  useEffect(() => {
    if (!flowInstance || !layout) return;
    const canvas = keyboardTargetRef.current;
    let frame = 0;
    const scheduleFit = () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        fitC4MapView(flowRef.current);
      });
    };
    scheduleFit();
    if (!canvas || !hasResizeObserver()) {
      return () => {
        if (frame !== 0) cancelAnimationFrame(frame);
      };
    }
    const resizeObserver = new ResizeObserver(scheduleFit);
    resizeObserver.observe(canvas);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      resizeObserver.disconnect();
    };
  }, [flowInstance, layout]);

  useEffect(() => {
    const focusNodeId = softwareMapViewportFocusNodeId({
      nodes: flow?.nodes ?? [],
      viewportFocusNodeId,
    });
    const focused = focusNodeId
      ? flow?.nodes.find((node) => node.id === focusNodeId)
      : null;
    if (!focused) return;
    if (
      !softwareMapViewportFocusTargetReady({
        node: focused.data.node,
        viewportFocusNodeId,
        requireExpanded: viewportFocusRequiresExpanded,
      })
    ) {
      return;
    }
    const frame = requestAnimationFrame(() => {
      if (
        !focusC4MapNodeAndKeyboard(
          flowRef.current,
          focused,
          keyboardTargetRef.current,
        )
      ) {
        return;
      }
      if (viewportFocusNodeId === focused.id) {
        onViewportFocusComplete?.(focused.id);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [
    flowInstance,
    flow?.nodes,
    onViewportFocusComplete,
    viewportFocusNodeId,
    viewportFocusRequiresExpanded,
  ]);

  useLayoutEffect(() => {
    if (!displayedSnapshot.selectedNodeId) return;
    focusSoftwareMapKeyboardTarget(keyboardTargetRef.current);
  }, [displayedSnapshot.selectedNodeId, displayedSnapshot.view]);

  useLayoutEffect(() => {
    if (!shouldAutoFocusC4MapKeyboardTarget(interactionMode)) return;
    focusSoftwareMapKeyboardTarget(keyboardTargetRef.current);
  }, [flow, interactionMode]);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.defaultPrevented) return;
      if (
        isSoftwareMapEditableTarget(event.target) ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return;
      }

      if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        event.stopPropagation();
        fitC4MapView(flowRef.current);
        return;
      }

      const direction = c4SpatialDirectionForKey(event.key);
      if (direction) {
        event.preventDefault();
        event.stopPropagation();
        const nextId = findSpatialC4Node(
          displayedSnapshot.selectedNodeId,
          c4SpatialPositions(layout),
          direction,
        );
        const nextNode = nextId
          ? nodes.find((candidate) => candidate.id === nextId)
          : null;
        if (nextNode) {
          onSelectNode?.(nextNode);
          const flowNode = flow?.nodes.find((node) => node.id === nextNode.id);
          if (flowNode) {
            revealC4MapNode(
              flowRef.current,
              keyboardTargetRef.current,
              flowNode,
            );
          }
        }
        return;
      }

      if (event.key === "Enter") {
        const selected = displayedSnapshot.selectedNodeId
          ? nodes.find((node) => node.id === displayedSnapshot.selectedNodeId)
          : null;
        if (selected) {
          event.preventDefault();
          event.stopPropagation();
          drillNode(selected);
        }
        return;
      }

      if (event.key === "Tab") {
        const selected = softwareMapNodeForKeyboardExpansion({
          nodes,
          selectedNodeId: displayedSnapshot.selectedNodeId,
          focusedNodeId: softwareMapEventTargetNodeId(
            event.target,
            event.currentTarget,
          ),
        });
        if (selected) {
          event.preventDefault();
          event.stopPropagation();
          onToggleNodeExpansion?.(selected);
        }
        return;
      }

      if (event.key === "Escape") {
        const parentId = parentSoftwareMapNodeId({
          nodes,
          nodeId: displayedSnapshot.selectedNodeId,
        });
        const parent = parentId
          ? nodes.find((node) => node.id === parentId)
          : null;
        if (parent) {
          event.preventDefault();
          event.stopPropagation();
          onSelectNode?.(parent);
          onFocusNode?.(parent);
        }
      }
    },
    [
      layout,
      flow?.nodes,
      drillNode,
      nodes,
      onFocusNode,
      onSelectNode,
      onToggleNodeExpansion,
      displayedSnapshot.selectedNodeId,
    ],
  );
  const handleKeyDownCapture = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Tab") {
        handleKeyDown(event);
      }
    },
    [handleKeyDown],
  );

  return (
    <div
      ref={keyboardTargetRef}
      className={[
        "software-map-c4-canvas",
        expanded ? "software-map-c4-canvas--expanded" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      tabIndex={0}
      onKeyDownCapture={handleKeyDownCapture}
      onKeyDown={handleKeyDown}
    >
      <C4NodeMeasurementLayer
        nodes={measuredNodes}
        measurementKey={measurementKey}
        onMeasure={handleMeasuredNodes}
      />
      {layoutError ? (
        <div className="software-map-code-status">
          Layout failed: {layoutError}
        </div>
      ) : (
        <>
          {layoutRefreshing ? (
            <div className="software-map-code-status">Refreshing layout...</div>
          ) : null}
          {flow ? (
            <>
              <C4HoveredNodeContext.Provider value={hoveredNodeId}>
                <ReactFlow
                  colorMode={theme}
                  proOptions={{ hideAttribution: true }}
                  nodes={flow.nodes}
                  edges={flow.edges}
                  nodeTypes={c4NodeTypes}
                  edgeTypes={c4EdgeTypes}
                  nodesDraggable={false}
                  nodesConnectable={false}
                  elementsSelectable
                  panActivationKeyCode={null}
                  fitView
                  fitViewOptions={{ padding: C4_FIT_VIEW_PADDING }}
                  minZoom={C4_FLOW_MIN_ZOOM}
                  maxZoom={C4_FLOW_MAX_ZOOM}
                  panOnScroll={reactFlowInteractionProps.panOnScroll}
                  preventScrolling={reactFlowInteractionProps.preventScrolling}
                  zoomOnScroll={reactFlowInteractionProps.zoomOnScroll}
                  zoomOnPinch={reactFlowInteractionProps.zoomOnPinch}
                  zoomOnDoubleClick={false}
                  onInit={(instance) => {
                    flowRef.current = instance;
                    setFlowInstance(instance);
                  }}
                  onNodeClick={(_, node) => onSelectNode?.(node.data.node)}
                  onNodeMouseEnter={(_, node) => setHoveredNodeId(node.id)}
                  onNodeMouseLeave={(_, node) =>
                    setHoveredNodeId((currentNodeId) =>
                      currentNodeId === node.id ? null : currentNodeId,
                    )
                  }
                >
                  <Background gap={24} color="var(--canvas-grid)" />
                  {expanded && (
                    <MiniMap
                      pannable
                      zoomable
                      position="top-right"
                      maskColor="var(--minimap-mask)"
                      maskStrokeColor="var(--rule-soft)"
                      maskStrokeWidth={1}
                      nodeColor={(node) =>
                        node.id === displayedSnapshot.selectedNodeId
                          ? "var(--minimap-node-selected)"
                          : "var(--minimap-node)"
                      }
                      nodeStrokeColor={(node) =>
                        node.id === displayedSnapshot.selectedNodeId
                          ? "var(--selection)"
                          : "var(--rule-soft)"
                      }
                      nodeBorderRadius={4}
                      style={{
                        backgroundColor: "var(--surface)",
                        border: "1px solid var(--rule)",
                        borderRadius: 8,
                      }}
                    />
                  )}
                  <Controls showInteractive={false} />
                </ReactFlow>
              </C4HoveredNodeContext.Provider>
            </>
          ) : (
            <div className="software-map-code-status">
              Laying out software map...
            </div>
          )}
        </>
      )}
      <SoftwareMapHotkeysTab
        groups={C4_MAP_HOTKEY_GROUPS}
        activeGroupId="c4-navigation"
        open={hotkeysOpen}
        ariaLabel="Software map keyboard shortcuts"
        onOpenChange={setHotkeysOpen}
      />
    </div>
  );
}

function hasResizeObserver(): boolean {
  return typeof ResizeObserver !== "undefined";
}

function c4MeasurementKey(nodes: SoftwareMapNodeSnapshot[]) {
  return nodes
    .map((node) =>
      [
        node.id,
        node.label,
        node.type,
        node.dataStoreKind ?? "",
        node.changeStatus ?? "",
        node.description ?? "",
        node.file ?? "",
        node.line ?? "",
        node.boundary ? "boundary" : "",
        node.childCount ?? "",
        c4DataStoreSchemaSignature(node),
      ].join("\u001f"),
    )
    .join("\u001e");
}

function c4DimensionsEqual(
  left: ReadonlyMap<string, C4NodeDimensions> | null,
  right: ReadonlyMap<string, C4NodeDimensions>,
) {
  if (!left || left.size !== right.size) return false;
  for (const [id, rightDimensions] of right) {
    const leftDimensions = left.get(id);
    if (
      !leftDimensions ||
      leftDimensions.width !== rightDimensions.width ||
      leftDimensions.height !== rightDimensions.height
    ) {
      return false;
    }
  }
  return true;
}

function C4NodeMeasurementLayer({
  nodes,
  measurementKey,
  onMeasure,
}: {
  nodes: SoftwareMapNodeSnapshot[];
  measurementKey: string;
  onMeasure: (dimensions: ReadonlyMap<string, C4NodeDimensions>) => void;
}) {
  const refs = useRef(new Map<string, HTMLDivElement>());
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  useLayoutEffect(() => {
    const measuredNodes = nodesRef.current;
    if (measuredNodes.length === 0) {
      onMeasure(new Map());
      return;
    }
    const measure = () => {
      const dimensions = new Map<string, C4NodeDimensions>();
      for (const node of measuredNodes) {
        const element = refs.current.get(node.id);
        if (!element) return;
        const rect = element.getBoundingClientRect();
        dimensions.set(node.id, {
          width: Math.ceil(rect.width),
          height: Math.ceil(rect.height),
        });
      }
      onMeasure(dimensions);
    };
    return scheduleC4NodeMeasurements(measure);
  }, [measurementKey, onMeasure]);

  return (
    <div className="software-map-c4-measure-layer" aria-hidden="true">
      {nodes.map((node) => (
        <div
          key={node.id}
          ref={(element) => {
            if (element) {
              refs.current.set(node.id, element);
            } else {
              refs.current.delete(node.id);
            }
          }}
          className={[
            "software-map-c4-measure-node",
            `software-map-c4-measure-node--${node.type}`,
          ].join(" ")}
        >
          <SoftwareMapNodeCard node={node} selected={false} />
        </div>
      ))}
    </div>
  );
}

function SoftwareMapC4Edge(
  props: ReactFlowEdgeProps<ReactFlowEdge<C4MapEdgeData>>,
) {
  const { openCommentDraft } = useReviewActions();
  const hoveredNodeId = useContext(C4HoveredNodeContext);
  const [isHoveringEdge, setIsHoveringEdge] = useState(false);
  const data = props.data;
  const label = data?.relationship.hideLabel
    ? undefined
    : (data?.label ?? data?.semanticKind);
  const points = c4EdgePointsFromSections(data?.sections);
  if (points.length < 2) return null;
  const path = c4PolylinePath(points);
  const endpointBubbles = c4EdgeEndpointBubbles(
    points,
    data?.relationship ?? { from: props.source },
    hoveredNodeId,
  );
  const labelPoint =
    data?.labelPoint ??
    c4EdgeLabelPoint(data?.labelPosition, data?.labelDimensions, points);
  const relationshipId = data?.relationshipId ?? props.id;
  const commentLabel = label ?? relationshipId;
  const target = data
    ? buildGraphTarget({
        diagram: data.diagram,
        type: "edge",
        path: data.targetPath,
        payload: softwareMapRelationshipTargetPayload(data.relationship),
        quote: commentLabel,
      })
    : null;
  const openRelationship = (
    event: ReactMouseEvent<Element> | ReactKeyboardEvent<Element>,
  ) => {
    if (!data?.onOpenRelationship) return;
    if (hasTextSelectionWithin(event.currentTarget)) {
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    data.onOpenRelationship(relationshipId);
  };
  const openEdgeComment = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    openCommentDraft({
      target,
      title: commentLabel,
      body: "",
    });
  };

  return (
    <>
      {data?.operationState && data.operationState !== "inactive" ? (
        <path
          d={path}
          className={[
            "software-map-c4-edge-highlight",
            `software-map-c4-edge-highlight--${data.operationState}`,
          ].join(" ")}
        />
      ) : null}
      <BaseEdge
        path={path}
        markerStart={props.markerStart}
        markerEnd={props.markerEnd}
        style={props.style}
        interactionWidth={props.interactionWidth}
      />
      <path
        d={path}
        className="software-map-c4-edge-hit-area"
        onMouseEnter={() => setIsHoveringEdge(true)}
        onMouseLeave={() => setIsHoveringEdge(false)}
        onClick={openRelationship}
      />
      <EdgeLabelRenderer>
        {endpointBubbles.map((bubble) => (
          <span
            key={bubble.endpoint}
            aria-hidden="true"
            className={[
              "software-map-c4-edge-endpoint",
              bubble.hovered ? "software-map-c4-edge-endpoint--hovered" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            data-endpoint={bubble.endpoint}
            style={{
              transform: `translate(-50%, -50%) translate(${bubble.x}px, ${bubble.y}px)`,
            }}
          />
        ))}
        <div
          className={
            isHoveringEdge
              ? "software-map-c4-edge-comment-target comment-target-hovered nodrag nopan"
              : "software-map-c4-edge-comment-target nodrag nopan"
          }
          style={{
            transform: `translate(-50%, -50%) translate(${labelPoint.x}px, ${labelPoint.y}px)`,
          }}
          onMouseEnter={() => setIsHoveringEdge(true)}
          onMouseLeave={() => setIsHoveringEdge(false)}
          data-review-locator={target ? targetKey(target) : undefined}
        >
          {label ? (
            data?.onOpenRelationship ? (
              <span
                role="button"
                tabIndex={0}
                className={[
                  "software-map-c4-edge-label",
                  "software-map-c4-edge-label--button",
                  data.selectedNodeAttached
                    ? "software-map-c4-edge-label--selected-node"
                    : "",
                  data.operationState
                    ? `software-map-c4-edge-label--${data.operationState}`
                    : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                data-review-anchor-id={relationshipId}
                onClick={openRelationship}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  openRelationship(event);
                }}
              >
                {label}
              </span>
            ) : (
              <span
                className={[
                  "software-map-c4-edge-label",
                  data?.selectedNodeAttached
                    ? "software-map-c4-edge-label--selected-node"
                    : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                {label}
              </span>
            )
          ) : null}
          <HoverCommentButton onClick={openEdgeComment} />
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

function c4NodeCommentPlacement(button: HTMLElement): CommentDraftPlacement {
  const rect = button.getBoundingClientRect();
  return {
    x: rect.right + 8,
    y: rect.top - 4,
    side: "right",
  };
}

function c4PolylinePath(points: C4ElkPoint[]): string {
  const [first, ...rest] = points;
  if (!first) return "";
  return [
    `M ${first.x} ${first.y}`,
    ...rest.map((point) => `L ${point.x} ${point.y}`),
  ].join(" ");
}

function SoftwareMapC4GroupNode({
  data,
}: ReactFlowNodeProps<C4MapFlowGroupNode>) {
  const { openCommentDraft } = useReviewActions();
  const target = buildGraphTarget({
    diagram: data.diagram,
    type: "node",
    path: data.targetPath,
    payload: softwareMapNodeTargetPayload(data.node),
    quote: data.node.label,
  });
  const openNodeComment = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    openCommentDraft({
      target,
      title: data.node.label,
      body: "",
      placement: c4NodeCommentPlacement(event.currentTarget),
    });
  };

  return (
    <div
      className={[
        "software-map-c4-group-shell",
        `software-map-c4-group-shell--${data.node.type}`,
        data.selected ? "selected" : "",
        data.node.changeStatus && data.node.changeStatus !== "unchanged"
          ? `software-map-c4-group-shell--${data.node.changeStatus}`
          : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-review-locator={targetKey(target)}
      onClick={(event) => {
        if (hasTextSelectionWithin(event.currentTarget)) {
          event.stopPropagation();
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        data.onSelect?.(data.node);
      }}
      onDoubleClickCapture={(event) => {
        if (hasTextSelectionWithin(event.currentTarget)) {
          event.stopPropagation();
        }
      }}
    >
      <Handle
        id="target-left"
        type="target"
        position={Position.Left}
        className="software-map-c4-handle"
      />
      <Handle
        id="source-left"
        type="source"
        position={Position.Left}
        className="software-map-c4-handle"
      />
      <Handle
        id="target-top"
        type="target"
        position={Position.Top}
        className="software-map-c4-handle"
      />
      <Handle
        id="source-top"
        type="source"
        position={Position.Top}
        className="software-map-c4-handle"
      />
      <div className="software-map-c4-group-title software-map-c4-group-title--world">
        <span>{softwareMapNodeTypeLabel(data.node)}</span>
        <strong>{data.node.label}</strong>
        <SoftwareMapChangeBadge
          status={data.node.changeStatus}
          additions={data.node.additions}
          deletions={data.node.deletions}
        />
      </div>
      <HoverCommentButton onClick={openNodeComment} />
      <Handle
        id="source-right"
        type="source"
        position={Position.Right}
        className="software-map-c4-handle"
      />
      <Handle
        id="target-right"
        type="target"
        position={Position.Right}
        className="software-map-c4-handle"
      />
      <Handle
        id="source-bottom"
        type="source"
        position={Position.Bottom}
        className="software-map-c4-handle"
      />
      <Handle
        id="target-bottom"
        type="target"
        position={Position.Bottom}
        className="software-map-c4-handle"
      />
    </div>
  );
}

function SoftwareMapC4Node({ data }: ReactFlowNodeProps<C4MapFlowNode>) {
  const { openCommentDraft } = useReviewActions();
  const target = buildGraphTarget({
    diagram: data.diagram,
    type: "node",
    path: data.targetPath,
    payload: softwareMapNodeTargetPayload(data.node),
    quote: data.node.label,
  });
  const openNodeComment = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    openCommentDraft({
      target,
      title: data.node.label,
      body: "",
      placement: c4NodeCommentPlacement(event.currentTarget),
    });
  };

  return (
    <div
      className={["software-map-c4-node-shell", "nodrag", "nopan"]
        .filter(Boolean)
        .join(" ")}
      data-review-locator={targetKey(target)}
      onDoubleClickCapture={(event) => {
        if (hasTextSelectionWithin(event.currentTarget)) {
          event.stopPropagation();
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (data.node.expanded) {
          data.onCollapseNode?.(data.node);
        } else {
          data.onExpandNode?.(data.node);
        }
      }}
    >
      <Handle
        id="target-left"
        type="target"
        position={Position.Left}
        className="software-map-c4-handle"
      />
      <Handle
        id="source-left"
        type="source"
        position={Position.Left}
        className="software-map-c4-handle"
      />
      <Handle
        id="target-top"
        type="target"
        position={Position.Top}
        className="software-map-c4-handle"
      />
      <Handle
        id="source-top"
        type="source"
        position={Position.Top}
        className="software-map-c4-handle"
      />
      <SoftwareMapNodeCard
        node={data.node}
        selected={data.selected}
        onSelect={data.onSelect}
        onExpandNode={data.onExpandNode}
      />
      <HoverCommentButton onClick={openNodeComment} />
      <Handle
        id="source-right"
        type="source"
        position={Position.Right}
        className="software-map-c4-handle"
      />
      <Handle
        id="target-right"
        type="target"
        position={Position.Right}
        className="software-map-c4-handle"
      />
      <Handle
        id="source-bottom"
        type="source"
        position={Position.Bottom}
        className="software-map-c4-handle"
      />
      <Handle
        id="target-bottom"
        type="target"
        position={Position.Bottom}
        className="software-map-c4-handle"
      />
    </div>
  );
}

function SoftwareMapDataStoreOutline({
  outline,
}: {
  outline: SoftwareMapDataStoreOutlineKind;
}) {
  if (outline === "folder") {
    return (
      <span aria-hidden="true" className="software-map-node-storage-folder">
        <span className="software-map-node-storage-folder-body" />
        <svg
          className="software-map-node-storage-folder-tab"
          focusable="false"
          preserveAspectRatio="none"
          viewBox="0 0 190 48"
        >
          <path
            className="software-map-node-storage-folder-tab-fill"
            d="M2 46 V14 Q2 2 14 2 H148 L188 46 Z"
            vectorEffect="non-scaling-stroke"
          />
          <path
            className="software-map-node-storage-folder-tab-border"
            d="M2 46 V14 Q2 2 14 2 H148 L188 46"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </span>
    );
  }

  const geometry = softwareMapDataStoreOutlineGeometry(outline);
  return (
    <svg
      aria-hidden="true"
      className="software-map-node-storage-outline"
      focusable="false"
      preserveAspectRatio="none"
      viewBox="0 0 280 140"
    >
      <path
        className="software-map-node-storage-fill"
        d={geometry.fillPath}
        vectorEffect="non-scaling-stroke"
      />
      {geometry.fillDetailPath ? (
        <path
          className="software-map-node-storage-fill-detail"
          d={geometry.fillDetailPath}
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
      <path
        className="software-map-node-storage-selection"
        d={geometry.outlinePath}
        vectorEffect="non-scaling-stroke"
      />
      <path
        className="software-map-node-storage-border"
        d={geometry.outlinePath}
        vectorEffect="non-scaling-stroke"
      />
      {geometry.detailPaths.map((path) => (
        <path
          className="software-map-node-storage-detail"
          d={path}
          key={path}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}

function softwareMapDataStoreOutlineGeometry(
  outline: SoftwareMapDataStoreOutlineKind,
) {
  if (outline === "bucket") {
    return {
      fillPath: "M18 24 C18 12 262 12 262 24 L238 118 C236 130 44 130 42 118 Z",
      fillDetailPath: "M18 24 C18 12 262 12 262 24 C262 36 18 36 18 24 Z",
      outlinePath:
        "M18 24 C18 12 262 12 262 24 L238 118 C236 130 44 130 42 118 Z",
      detailPaths: [
        "M18 24 C18 36 262 36 262 24",
        "M42 118 C42 130 238 130 238 118",
      ],
    };
  }

  return {
    fillPath: "M8 22 C8 34 272 34 272 22 L272 116 C272 128 8 128 8 116 Z",
    fillDetailPath: "M8 22 C8 10 272 10 272 22 C272 34 8 34 8 22 Z",
    outlinePath:
      "M8 22 C8 10 272 10 272 22 L272 116 C272 128 8 128 8 116 L8 22",
    detailPaths: ["M8 22 C8 34 272 34 272 22", "M8 116 C8 128 272 128 272 116"],
  };
}

function SoftwareMapNodeFrame({
  node,
  selected,
  as: Element = "div",
  className,
  children,
  onSelect,
  onExpandNode,
}: {
  node: SoftwareMapNodeSnapshot;
  selected: boolean;
  as?: "button" | "div";
  className?: string;
  children?: ReactNode;
  onSelect?: (node: SoftwareMapNodeSnapshot) => void;
  onExpandNode?: (node: SoftwareMapNodeSnapshot) => void;
}) {
  const isCodeElement = node.type === "codeElement";
  const dataStoreOutline =
    node.type === "dataStore"
      ? softwareMapDataStoreOutlineKind(node.dataStoreKind)
      : undefined;
  const hasExpandedDataStoreSchema =
    (node.type === "dataStore" || node.type === "dataStoreCollection") &&
    Boolean(node.dataStoreSchemaSections?.length);
  const props = {
    className: [
      "software-map-node",
      "nodrag",
      "nopan",
      `software-map-node--${node.type}`,
      node.type === "dataStore" && node.dataStoreKind
        ? `software-map-node--dataStoreKind-${node.dataStoreKind}`
        : "",
      dataStoreOutline
        ? `software-map-node--dataStoreShape-${dataStoreOutline}`
        : "",
      node.changeStatus && node.changeStatus !== "unchanged"
        ? `software-map-node--${node.changeStatus}`
        : "",
      selected ? "selected" : "",
      node.boundary ? "boundary" : "",
      hasExpandedDataStoreSchema
        ? "software-map-node--has-data-store-schema"
        : "",
      className ?? "",
    ]
      .filter(Boolean)
      .join(" "),
    onClick: (event: ReactMouseEvent<HTMLElement>) => {
      if (hasTextSelectionWithin(event.currentTarget)) {
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onSelect?.(node);
    },
    onDoubleClick: (event: ReactMouseEvent<HTMLElement>) => {
      if (hasTextSelectionWithin(event.currentTarget)) {
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onExpandNode?.(node);
    },
  };
  return (
    <Element
      {...props}
      {...(Element === "button"
        ? {
            type: "button",
            "aria-label": `${softwareMapNodeTypeLabel(node)}: ${node.label}`,
          }
        : {
            role: "group",
            "aria-label": `${softwareMapNodeTypeLabel(node)}: ${node.label}`,
          })}
    >
      {dataStoreOutline ? (
        <SoftwareMapDataStoreOutline outline={dataStoreOutline} />
      ) : null}
      {isCodeElement ? (
        <div className="software-map-code-element-head">
          <code className="software-map-node-label--world">{node.label}</code>
          <SoftwareMapChangeBadge
            status={node.changeStatus}
            additions={node.additions}
            deletions={node.deletions}
          />
        </div>
      ) : (
        <>
          <div className="software-map-node-kicker">
            <div className="software-map-node-type">
              {softwareMapNodeTypeLabel(node)}
            </div>
            <SoftwareMapChangeBadge
              status={node.changeStatus}
              additions={node.additions}
              deletions={node.deletions}
            />
          </div>
          <h4 className="software-map-node-label--world">{node.label}</h4>
        </>
      )}
      {!isCodeElement && node.description && (
        <p className="software-map-node-description--world">
          {node.description}
        </p>
      )}
      {!isCodeElement && (
        <div className="software-map-node-meta">
          {node.file && (
            <span>
              {node.file}
              {node.line === undefined ? "" : `:L${node.line}`}
            </span>
          )}
          {node.childCount !== undefined && node.childCount > 0 && (
            <span>{node.childCount} children</span>
          )}
          {node.boundary && <span>boundary</span>}
        </div>
      )}
      {children}
      {hasExpandedDataStoreSchema && (
        <SoftwareMapDataStoreSchema
          sections={node.dataStoreSchemaSections ?? []}
        />
      )}
    </Element>
  );
}

function SoftwareMapDataStoreSchema({
  sections,
}: {
  sections: SoftwareMapDataStoreSchemaSectionSnapshot[];
}) {
  return (
    <div className="software-map-data-store-schema">
      {sections.map((section) => (
        <section
          key={section.id}
          className={`software-map-data-store-schema-section software-map-data-store-schema-section--${section.kind}`}
        >
          <header className="software-map-data-store-schema-section-header">
            <span>{section.kind}</span>
            <strong>{section.label}</strong>
          </header>
          {section.key && (
            <div className="software-map-data-store-schema-key">
              {section.key}
            </div>
          )}
          <div className="software-map-data-store-schema-rows">
            {section.rows.map((row) => (
              <div
                key={row.id}
                className={[
                  "software-map-data-store-schema-row",
                  row.primaryKey
                    ? "software-map-data-store-schema-row--primary"
                    : "",
                  row.state && row.state !== "inactive"
                    ? `software-map-data-store-schema-row--${row.state}`
                    : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                style={
                  // SAFETY: React passes "--*" keys through to
                  // style.setProperty; CSSProperties only lacks an index
                  // signature for custom properties.
                  {
                    "--software-map-schema-row-depth": row.depth ?? 0,
                  } as CSSProperties
                }
              >
                <span className="software-map-data-store-schema-row-name">
                  {row.primaryKey && <strong>PK</strong>}
                  {row.foreignKey && (
                    <strong className="foreign-key">FK</strong>
                  )}
                  {row.label}
                </span>
                <span className="software-map-data-store-schema-row-type">
                  {row.type ?? row.example ?? "object"}
                </span>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function SoftwareMapNodeCard({
  node,
  selected,
  onSelect,
  onExpandNode,
}: {
  node: SoftwareMapNodeSnapshot;
  selected: boolean;
  onSelect?: (node: SoftwareMapNodeSnapshot) => void;
  onExpandNode?: (node: SoftwareMapNodeSnapshot) => void;
}) {
  return (
    <SoftwareMapNodeFrame
      node={node}
      selected={selected}
      onSelect={onSelect}
      onExpandNode={onExpandNode}
    />
  );
}

function SoftwareMapChangeBadge({
  status,
  additions,
  deletions,
}: {
  status?: SoftwareChangeStatus;
  additions?: number;
  deletions?: number;
}) {
  const visibleAdditions = visibleSoftwareMapChangeCount(additions);
  const visibleDeletions = visibleSoftwareMapChangeCount(deletions);
  const hasCounts = Boolean(visibleAdditions || visibleDeletions);
  const hasChangeStatus = Boolean(status && status !== "unchanged");
  if (!hasCounts && !hasChangeStatus) return null;
  if (!hasCounts) {
    return (
      <span
        className="software-map-change-badge software-map-change-badge--empty"
        aria-hidden="true"
      />
    );
  }
  return (
    <span className="software-map-change-badge">
      {visibleAdditions ? (
        <span className="software-map-change-count software-map-change-count--added">
          +{visibleAdditions}
        </span>
      ) : null}
      {visibleDeletions ? (
        <span className="software-map-change-count software-map-change-count--removed">
          -{visibleDeletions}
        </span>
      ) : null}
    </span>
  );
}

function createPlaceholderSnapshot(
  title: string,
  view?: string,
): SoftwareMapResolvedSnapshot {
  return {
    title,
    view: view ?? "unresolved",
    viewType: "inlineC4",
    selectedNodeId: "placeholder-component",
    nodes: [
      {
        id: "placeholder-system",
        label: "Authored model",
        type: "softwareSystem",
        description:
          "MDX defines systems, containers, components, and relationships.",
      },
      {
        id: "placeholder-component",
        label: "Resolved snapshot",
        type: "component",
        parentId: "placeholder-system",
        description: "The Vite resolver will provide normalized map nodes.",
      },
      {
        id: "placeholder-code",
        label: "Code element",
        type: "codeElement",
        parentId: "placeholder-component",
        description: "Code cards will reuse the source-card renderer later.",
        childCount: 0,
      },
      {
        id: "placeholder-boundary",
        label: "Boundary node",
        type: "component",
        description:
          "Outside-scope relationships can render as boundary nodes.",
        boundary: true,
      },
    ],
    relationships: [
      {
        from: "placeholder-component",
        to: "placeholder-code",
        label: "contains",
        kind: "semantic",
      },
      {
        from: "placeholder-code",
        to: "placeholder-boundary",
        label: "calls",
        kind: "call",
      },
    ],
  };
}
