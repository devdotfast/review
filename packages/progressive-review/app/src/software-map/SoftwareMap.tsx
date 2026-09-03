import {
  type JsonValue,
  isJsonObject,
  jsonArray,
  jsonProperty,
  jsonString,
} from "@dev.fast/review-protocol";
import {
  type ElkGraph as LibavoidElkGraph,
  init as initLibavoidEdgeRouter,
  routeEdges as routeLibavoidEdges,
} from "@mr_mint/elkjs-libavoid";
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Edge as ReactFlowEdge,
  type EdgeProps as ReactFlowEdgeProps,
  type ReactFlowInstance,
  type Node as ReactFlowNode,
  type NodeProps as ReactFlowNodeProps,
  type Viewport,
} from "@xyflow/react";
import ELK, {
  type ElkNode,
  type LayoutOptions,
} from "elkjs/lib/elk.bundled.js";
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
import { z } from "zod";

import { throwAuthoringIssue } from "../../../src/authoring";
import { CodePeekGroup } from "../CodePeek";
import {
  type ReviewNodeTint,
  type ReviewTheme,
  useReviewDebugSettings,
} from "../debug-settings";
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
import type { LiveDiagramTarget } from "../thread-target-state";
import { captureUiEvent } from "../ui-telemetry";
import {
  type C4Projection,
  type ProjectedC4Relationship,
  collapseInlineC4Node,
  projectInlineC4,
} from "./c4-projection";
import {
  type SoftwareMapHotkeyGroup,
  SoftwareMapHotkeysTab,
} from "./hotkeys-tab";
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
  relationshipEndpointsKey,
  softwareMapLiveDiagram,
  softwareMapNodeLabelPath,
  softwareMapNodeTargetPayload,
  softwareMapRelationshipLabelPath,
  softwareMapRelationshipTargetPayload,
} from "./software-map-paths";
import {
  type createSoftwareMapCodeElements,
  shouldApplySoftwareMapModifiedOnly,
  softwareMapModelKey,
  softwareMapResolvedDataInputForModel,
  softwareMapResolvedDataInputHasWork,
  softwareMapResolvedDataInputKey,
} from "./software-map-resolved-data";

import "./styles.css";
import "@xyflow/react/dist/style.css";

const DEFAULT_CODE_INSPECTOR_WIDTH = 420;
const MIN_CODE_INSPECTOR_WIDTH = 340;
const MAX_CODE_INSPECTOR_WIDTH = 760;
const MIN_SOFTWARE_MAP_CANVAS_WIDTH = 420;

export type SoftwareMapViewType = "inlineC4";

export type SoftwareMapElementType =
  | "person"
  | "softwareSystem"
  | "container"
  | "dataStore"
  | "dataStoreCollection"
  | "component"
  | "codeElement";

export type SoftwareMapRelationshipKind = "call" | "semantic" | "implied";

export type SoftwareMapDataStoreOutlineKind = "cylinder" | "bucket" | "folder";

export interface SoftwareMapDiffCounts {
  additions: number;
  deletions: number;
}

export interface SoftwareMapCoverageClaim {
  path: string;
  files?: Array<{
    path: string;
    ranges?: Array<{ fromLine: number; toLine: number }>;
  }>;
  globs?: string[];
}

export interface SoftwareMapUnmappedDiffLine {
  kind: "add" | "remove";
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

export interface SoftwareMapUnmappedDiffHunk {
  startLine: number;
  lines: SoftwareMapUnmappedDiffLine[];
}

export interface SoftwareMapUnmappedDiffFile extends SoftwareMapDiffCounts {
  file: string;
  hunks: SoftwareMapUnmappedDiffHunk[];
}

export interface SoftwareMapUnmappedDiffSummary extends SoftwareMapDiffCounts {
  files: SoftwareMapUnmappedDiffFile[];
}

export interface SoftwareMapChangeSummary extends SoftwareMapDiffCounts {
  changeStatus: SoftwareChangeStatus;
  authoredStatus?: SoftwareChangeStatus;
  unmapped?: SoftwareMapUnmappedDiffSummary;
}

export type SoftwareMapNodeDiffPeek = {
  file: string;
  fromLine: number;
  toLine: number;
  graph: "head" | "base";
};

export interface SoftwareMapNodeSnapshot {
  id: string;
  label: string;
  type: SoftwareMapElementType;
  path?: string;
  description?: string;
  changeStatus?: SoftwareChangeStatus;
  authoredChangeStatus?: SoftwareChangeStatus;
  dataStoreKind?: SoftwareDataStoreKind;
  additions?: number;
  deletions?: number;
  parentId?: string | null;
  file?: string;
  line?: number;
  boundary?: boolean;
  expanded?: boolean;
  expandable?: boolean;
  childCount?: number;
  dataStoreSchemaSections?: SoftwareMapDataStoreSchemaSectionSnapshot[];
}

export function softwareMapNodeDiffPeeks({
  model,
  elementPath,
  changeSummaries,
}: {
  model: NormalizedSoftwareModel;
  elementPath: string;
  changeSummaries: ReadonlyMap<string, SoftwareMapChangeSummary>;
}): SoftwareMapNodeDiffPeek[] {
  const result: SoftwareMapNodeDiffPeek[] = [];
  const seen = new Set<string>();

  const append = (key: string, peek: SoftwareMapNodeDiffPeek) => {
    if (seen.has(key)) return;
    seen.add(key);
    result.push(peek);
  };
  const visit = (path: string) => {
    const element = model.elementsByPath.get(path);
    if (!element) return;
    const summary = changeSummaries.get(path);
    if (element.type === "codeElement" && element.sourceRanges?.length) {
      if (summary?.changeStatus === "unchanged") return;
      const graph = summary?.changeStatus === "removed" ? "base" : "head";
      for (const range of element.sourceRanges) {
        append(
          `range:${graph}:${range.file}:${range.fromLine}-${range.toLine}`,
          { ...range, graph },
        );
      }
      return;
    }

    const coveredDiff = summary?.unmapped;
    if (element.coverage && coveredDiff?.files.length) {
      for (const file of coveredDiff.files) {
        for (const range of softwareMapDiffFileRanges(file)) {
          append(
            `range:${range.graph}:${file.file}:${range.fromLine}-${range.toLine}`,
            {
              file: file.file,
              fromLine: range.fromLine,
              toLine: range.toLine,
              graph: range.graph,
            },
          );
        }
      }
      return;
    }

    for (const childPath of element.children) visit(childPath);
  };

  visit(elementPath);
  return result;
}

function softwareMapDiffFileRanges(file: SoftwareMapUnmappedDiffFile): Array<{
  fromLine: number;
  toLine: number;
  graph: "head" | "base";
}> {
  return file.hunks.map((hunk) => {
    const graph = hunk.lines.some((line) => line.newLine !== null)
      ? "head"
      : "base";
    const lineNumbers = hunk.lines.flatMap((line) => {
      const lineNumber = graph === "base" ? line.oldLine : line.newLine;
      return lineNumber === null ? [] : [lineNumber];
    });
    const hunkLines = lineNumbers.length > 0 ? lineNumbers : [hunk.startLine];
    const fromLine = Math.max(1, Math.min(...hunkLines));
    return {
      fromLine,
      toLine: Math.max(fromLine, ...hunkLines),
      graph,
    };
  });
}

// Type aliases, not interfaces: snapshots travel inside graph target
// payloads, which need the implicit index signature.
export type SoftwareMapDataStoreSchemaSectionSnapshot = {
  id: string;
  label: string;
  kind: "table" | "document";
  key?: string;
  rows: SoftwareMapDataStoreSchemaRowSnapshot[];
};

export type SoftwareMapDataStoreSchemaRowSnapshot = {
  id: string;
  label: string;
  depth?: number;
  type?: string;
  example?: string;
  primaryKey?: boolean;
  foreignKey?: boolean;
  state?: "active" | "inactive";
};

export interface SoftwareMapRelationshipSnapshot {
  id?: string;
  from: string;
  to: string;
  label?: string;
  kind?: SoftwareMapRelationshipKind;
  semanticKind?: string;
  hideLabel?: boolean;
  fromSchemaFieldPath?: string[];
  toSchemaFieldPath?: string[];
  fromSchemaEndpointKind?: "field" | "header";
  toSchemaEndpointKind?: "field" | "header";
}

export interface SoftwareMapResolvedSnapshot {
  title?: string;
  view?: string;
  viewType?: SoftwareMapViewType;
  nodes?: SoftwareMapNodeSnapshot[];
  relationships?: SoftwareMapRelationshipSnapshot[];
  selectedNodeId?: string | null;
  status?: string | null;
  unmappedDiff?: SoftwareMapUnmappedDiffSummary;
  groupBboxes?: Record<string, C4LayoutBox>;
}

export interface SoftwareMapResolvedDataState {
  key: string;
  counts: ReadonlyMap<string, SoftwareMapDiffCounts>;
  unmappedByElementPath: ReadonlyMap<string, SoftwareMapUnmappedDiffSummary>;
}

export type SoftwareMapResolvedDataPayload = Omit<
  SoftwareMapResolvedDataState,
  "key"
>;

export interface SoftwareMapResolvedDataInput {
  codeElements: ReturnType<typeof createSoftwareMapCodeElements>;
  coverageClaims: SoftwareMapCoverageClaim[];
}

export interface SoftwareMapProps {
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

export interface SoftwareMapFrameProps {
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

interface C4MapNodeData extends Record<string, unknown> {
  node: SoftwareMapNodeSnapshot;
  selected: boolean;
  diagram: string;
  targetPath: string[];
  onSelect?: (node: SoftwareMapNodeSnapshot) => void;
  onExpandNode?: (node: SoftwareMapNodeSnapshot) => void;
  onCollapseNode?: (node: SoftwareMapNodeSnapshot) => void;
  onDrillNode?: (node: SoftwareMapNodeSnapshot) => void;
}

type C4MapFlowNode = ReactFlowNode<C4MapNodeData, "softwareMapC4">;
type C4MapFlowGroupNode = ReactFlowNode<C4MapNodeData, "softwareMapC4Group">;
type C4MapAnyFlowNode = C4MapFlowNode | C4MapFlowGroupNode;
export type C4MapInteractionMode = "inline" | "standalone";

export function c4MapReactFlowInteractionProps(
  interactionMode: C4MapInteractionMode,
) {
  const standalone = interactionMode === "standalone";
  return {
    panOnScroll: false,
    preventScrolling: standalone,
    zoomOnPinch: standalone,
    zoomOnScroll: standalone,
  };
}

export function shouldAutoFocusC4MapKeyboardTarget(
  interactionMode: C4MapInteractionMode,
) {
  return interactionMode === "standalone";
}

export function shouldShowSoftwareMapFloatingActions({
  showChrome,
  showFloatingActions,
  hasCodeInspector,
  hasRefreshAction,
}: {
  showChrome: boolean;
  showFloatingActions: boolean;
  hasCodeInspector: boolean;
  hasRefreshAction: boolean;
}) {
  return (
    !showChrome && showFloatingActions && !hasCodeInspector && hasRefreshAction
  );
}

interface C4DisplayedLayoutState {
  signature: string;
  snapshot: SoftwareMapResolvedSnapshot;
  layout: C4LayoutResult;
}

interface C4MapEdgeData extends Record<string, unknown> {
  label?: string;
  semanticKind?: string;
  relationship: SoftwareMapRelationshipSnapshot;
  relationshipId: string;
  selectedNodeAttached?: boolean;
  diagram: string;
  targetPath: string[];
  sections?: C4ElkEdgeSection[];
  labelPosition?: C4ElkLabel;
  labelDimensions?: C4LabelDimensions;
  labelPoint?: C4ElkPoint;
  operationState?: "active" | "inactive";
  onOpenRelationship?: (relationshipId: string) => void;
}

interface C4LayoutEntry {
  node: SoftwareMapNodeSnapshot;
  x: number;
  y: number;
  width: number;
  height: number;
  expandedGroup?: boolean;
}

interface C4LayoutResult {
  nodes: C4LayoutEntry[];
  edgeSections: Map<string, C4ElkEdgeSection[]>;
  edgeLabels: Map<string, C4ElkLabel>;
}

export interface C4LayoutBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface InlineC4LayoutResult {
  nodeBboxes: Map<string, C4LayoutBox>;
  groupBboxes: Map<string, C4LayoutBox>;
  childLayoutKeys: Map<string, string>;
}

interface C4ElkPoint {
  x: number;
  y: number;
}

export interface C4EdgeEndpointBubble extends C4ElkPoint {
  endpoint: "source";
  hovered: boolean;
}

interface C4ElkEdgeSection {
  startPoint: C4ElkPoint;
  bendPoints?: C4ElkPoint[];
  endPoint: C4ElkPoint;
}

interface C4ElkLabel {
  x: number;
  y: number;
  width: number;
  height: number;
}

type C4LabelObstacle = C4ElkLabel;

interface C4NodeDimensions {
  width: number;
  height: number;
}

interface C4LabelDimensions {
  width: number;
  height: number;
}

export type C4SpatialDirection = "left" | "right" | "down" | "up";

export interface C4SpatialNodePosition {
  id: string;
  parentId?: string | null;
  x: number;
  y: number;
  width?: number;
  height?: number;
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

const TYPE_ORDER: Record<SoftwareMapElementType, number> = {
  person: 0,
  softwareSystem: 1,
  container: 2,
  dataStore: 3,
  dataStoreCollection: 4,
  component: 5,
  codeElement: 6,
};

export function softwareMapNodeTypeLabel(
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

export function softwareMapDataStoreOutlineKind(
  kind: SoftwareDataStoreKind | undefined,
): SoftwareMapDataStoreOutlineKind {
  if (kind === "bucket" || kind === "objectStore") return "bucket";
  if (kind === "artifactStore" || kind === "fileStore") return "folder";
  return "cylinder";
}

const C4_NODE_WIDTH = 280;
const C4_MIN_NODE_HEIGHT = 112;
const C4_FLOW_MIN_ZOOM = 0.03;
const C4_FLOW_MAX_ZOOM = 1.6;
const C4_SELECTED_NODE_FOCUS_PADDING = 0.16;
const C4_SELECTED_NODE_FOCUS_DURATION_MS = 140;
const C4_FIT_VIEW_PADDING = 0.18;
const C4_FIT_VIEW_DURATION_MS = 140;
const C4_NAV_NODE_REVEAL_PADDING_PX = 8;
const C4_NAV_NODE_REVEAL_DURATION_MS = 110;
const C4_DESCRIPTION_CHARS_PER_LINE = 42;
const C4_TITLE_CHARS_PER_LINE = 28;
const C4_EDGE_LABEL_MAX_WIDTH = 132;
const C4_EDGE_LABEL_HORIZONTAL_PADDING = 16;
const C4_EDGE_LABEL_VERTICAL_PADDING = 8;
const C4_EDGE_LABEL_CHARS_PER_LINE = 18;
const C4_EDGE_LABEL_LINE_HEIGHT = 15;
const C4_EDGE_LABEL_LABEL_GUTTER = 8;
const C4_EDGE_LABEL_NODE_GUTTER = 14;
const C4_EDGE_LABEL_CANDIDATE_STEP = 28;
const C4_EXPANDED_GROUP_LABEL_HEADER_HEIGHT = 70;
const C4_LOCAL_GROUP_PADDING = {
  top: C4_EXPANDED_GROUP_LABEL_HEADER_HEIGHT,
  right: 36,
  bottom: 36,
  left: 36,
} as const;
const C4_LOCAL_SIBLING_X_GAP = 96;
const C4_LOCAL_SIBLING_Y_GAP = 72;
const C4_LOCAL_ROW_CLUSTER_GAP = 24;

export const softwareMapC4NodeTypes = {
  softwareMapC4: SoftwareMapC4Node,
  softwareMapC4Group: SoftwareMapC4GroupNode,
};
export const softwareMapC4EdgeTypes = {
  softwareMapC4Edge: SoftwareMapC4Edge,
};
const c4NodeTypes = softwareMapC4NodeTypes;
const c4EdgeTypes = softwareMapC4EdgeTypes;
const C4HoveredNodeContext = createContext<string | null>(null);
const c4Elk = new ELK();
let c4LibavoidInitPromise: Promise<void> | null = null;

export class C4LayoutQueue {
  private tail: Promise<void> = Promise.resolve();

  run<Result>(task: () => Promise<Result>): Promise<Result> {
    const result = this.tail.then(task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

// libavoid owns one Emscripten runtime for the whole canvas bundle. Multiple
// Review canvases can stay mounted in native editor tabs, so serialization has
// to live at this shared boundary rather than inside an individual React tree.
const c4LayoutQueue = new C4LayoutQueue();

export function runSerializedC4Layout<Result>(
  task: () => Promise<Result>,
): Promise<Result> {
  return c4LayoutQueue.run(task);
}

export function findSpatialC4Node(
  selectedNodeId: string | null | undefined,
  positions: readonly C4SpatialNodePosition[],
  direction: C4SpatialDirection,
): string | null {
  const visiblePositions = positions.filter(
    (position) => Number.isFinite(position.x) && Number.isFinite(position.y),
  );
  const current = selectedNodeId
    ? visiblePositions.find((position) => position.id === selectedNodeId)
    : null;
  if (!current) {
    return firstC4SpatialNode(visiblePositions);
  }

  const scopedPositions = visiblePositions.filter(
    (position) => position.parentId === current.parentId,
  );
  const currentRect = c4SpatialRect(current);
  const sameLevelTarget = bestC4SpatialTarget({
    selectedNodeId: current.id,
    positions: scopedPositions,
    currentRect,
    direction,
  });
  if (sameLevelTarget) return sameLevelTarget;

  return bestC4SpatialTarget({
    selectedNodeId: current.id,
    positions: visiblePositions.filter(
      (position) => position.parentId === current.id,
    ),
    currentRect,
    direction,
  });
}

function bestC4SpatialTarget(input: {
  selectedNodeId: string;
  positions: readonly C4SpatialNodePosition[];
  currentRect: ReturnType<typeof c4SpatialRect>;
  direction: C4SpatialDirection;
}): string | null {
  let best: { id: string; score: number } | null = null;
  for (const position of input.positions) {
    if (position.id === input.selectedNodeId) continue;
    const score = c4SpatialScore(
      input.currentRect,
      c4SpatialRect(position),
      input.direction,
    );
    if (score === null) continue;
    if (!best || score < best.score) best = { id: position.id, score };
  }
  return best?.id ?? null;
}

function c4SpatialRect(position: C4SpatialNodePosition) {
  const width = position.width ?? 0;
  const height = position.height ?? 0;
  return {
    left: position.x,
    right: position.x + width,
    top: position.y,
    bottom: position.y + height,
    centerX: position.x + width / 2,
    centerY: position.y + height / 2,
  };
}

function c4SpatialScore(
  current: ReturnType<typeof c4SpatialRect>,
  candidate: ReturnType<typeof c4SpatialRect>,
  direction: C4SpatialDirection,
): number | null {
  if (direction === "left" && candidate.centerX >= current.centerX) return null;
  if (direction === "right" && candidate.centerX <= current.centerX)
    return null;
  if (direction === "up" && candidate.centerY >= current.centerY) return null;
  if (direction === "down" && candidate.centerY <= current.centerY) return null;

  const vertical = direction === "up" || direction === "down";
  const primaryGap =
    direction === "left"
      ? Math.max(0, current.left - candidate.right)
      : direction === "right"
        ? Math.max(0, candidate.left - current.right)
        : direction === "up"
          ? Math.max(0, current.top - candidate.bottom)
          : Math.max(0, candidate.top - current.bottom);
  const crossGap = vertical
    ? intervalGap(current.left, current.right, candidate.left, candidate.right)
    : intervalGap(current.top, current.bottom, candidate.top, candidate.bottom);
  const crossCenterDistance = vertical
    ? Math.abs(candidate.centerX - current.centerX)
    : Math.abs(candidate.centerY - current.centerY);
  if (crossGap === 0) return primaryGap * 1000 + crossCenterDistance;
  return 1_000_000_000 + crossGap * 1000 + primaryGap;
}

function intervalGap(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
): number {
  if (rightEnd < leftStart) return leftStart - rightEnd;
  if (rightStart > leftEnd) return rightStart - leftEnd;
  return 0;
}

function firstC4SpatialNode(
  positions: readonly C4SpatialNodePosition[],
): string | null {
  return (
    [...positions].sort((left, right) => {
      const dy = left.y - right.y;
      if (dy !== 0) return dy;
      const dx = left.x - right.x;
      if (dx !== 0) return dx;
      return left.id.localeCompare(right.id);
    })[0]?.id ?? null
  );
}

export function c4SpatialDirectionForKey(
  key: string,
): C4SpatialDirection | null {
  if (key === "h" || key === "ArrowLeft") return "left";
  if (key === "j" || key === "ArrowDown") return "down";
  if (key === "k" || key === "ArrowUp") return "up";
  if (key === "l" || key === "ArrowRight") return "right";
  return null;
}

export const C4_MAP_HOTKEY_GROUPS = [
  {
    id: "c4-navigation",
    label: "Map",
    items: [
      { keys: ["h", "j", "k", "l", "Arrows"], label: "select" },
      { keys: ["f"], label: "fit" },
    ],
  },
  {
    id: "c4-structure",
    label: "Node",
    items: [
      { keys: ["Enter"], label: "expand/drill" },
      { keys: ["Tab"], label: "toggle" },
      { keys: ["Esc"], label: "parent" },
    ],
  },
] as const satisfies readonly SoftwareMapHotkeyGroup[];

function c4SpatialPositions(
  layout: C4LayoutResult | null,
): C4SpatialNodePosition[] {
  return (
    layout?.nodes.map((entry) => ({
      id: entry.node.id,
      parentId: entry.node.parentId ?? null,
      x: entry.x,
      y: entry.y,
      width: entry.width,
      height: entry.height,
    })) ?? []
  );
}

export function selectedSoftwareMapNodeIdForNodes(input: {
  nodes: readonly Pick<SoftwareMapNodeSnapshot, "id">[];
  selectedNodeId: string | null | undefined;
}): string | null {
  const nodeIds = new Set(input.nodes.map((node) => node.id));
  if (input.selectedNodeId && nodeIds.has(input.selectedNodeId)) {
    return input.selectedNodeId;
  }
  return input.nodes[0]?.id ?? null;
}

export function c4DisplayedSnapshotForCurrentState(
  layoutSnapshot: SoftwareMapResolvedSnapshot,
  currentSnapshot: SoftwareMapResolvedSnapshot,
): SoftwareMapResolvedSnapshot {
  const layoutNodes = layoutSnapshot.nodes ?? [];
  const layoutNodeIds = new Set(layoutNodes.map((node) => node.id));
  const currentSelectedNodeId =
    currentSnapshot.selectedNodeId &&
    layoutNodeIds.has(currentSnapshot.selectedNodeId)
      ? currentSnapshot.selectedNodeId
      : null;
  const layoutSelectedNodeId =
    layoutSnapshot.selectedNodeId &&
    layoutNodeIds.has(layoutSnapshot.selectedNodeId)
      ? layoutSnapshot.selectedNodeId
      : null;

  return {
    ...layoutSnapshot,
    selectedNodeId: currentSelectedNodeId ?? layoutSelectedNodeId,
    status: currentSnapshot.status ?? layoutSnapshot.status,
    unmappedDiff: currentSnapshot.unmappedDiff,
  };
}

export function firstSoftwareMapChildNodeId(input: {
  nodes: readonly Pick<SoftwareMapNodeSnapshot, "id" | "parentId">[];
  parentId: string;
}): string | null {
  return (
    input.nodes.find((node) => node.parentId === input.parentId)?.id ?? null
  );
}

export function softwareMapChildNodeIdForDrill(input: {
  nodes: readonly Pick<SoftwareMapNodeSnapshot, "id" | "parentId">[];
  parentId: string;
  rememberedChildNodeId: string | null | undefined;
}): string | null {
  if (
    input.rememberedChildNodeId &&
    input.nodes.some(
      (node) =>
        node.id === input.rememberedChildNodeId &&
        node.parentId === input.parentId,
    )
  ) {
    return input.rememberedChildNodeId;
  }
  return firstSoftwareMapChildNodeId(input);
}

export function softwareMapNodeIdForDrill(input: {
  node: Pick<SoftwareMapNodeSnapshot, "id" | "expanded">;
  nodes: readonly Pick<SoftwareMapNodeSnapshot, "id" | "parentId">[];
  preferredChildNodeId?: string | null;
}): string {
  if (!input.node.expanded) return input.node.id;
  return (
    softwareMapChildNodeIdForDrill({
      nodes: input.nodes,
      parentId: input.node.id,
      rememberedChildNodeId: input.preferredChildNodeId ?? null,
    }) ?? input.node.id
  );
}

export function parentSoftwareMapNodeId(input: {
  nodes: readonly Pick<SoftwareMapNodeSnapshot, "id" | "parentId">[];
  nodeId: string | null | undefined;
}): string | null {
  if (!input.nodeId) return null;
  const selected = input.nodes.find((node) => node.id === input.nodeId);
  if (!selected?.parentId) return null;
  return input.nodes.some((node) => node.id === selected.parentId)
    ? selected.parentId
    : null;
}

export function toggledSoftwareMapExpandedNodeIds(input: {
  expandedNodeIds: ReadonlySet<string>;
  node: Pick<SoftwareMapNodeSnapshot, "path" | "expandable" | "expanded">;
}): Set<string> {
  const path = input.node.path;
  if (!path || !input.node.expandable) {
    return new Set(input.expandedNodeIds);
  }
  if (input.node.expanded) {
    return collapseInlineC4Node(input.expandedNodeIds, path);
  }
  const expandedNodeIds = new Set(input.expandedNodeIds);
  expandedNodeIds.add(path);
  return expandedNodeIds;
}

export interface SoftwareMapViewportFocusRequest {
  nodeId: string;
  requireExpanded: boolean;
}

export function toggledSoftwareMapViewportFocusRequest(
  node: Pick<SoftwareMapNodeSnapshot, "id" | "expanded">,
): SoftwareMapViewportFocusRequest {
  return {
    nodeId: node.id,
    requireExpanded: !node.expanded,
  };
}

export function softwareMapNodeForKeyboardExpansion<
  TNode extends Pick<SoftwareMapNodeSnapshot, "id" | "expandable">,
>(input: {
  nodes: readonly TNode[];
  selectedNodeId: string | null | undefined;
  focusedNodeId?: string | null | undefined;
}): TNode | null {
  if (input.selectedNodeId) {
    const selected = input.nodes.find(
      (node) => node.id === input.selectedNodeId,
    );
    return selected?.expandable ? selected : null;
  }

  if (input.focusedNodeId) {
    const focused = input.nodes.find((node) => node.id === input.focusedNodeId);
    return focused?.expandable ? focused : null;
  }

  return null;
}

export function softwareMapViewportFocusNodeId(input: {
  nodes: readonly Pick<SoftwareMapNodeSnapshot, "id">[];
  viewportFocusNodeId: string | null | undefined;
}): string | null {
  const nodeIds = new Set(input.nodes.map((node) => node.id));
  if (input.viewportFocusNodeId && nodeIds.has(input.viewportFocusNodeId)) {
    return input.viewportFocusNodeId;
  }
  return null;
}

export function softwareMapViewportFocusTargetReady(input: {
  node: Pick<SoftwareMapNodeSnapshot, "id" | "expanded">;
  viewportFocusNodeId: string | null | undefined;
  requireExpanded?: boolean;
}) {
  if (input.viewportFocusNodeId !== input.node.id) return true;
  return input.requireExpanded === false || input.node.expanded;
}

const SOFTWARE_MAP_KEYBOARD_NODE_ID_ATTRIBUTE = "data-software-map-node-id";
const SOFTWARE_MAP_KEYBOARD_NODE_SELECTOR = `[${SOFTWARE_MAP_KEYBOARD_NODE_ID_ATTRIBUTE}]`;

function softwareMapKeyboardNodeDomAttributes(
  nodeId: string,
): C4MapAnyFlowNode["domAttributes"] {
  // SAFETY: React types data-* attributes only in JSX. React Flow spreads
  // domAttributes onto the node wrapper, so this attribute reaches the DOM.
  return {
    [SOFTWARE_MAP_KEYBOARD_NODE_ID_ATTRIBUTE]: nodeId,
  } as C4MapAnyFlowNode["domAttributes"];
}

function softwareMapEventTargetNodeId(
  target: EventTarget | null,
  currentTarget: HTMLElement,
): string | null {
  if (typeof HTMLElement === "undefined") return null;
  if (!(target instanceof HTMLElement)) return null;
  const nodeElement = target.closest<HTMLElement>(
    SOFTWARE_MAP_KEYBOARD_NODE_SELECTOR,
  );
  if (!nodeElement || !currentTarget.contains(nodeElement)) return null;
  return nodeElement.getAttribute(SOFTWARE_MAP_KEYBOARD_NODE_ID_ATTRIBUTE);
}

function isSoftwareMapEditableTarget(target: EventTarget | null) {
  if (typeof HTMLElement === "undefined") return false;
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT")
  );
}

function focusSoftwareMapKeyboardTarget(element: HTMLElement | null) {
  if (!element || typeof document === "undefined") return;
  const activeElement = document.activeElement;
  if (isSoftwareMapEditableTarget(activeElement)) return;
  if (activeElement === element) return;
  element.focus({ preventScroll: true });
}

export function observeSoftwareMapVisibility(
  element: Element,
  onVisible: () => void,
) {
  if (typeof IntersectionObserver === "undefined") {
    onVisible();
    return () => {};
  }
  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      onVisible();
      observer.disconnect();
    },
    { rootMargin: "200px" },
  );
  observer.observe(element);
  return () => observer.disconnect();
}

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

export function softwareMapOverlayClassName({
  theme,
  nodeTint,
}: {
  theme: ReviewTheme;
  nodeTint: ReviewNodeTint;
}) {
  return [
    "software-map-overlay",
    // The overlay portals to document.body, outside the canvas root that
    // carries the dark token definitions — so it must bring the token scope
    // along itself.
    "review-canvas-root",
    "review-app",
    `review-app--theme-${theme}`,
    `review-app--tint-${nodeTint}`,
  ].join(" ");
}

export function buildSoftwareMapChangeSummaries(
  model: NormalizedSoftwareModel,
  diffCounts: ReadonlyMap<string, SoftwareMapDiffCounts> = new Map(),
  unmappedByElementPath: ReadonlyMap<
    string,
    SoftwareMapUnmappedDiffSummary
  > = new Map(),
): ReadonlyMap<string, SoftwareMapChangeSummary> {
  const summaries = new Map<string, SoftwareMapChangeSummary>();

  const summarize = (path: string): SoftwareMapChangeSummary => {
    const cached = summaries.get(path);
    if (cached) return cached;

    const element = model.elementsByPath.get(path);
    const ownCounts = diffCounts.get(path) ?? { additions: 0, deletions: 0 };
    const ownUnmapped = unmappedByElementPath.get(path);
    const hasOwnCoverage = Boolean(element?.coverage);
    let additions =
      element?.type === "codeElement"
        ? ownCounts.additions
        : (ownUnmapped?.additions ?? 0);
    let deletions =
      element?.type === "codeElement"
        ? ownCounts.deletions
        : (ownUnmapped?.deletions ?? 0);
    const changedDescendantStatuses: SoftwareChangeStatus[] = [];

    for (const childPath of element?.children ?? []) {
      const child = summarize(childPath);
      const childElement = model.elementsByPath.get(childPath);
      if (!hasOwnCoverage && childElement?.type !== "codeElement") {
        additions += child.additions;
        deletions += child.deletions;
      }
      if (child.changeStatus !== "unchanged") {
        changedDescendantStatuses.push(child.changeStatus);
      }
    }

    const authoredStatus = element?.changeStatus;
    const changeStatus = inferSoftwareMapChangeStatus({
      authoredStatus,
      additions,
      deletions,
      changedDescendantStatuses,
    });
    const summary: SoftwareMapChangeSummary = {
      changeStatus,
      authoredStatus,
      additions,
      deletions,
      unmapped: ownUnmapped,
    };
    summaries.set(path, summary);
    return summary;
  };

  for (const element of model.elements) {
    summarize(element.path);
  }
  return summaries;
}

function inferSoftwareMapChangeStatus({
  authoredStatus,
  additions,
  deletions,
  changedDescendantStatuses,
}: {
  authoredStatus?: SoftwareChangeStatus;
  additions: number;
  deletions: number;
  changedDescendantStatuses: readonly SoftwareChangeStatus[];
}): SoftwareChangeStatus {
  if (authoredStatus === "added" || authoredStatus === "removed") {
    return authoredStatus;
  }

  if (additions > 0 || deletions > 0) {
    return "modified";
  }

  if (authoredStatus === "modified") return authoredStatus;

  if (changedDescendantStatuses.length > 0) {
    return "modified";
  }

  return "unchanged";
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

const softwareMapDiffCountsSchema = z.object({
  additions: z.number(),
  deletions: z.number(),
});

const softwareMapUnmappedDiffSummarySchema = softwareMapDiffCountsSchema.extend(
  {
    files: z.array(
      softwareMapDiffCountsSchema.extend({
        file: z.string(),
        hunks: z.array(
          z.object({
            startLine: z.number(),
            lines: z.array(
              z.object({
                kind: z.enum(["add", "remove"]),
                oldLine: z.number().nullable(),
                newLine: z.number().nullable(),
                text: z.string(),
              }),
            ),
          }),
        ),
      }),
    ),
  },
);

/** The `ok` body of the resolved-data route; any other body yields no data. */
const softwareMapResolvedDataResponseSchema = z.object({
  ok: z.literal(true),
  countsByElementPath: z
    .record(z.string(), softwareMapDiffCountsSchema)
    .optional(),
  unmappedByElementPath: z
    .record(z.string(), softwareMapUnmappedDiffSummarySchema)
    .optional(),
});

export function parseSoftwareMapResolvedDataResponse(
  json: JsonValue,
): SoftwareMapResolvedDataPayload {
  const body = softwareMapResolvedDataResponseSchema.safeParse(json);
  if (!body.success) {
    return {
      counts: new Map(),
      unmappedByElementPath: new Map(),
    };
  }
  return {
    counts: new Map(Object.entries(body.data.countsByElementPath ?? {})),
    unmappedByElementPath: new Map(
      Object.entries(body.data.unmappedByElementPath ?? {}),
    ),
  };
}

export function softwareMapSnapshotFromInlineC4Projection({
  projection,
  changeSummaries,
}: {
  projection: C4Projection;
  changeSummaries?: ReadonlyMap<string, SoftwareMapChangeSummary>;
}): SoftwareMapResolvedSnapshot {
  const selectedNodeId = projection.selectedNodeId ?? projection.nodes[0]?.id;
  const selectedNode = selectedNodeId
    ? projection.nodes.find((node) => node.id === selectedNodeId)
    : undefined;
  return {
    title: "Software map",
    view: "inline-c4",
    viewType: "inlineC4",
    selectedNodeId,
    unmappedDiff: selectedNode
      ? changeSummaries?.get(selectedNode.path)?.unmapped
      : undefined,
    nodes: projection.nodes.map((element) => {
      const summary = changeSummaries?.get(element.path);
      return {
        id: element.id,
        label: element.label,
        type: element.type,
        path: element.path,
        description: element.description,
        changeStatus: summary?.changeStatus ?? element.changeStatus,
        authoredChangeStatus: element.changeStatus,
        dataStoreKind: element.dataStoreKind,
        additions: summary?.additions,
        deletions: summary?.deletions,
        parentId: element.parentPath ?? null,
        file: element.element?.sourceRanges?.[0]?.file,
        line: element.element?.sourceRanges?.[0]?.fromLine,
        boundary: element.external,
        expanded: element.isExpanded,
        expandable: element.isExpandable,
        childCount: element.childCount,
        dataStoreSchemaSections: element.dataStoreSchemaSections,
      };
    }),
    relationships: projection.relationships.map((relationship) =>
      softwareMapRelationshipFromInlineC4Relationship(relationship),
    ),
    status: null,
  };
}

function softwareMapRelationshipFromInlineC4Relationship(
  relationship: ProjectedC4Relationship,
): SoftwareMapRelationshipSnapshot {
  return {
    id: relationship.id,
    from: relationship.from,
    to: relationship.to,
    label: relationship.count > 1 ? undefined : relationship.label,
    semanticKind: relationship.semanticKind,
    kind: relationship.kind,
    hideLabel: relationship.hideLabel,
    fromSchemaFieldPath: relationship.fromSchemaFieldPath,
    toSchemaFieldPath: relationship.toSchemaFieldPath,
    fromSchemaEndpointKind: relationship.fromSchemaEndpointKind,
    toSchemaEndpointKind: relationship.toSchemaEndpointKind,
  };
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

export async function runInlineC4Layout(
  nodes: SoftwareMapNodeSnapshot[],
  relationships: SoftwareMapRelationshipSnapshot[],
  nodeDimensions?: ReadonlyMap<string, C4NodeDimensions>,
  previousLayout?: InlineC4LayoutResult,
  wasmUrl?: string,
): Promise<{ layout: C4LayoutResult; inlineLayout: InlineC4LayoutResult }> {
  const layout = await runC4LocalInflateLayout(
    nodes,
    relationships,
    nodeDimensions,
    previousLayout ?? c4EmptyInlineLayout(),
    wasmUrl,
  );
  return {
    inlineLayout: inlineLayoutFromC4Layout(layout),
    layout,
  };
}

function c4EmptyInlineLayout(): InlineC4LayoutResult {
  return {
    nodeBboxes: new Map(),
    groupBboxes: new Map(),
    childLayoutKeys: new Map(),
  };
}

function inlineLayoutFromC4Layout(
  layout: C4LayoutResult,
): InlineC4LayoutResult {
  return {
    nodeBboxes: new Map(
      layout.nodes
        .filter((entry) => !entry.expandedGroup)
        .map((entry) => [
          entry.node.id,
          {
            x: entry.x,
            y: entry.y,
            width: entry.width,
            height: entry.height,
          },
        ]),
    ),
    groupBboxes: new Map(
      layout.nodes
        .filter((entry) => entry.expandedGroup)
        .map((entry) => [
          entry.node.id,
          {
            x: entry.x,
            y: entry.y,
            width: entry.width,
            height: entry.height,
          },
        ]),
    ),
    childLayoutKeys: new Map(),
  };
}

export async function createC4MapFlow(
  snapshot: SoftwareMapResolvedSnapshot,
  options: {
    viewName?: string;
    diagram?: string;
    onSelectNode?: (node: SoftwareMapNodeSnapshot) => void;
    onExpandNode?: (node: SoftwareMapNodeSnapshot) => void;
    onCollapseNode?: (node: SoftwareMapNodeSnapshot) => void;
    onDrillNode?: (node: SoftwareMapNodeSnapshot) => void;
    nodeDimensions?: ReadonlyMap<string, C4NodeDimensions>;
    relationshipStateById?: ReadonlyMap<string, "active" | "inactive">;
  } = {},
): Promise<{ nodes: C4MapAnyFlowNode[]; edges: ReactFlowEdge[] }> {
  const { layout } = await runInlineC4Layout(
    snapshot.nodes ?? [],
    snapshot.relationships ?? [],
    options.nodeDimensions,
  );
  return createC4MapFlowFromLayout(snapshot, layout, options);
}

export interface C4MapFlow {
  nodes: C4MapAnyFlowNode[];
  edges: ReactFlowEdge[];
}

export function createC4MapFlowFromLayout(
  snapshot: SoftwareMapResolvedSnapshot,
  layout: C4LayoutResult,
  options: {
    viewName?: string;
    diagram?: string;
    onSelectNode?: (node: SoftwareMapNodeSnapshot) => void;
    onExpandNode?: (node: SoftwareMapNodeSnapshot) => void;
    onCollapseNode?: (node: SoftwareMapNodeSnapshot) => void;
    onDrillNode?: (node: SoftwareMapNodeSnapshot) => void;
    nodeDimensions?: ReadonlyMap<string, C4NodeDimensions> | null;
    relationshipStateById?: ReadonlyMap<string, "active" | "inactive">;
    onOpenRelationship?: (relationshipId: string) => void;
  } = {},
): C4MapFlow {
  const viewName = options.viewName ?? snapshot.view ?? "unresolved";
  const diagram = options.diagram ?? viewName;
  const latestNodesById = new Map(
    (snapshot.nodes ?? []).map((node) => [node.id, node]),
  );
  const flowNodes = layout.nodes.map(
    ({ node, x, y, width, height, expandedGroup }) => {
      const renderNode = latestNodesById.get(node.id) ?? node;
      const measured = options.nodeDimensions?.get(renderNode.id);
      const renderedWidth = Math.max(width, measured?.width ?? 0);
      const renderedHeight = Math.max(height, measured?.height ?? 0);
      const baseFlowNode = {
        id: renderNode.id,
        position: { x, y },
        width: renderedWidth,
        height: renderedHeight,
        data: {
          node: renderNode,
          selected: snapshot.selectedNodeId === renderNode.id,
          diagram,
          targetPath: softwareMapNodeLabelPath(renderNode, latestNodesById),
          onSelect: options.onSelectNode,
          onExpandNode: options.onExpandNode,
          onCollapseNode: options.onCollapseNode,
          onDrillNode: options.onDrillNode,
        },
        draggable: false,
        selectable: true,
        domAttributes: softwareMapKeyboardNodeDomAttributes(renderNode.id),
        style: { width: renderedWidth, height: renderedHeight },
      };
      return expandedGroup
        ? {
            ...baseFlowNode,
            type: "softwareMapC4Group" as const,
            zIndex: 0,
          }
        : {
            ...baseFlowNode,
            type: "softwareMapC4" as const,
            zIndex: 2,
          };
    },
  );
  const nodeIds = new Set(flowNodes.map((node) => node.id));
  const nodeTypes = new Map(
    (snapshot.nodes ?? []).map((node) => [node.id, node.type]),
  );
  const nodeBounds = new Map(
    flowNodes.map((node) => [
      node.id,
      {
        x: node.position.x,
        y: node.position.y,
        width: node.width,
        height: node.height,
      },
    ]),
  );

  const flowEdges: ReactFlowEdge[] = (snapshot.relationships ?? []).flatMap(
    (relationship, index) => {
      if (!nodeIds.has(relationship.from) || !nodeIds.has(relationship.to)) {
        return [];
      }
      const kind = relationship.kind ?? "semantic";
      const sourceNodeType = nodeTypes.get(relationship.from);
      const targetNodeType = nodeTypes.get(relationship.to);
      const attachedToSelectedNode =
        snapshot.selectedNodeId === relationship.from ||
        snapshot.selectedNodeId === relationship.to;
      const edgeId = c4RelationshipEdgeId(relationship, index);
      const relationshipId = relationship.id ?? edgeId;
      const operationState = options.relationshipStateById?.get(relationshipId);
      const operationHighlightState =
        operationState && operationState !== "inactive"
          ? operationState
          : undefined;
      const operationActive = operationState === "active";
      const color = attachedToSelectedNode
        ? "var(--accent)"
        : operationActive
          ? "var(--selection)"
          : c4EdgeColor();
      const label = relationship.hideLabel
        ? undefined
        : (relationship.label ?? relationship.semanticKind);
      const sections = layout.edgeSections.get(edgeId);
      if (!sections || sections.length === 0) return [];
      const labelDimensions = label
        ? estimateC4EdgeLabelDimensions(label)
        : undefined;
      const labelFallbackPoints = c4EdgePointsFromSections(sections);
      const handles = c4EdgeHandles(
        nodeBounds.get(relationship.from),
        nodeBounds.get(relationship.to),
        sections,
      );
      return [
        {
          id: edgeId,
          source: relationship.from,
          target: relationship.to,
          sourceHandle: handles.sourceHandle,
          targetHandle: handles.targetHandle,
          type: "softwareMapC4Edge",
          markerEnd: { type: MarkerType.ArrowClosed, color },
          label,
          className: [
            "software-map-c4-edge",
            `software-map-c4-edge--${kind}`,
            attachedToSelectedNode ? "software-map-c4-edge--selected-node" : "",
            operationHighlightState
              ? `software-map-c4-edge--operation-${operationHighlightState}`
              : "",
          ]
            .filter(Boolean)
            .join(" "),
          zIndex: operationActive ? 4 : attachedToSelectedNode ? 3 : 1,
          style: {
            stroke: color,
            strokeWidth: operationActive ? 3 : attachedToSelectedNode ? 2.5 : 2,
            strokeDasharray: c4EdgeDasharray(
              kind,
              sourceNodeType,
              targetNodeType,
            ),
            strokeLinecap:
              kind === "implied" ||
              (kind === "semantic" &&
                c4EdgeUsesCodeLevelDash(sourceNodeType, targetNodeType))
                ? "round"
                : undefined,
          },
          data: {
            label,
            semanticKind: relationship.semanticKind,
            relationship,
            relationshipId,
            selectedNodeAttached: attachedToSelectedNode,
            diagram,
            targetPath: softwareMapRelationshipLabelPath(
              relationship,
              snapshot.relationships ?? [],
              latestNodesById,
            ),
            sections,
            labelPosition: layout.edgeLabels.get(edgeId),
            labelDimensions,
            labelPoint: label
              ? c4EdgeLabelPoint(
                  layout.edgeLabels.get(edgeId),
                  labelDimensions,
                  labelFallbackPoints,
                )
              : undefined,
            operationState,
            onOpenRelationship: options.onOpenRelationship,
          },
          interactionWidth: 18,
        },
      ];
    },
  );
  return { nodes: flowNodes, edges: flowEdges };
}

export function focusC4MapNode(
  flow: ReactFlowInstance<C4MapAnyFlowNode, ReactFlowEdge> | null,
  node: C4MapAnyFlowNode,
) {
  if (!flow) return false;
  const bounds = {
    x: node.position.x,
    y: node.position.y,
    width: c4FlowNodeWidth(node),
    height: c4FlowNodeHeight(node),
  };
  void flow.fitBounds(bounds, {
    padding: C4_SELECTED_NODE_FOCUS_PADDING,
    duration: C4_SELECTED_NODE_FOCUS_DURATION_MS,
  });
  return true;
}

export function focusC4MapNodeAndKeyboard(
  flow: ReactFlowInstance<C4MapAnyFlowNode, ReactFlowEdge> | null,
  node: C4MapAnyFlowNode,
  keyboardTarget: HTMLElement | null,
  focusKeyboardTarget: (
    element: HTMLElement | null,
  ) => void = focusSoftwareMapKeyboardTarget,
) {
  if (!focusC4MapNode(flow, node)) return false;
  focusKeyboardTarget(keyboardTarget);
  return true;
}

export function fitC4MapView(
  flow: Pick<
    ReactFlowInstance<C4MapAnyFlowNode, ReactFlowEdge>,
    "fitView"
  > | null,
) {
  if (!flow) return false;
  void flow.fitView({
    padding: C4_FIT_VIEW_PADDING,
    duration: C4_FIT_VIEW_DURATION_MS,
  });
  return true;
}

function revealC4MapNode(
  flow: ReactFlowInstance<C4MapAnyFlowNode, ReactFlowEdge> | null,
  viewportElement: HTMLElement | null,
  node: C4MapAnyFlowNode,
) {
  if (!flow || !viewportElement) return false;
  const nextViewport = c4ViewportForNodeReveal({
    nodeBounds: {
      x: node.position.x,
      y: node.position.y,
      width: c4FlowNodeWidth(node),
      height: c4FlowNodeHeight(node),
    },
    viewport: flow.getViewport(),
    viewportSize: {
      width: viewportElement.clientWidth,
      height: viewportElement.clientHeight,
    },
    padding: C4_NAV_NODE_REVEAL_PADDING_PX,
    minZoom: C4_FLOW_MIN_ZOOM,
    maxZoom: C4_FLOW_MAX_ZOOM,
  });
  if (!nextViewport) return false;
  void flow.setViewport(nextViewport, {
    duration: C4_NAV_NODE_REVEAL_DURATION_MS,
  });
  return true;
}

export function c4ViewportForNodeReveal(input: {
  nodeBounds: { x: number; y: number; width: number; height: number };
  viewport: Viewport;
  viewportSize: { width: number; height: number };
  padding?: number;
  minZoom?: number;
  maxZoom?: number;
}): Viewport | null {
  const padding = Math.max(0, input.padding ?? 0);
  const minZoom = input.minZoom ?? C4_FLOW_MIN_ZOOM;
  const maxZoom = input.maxZoom ?? C4_FLOW_MAX_ZOOM;
  const { nodeBounds, viewport, viewportSize } = input;
  if (
    !c4FinitePositive(viewport.zoom) ||
    !c4FinitePositive(viewportSize.width) ||
    !c4FinitePositive(viewportSize.height) ||
    !c4FinitePositive(nodeBounds.width) ||
    !c4FinitePositive(nodeBounds.height)
  ) {
    return null;
  }

  const availableWidth = Math.max(1, viewportSize.width - padding * 2);
  const availableHeight = Math.max(1, viewportSize.height - padding * 2);
  const targetZoom = Math.max(
    minZoom,
    Math.min(
      maxZoom,
      viewport.zoom,
      availableWidth / nodeBounds.width,
      availableHeight / nodeBounds.height,
    ),
  );
  const currentCenter = {
    x: (viewportSize.width / 2 - viewport.x) / viewport.zoom,
    y: (viewportSize.height / 2 - viewport.y) / viewport.zoom,
  };
  const next = {
    x: viewportSize.width / 2 - currentCenter.x * targetZoom,
    y: viewportSize.height / 2 - currentCenter.y * targetZoom,
    zoom: targetZoom,
  };

  c4RevealAxis({
    next,
    axis: "x",
    nodeStart: nodeBounds.x,
    nodeSize: nodeBounds.width,
    viewportSize: viewportSize.width,
    padding,
  });
  c4RevealAxis({
    next,
    axis: "y",
    nodeStart: nodeBounds.y,
    nodeSize: nodeBounds.height,
    viewportSize: viewportSize.height,
    padding,
  });

  if (
    Math.abs(next.x - viewport.x) < 0.5 &&
    Math.abs(next.y - viewport.y) < 0.5 &&
    Math.abs(next.zoom - viewport.zoom) < 0.001
  ) {
    return null;
  }
  return next;
}

function c4RevealAxis(input: {
  next: Viewport;
  axis: "x" | "y";
  nodeStart: number;
  nodeSize: number;
  viewportSize: number;
  padding: number;
}) {
  const screenStart =
    input.nodeStart * input.next.zoom + input.next[input.axis];
  const screenEnd =
    (input.nodeStart + input.nodeSize) * input.next.zoom +
    input.next[input.axis];
  const visibleStart = input.padding;
  const visibleEnd = input.viewportSize - input.padding;

  if (screenEnd - screenStart > visibleEnd - visibleStart) {
    input.next[input.axis] =
      input.viewportSize / 2 -
      (input.nodeStart + input.nodeSize / 2) * input.next.zoom;
  } else if (screenStart < visibleStart) {
    input.next[input.axis] += visibleStart - screenStart;
  } else if (screenEnd > visibleEnd) {
    input.next[input.axis] -= screenEnd - visibleEnd;
  }
}

function c4FinitePositive(value: number) {
  return Number.isFinite(value) && value > 0;
}

/** ResizeObserver is missing in jsdom; the canvas then fits once on mount. */
function hasResizeObserver(): boolean {
  return typeof ResizeObserver !== "undefined";
}

function c4FlowNodeWidth(node: C4MapAnyFlowNode): number {
  return (
    numericStyleDimension(node.style?.width) ??
    node.width ??
    node.measured?.width ??
    C4_NODE_WIDTH
  );
}

function c4FlowNodeHeight(node: C4MapAnyFlowNode): number {
  return (
    numericStyleDimension(node.style?.height) ??
    node.height ??
    node.measured?.height ??
    C4_MIN_NODE_HEIGHT
  );
}

/** The leading number of a CSS dimension (`240` or `"240px"`), if any. */
function numericStyleDimension(
  value: CSSProperties["width"] | CSSProperties["height"],
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function c4PreviousLayoutCenters(
  previousLayout?: InlineC4LayoutResult,
): Map<string, C4ElkPoint> {
  const centers = new Map<string, C4ElkPoint>();
  if (!previousLayout) return centers;
  // groupBboxes second so an expanded node's outer footprint wins.
  for (const boxes of [previousLayout.nodeBboxes, previousLayout.groupBboxes]) {
    for (const [id, box] of boxes) {
      centers.set(id, {
        x: box.x + box.width / 2,
        y: box.y + box.height / 2,
      });
    }
  }
  return centers;
}

function c4PreviousLayoutBoxes(
  previousLayout?: InlineC4LayoutResult,
): Map<string, C4LayoutBox> {
  const boxesById = new Map<string, C4LayoutBox>();
  if (!previousLayout) return boxesById;
  // groupBboxes second so an expanded node's outer footprint wins.
  for (const boxes of [previousLayout.nodeBboxes, previousLayout.groupBboxes]) {
    for (const [id, box] of boxes) {
      boxesById.set(id, box);
    }
  }
  return boxesById;
}

function compareC4NodesForLayout(
  left: SoftwareMapNodeSnapshot,
  right: SoftwareMapNodeSnapshot,
  previousCenters: ReadonlyMap<string, C4ElkPoint>,
  axis: C4LayoutAxis,
) {
  const leftCenter = previousCenters.get(left.id);
  const rightCenter = previousCenters.get(right.id);
  if (leftCenter && rightCenter) {
    const crossAxis: C4LayoutAxis =
      axis === "horizontal" ? "vertical" : "horizontal";
    return (
      c4PointAxisCoordinate(leftCenter, axis) -
        c4PointAxisCoordinate(rightCenter, axis) ||
      c4PointAxisCoordinate(leftCenter, crossAxis) -
        c4PointAxisCoordinate(rightCenter, crossAxis) ||
      left.label.localeCompare(right.label)
    );
  }
  if (leftCenter || rightCenter) return leftCenter ? -1 : 1;
  return (
    TYPE_ORDER[left.type] - TYPE_ORDER[right.type] ||
    left.label.localeCompare(right.label)
  );
}

function c4PreviousProxyCenter(
  nodeId: string,
  nodesById: ReadonlyMap<string, SoftwareMapNodeSnapshot>,
  previousCenters: ReadonlyMap<string, C4ElkPoint>,
): C4ElkPoint | null {
  // Newly revealed children have no previous position; fall back to the
  // closest ancestor that does (e.g. the group that just expanded).
  let currentId: string | undefined | null = nodeId;
  while (currentId) {
    const center = previousCenters.get(currentId);
    if (center) return center;
    currentId = nodesById.get(currentId)?.parentId;
  }
  return null;
}

function reverseC4ElkSections(
  sections: readonly C4ElkEdgeSection[],
): C4ElkEdgeSection[] {
  return [...sections].reverse().map((section) => ({
    ...section,
    startPoint: section.endPoint,
    bendPoints: section.bendPoints
      ? [...section.bendPoints].reverse()
      : undefined,
    endPoint: section.startPoint,
  }));
}

interface C4LocalInflateContext {
  nodes: SoftwareMapNodeSnapshot[];
  nodesById: ReadonlyMap<string, SoftwareMapNodeSnapshot>;
  childIdsByParentId: ReadonlyMap<string, readonly string[]>;
  relationships: SoftwareMapRelationshipSnapshot[];
  nodeDimensions?: ReadonlyMap<string, C4NodeDimensions>;
  previousCenters: ReadonlyMap<string, C4ElkPoint>;
  previousBoxes: ReadonlyMap<string, C4LayoutBox>;
  previousExpandedNodeIds: ReadonlySet<string>;
}

interface C4LocalLayoutResult {
  entries: C4LayoutEntry[];
  bbox: C4LayoutBox;
}

interface C4LocalLayoutUnit {
  node: SoftwareMapNodeSnapshot;
  seed: C4ElkPoint;
  width: number;
  height: number;
  rowGroupingHeight: number;
  previousBox?: C4LayoutBox;
  childLayout?: C4LocalLayoutResult;
}

async function runC4LocalInflateLayout(
  nodes: SoftwareMapNodeSnapshot[],
  relationships: SoftwareMapRelationshipSnapshot[],
  nodeDimensions: ReadonlyMap<string, C4NodeDimensions> | undefined,
  previousLayout: InlineC4LayoutResult,
  wasmUrl?: string,
): Promise<C4LayoutResult> {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const childIdsByParentId = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.parentId || !nodesById.has(node.parentId)) continue;
    const children = childIdsByParentId.get(node.parentId) ?? [];
    children.push(node.id);
    childIdsByParentId.set(node.parentId, children);
  }

  const layout = await layoutC4LocalInflateLevel(null, {
    nodes,
    nodesById,
    childIdsByParentId,
    relationships,
    nodeDimensions,
    previousCenters: c4PreviousLayoutCenters(previousLayout),
    previousBoxes: c4PreviousLayoutBoxes(previousLayout),
    previousExpandedNodeIds: new Set(previousLayout.groupBboxes.keys()),
  });

  return routeC4FixedLayoutEdges(layout.entries, relationships, wasmUrl);
}

async function layoutC4LocalInflateLevel(
  parentId: string | null,
  context: C4LocalInflateContext,
): Promise<C4LocalLayoutResult> {
  const childIds = c4LocalVisibleChildIds(parentId, context);
  if (childIds.length === 0) return c4EmptyLocalLayout();

  const isolatedLayout = await c4LocalIsolatedLayout(
    parentId,
    childIds,
    context,
  );
  if (
    parentId &&
    isolatedLayout &&
    childIds.every((childId) => !context.previousCenters.has(childId)) &&
    childIds.every((childId) => {
      const child = context.nodesById.get(childId);
      return (
        !child?.expanded ||
        (context.childIdsByParentId.get(childId)?.length ?? 0) === 0
      );
    })
  ) {
    return isolatedLayout;
  }
  const fallbackCenters = c4CentersFromLayoutEntries(
    isolatedLayout?.entries ?? [],
  );
  const units: C4LocalLayoutUnit[] = [];
  for (const childId of childIds) {
    const node = context.nodesById.get(childId);
    if (!node) continue;
    const childLayout =
      node.expanded &&
      (context.childIdsByParentId.get(node.id)?.length ?? 0) > 0
        ? await layoutC4LocalInflateLevel(node.id, context)
        : undefined;
    const seed =
      context.previousCenters.get(node.id) ??
      fallbackCenters.get(node.id) ??
      c4LocalFallbackPoint(units.length);
    const dimensions = c4MeasuredNodeDimensions(node, context.nodeDimensions);
    const width = childLayout
      ? Math.max(
          dimensions.width +
            C4_LOCAL_GROUP_PADDING.left +
            C4_LOCAL_GROUP_PADDING.right,
          childLayout.bbox.width +
            C4_LOCAL_GROUP_PADDING.left +
            C4_LOCAL_GROUP_PADDING.right,
        )
      : dimensions.width;
    const height = childLayout
      ? Math.max(
          dimensions.height +
            C4_LOCAL_GROUP_PADDING.top +
            C4_LOCAL_GROUP_PADDING.bottom,
          childLayout.bbox.height +
            C4_LOCAL_GROUP_PADDING.top +
            C4_LOCAL_GROUP_PADDING.bottom,
        )
      : dimensions.height;
    const previousBox = context.previousBoxes.get(node.id);
    units.push({
      node,
      seed,
      width,
      height,
      previousBox,
      rowGroupingHeight: Math.min(previousBox?.height ?? height, height),
      childLayout,
    });
  }

  const placements = packC4LocalInflateUnits(
    units,
    c4LocalInflateAnchorId(units, context.previousExpandedNodeIds),
  );
  const entries = units.flatMap((unit) => {
    const placement = placements.get(unit.node.id);
    if (!placement) return [];
    if (!unit.childLayout) {
      return [
        {
          node: unit.node,
          x: placement.x,
          y: placement.y,
          width: unit.width,
          height: unit.height,
        },
      ];
    }

    const childTarget = {
      x: placement.x + C4_LOCAL_GROUP_PADDING.left,
      y: placement.y + C4_LOCAL_GROUP_PADDING.top,
    };
    const childOffset = {
      x: childTarget.x - unit.childLayout.bbox.x,
      y: childTarget.y - unit.childLayout.bbox.y,
    };
    return [
      {
        node: unit.node,
        x: placement.x,
        y: placement.y,
        width: unit.width,
        height: unit.height,
        expandedGroup: true,
      },
      ...unit.childLayout.entries.map((entry) => ({
        ...entry,
        x: entry.x + childOffset.x,
        y: entry.y + childOffset.y,
      })),
    ];
  });

  return { entries, bbox: c4LayoutEntriesBbox(entries) };
}

function c4LocalVisibleChildIds(
  parentId: string | null,
  context: C4LocalInflateContext,
): string[] {
  if (parentId) return [...(context.childIdsByParentId.get(parentId) ?? [])];
  return context.nodes
    .filter((node) => {
      if (!node.parentId) return true;
      const parent = context.nodesById.get(node.parentId);
      return !parent?.expanded;
    })
    .map((node) => node.id);
}

async function c4LocalIsolatedLayout(
  parentId: string | null,
  childIds: readonly string[],
  context: C4LocalInflateContext,
): Promise<C4LocalLayoutResult | null> {
  if (childIds.every((childId) => context.previousCenters.has(childId))) {
    return null;
  }

  const childIdSet = new Set(childIds);
  const childNodes = childIds
    .map((childId) => context.nodesById.get(childId))
    .filter((node): node is SoftwareMapNodeSnapshot => Boolean(node));
  const childRelationships = c4LocalProjectedRelationships(
    parentId,
    childIds,
    context,
  );
  const isolated = await runC4ElkLayout(
    childNodes,
    childRelationships,
    context.nodeDimensions,
    {
      axis: c4ChildLayoutAxis(
        parentId ? context.nodesById.get(parentId) : undefined,
      ),
    },
  );
  const isolatedBbox = c4LayoutEntriesBbox(isolated.nodes);
  const isolatedCenter = {
    x: isolatedBbox.x + isolatedBbox.width / 2,
    y: isolatedBbox.y + isolatedBbox.height / 2,
  };
  const parentCenter = parentId
    ? (context.previousCenters.get(parentId) ?? isolatedCenter)
    : isolatedCenter;
  const offset = {
    x: parentCenter.x - isolatedCenter.x,
    y: parentCenter.y - isolatedCenter.y,
  };
  const entries = isolated.nodes
    .filter((entry) => childIdSet.has(entry.node.id))
    .map((entry) => ({
      ...entry,
      x: entry.x + offset.x,
      y: entry.y + offset.y,
    }));
  return { entries, bbox: c4LayoutEntriesBbox(entries) };
}

function c4LocalProjectedRelationships(
  parentId: string | null,
  childIds: readonly string[],
  context: C4LocalInflateContext,
): SoftwareMapRelationshipSnapshot[] {
  const childIdSet = new Set(childIds);
  return context.relationships.flatMap((relationship, index) => {
    const from = c4LocalChildProxyId(
      relationship.from,
      childIdSet,
      context.nodesById,
    );
    const to = c4LocalChildProxyId(
      relationship.to,
      childIdSet,
      context.nodesById,
    );
    if (!from || !to || from === to) return [];
    // A proxied endpoint is an ancestor of the original node, so schema
    // endpoints (which name field rows on the original node) no longer apply.
    const proxied: SoftwareMapRelationshipSnapshot = {
      ...relationship,
      id: `layout:${parentId ?? "root"}:${relationship.id ?? index}`,
      from,
      to,
      hideLabel: true,
    };
    if (from !== relationship.from) {
      proxied.fromSchemaEndpointKind = undefined;
      proxied.fromSchemaFieldPath = undefined;
    }
    if (to !== relationship.to) {
      proxied.toSchemaEndpointKind = undefined;
      proxied.toSchemaFieldPath = undefined;
    }
    return [proxied];
  });
}

function c4LocalChildProxyId(
  nodeId: string,
  childIds: ReadonlySet<string>,
  nodesById: ReadonlyMap<string, SoftwareMapNodeSnapshot>,
): string | null {
  const visited = new Set<string>();
  let currentId: string | null | undefined = nodeId;
  while (currentId && !visited.has(currentId)) {
    if (childIds.has(currentId)) return currentId;
    visited.add(currentId);
    currentId = nodesById.get(currentId)?.parentId;
  }
  return null;
}

function c4CentersFromLayoutEntries(
  entries: readonly C4LayoutEntry[],
): Map<string, C4ElkPoint> {
  return new Map(
    entries.map((entry) => [
      entry.node.id,
      {
        x: entry.x + entry.width / 2,
        y: entry.y + entry.height / 2,
      },
    ]),
  );
}

function c4LocalInflateAnchorId(
  units: readonly C4LocalLayoutUnit[],
  previousExpandedNodeIds: ReadonlySet<string>,
): string | null {
  const toggledUnits = units
    .filter(
      (unit) =>
        Boolean(unit.node.expanded) !==
        previousExpandedNodeIds.has(unit.node.id),
    )
    .sort(c4LocalUnitSeedOrder);
  if (toggledUnits[0]) return toggledUnits[0].node.id;

  const resizedUnits = units
    .filter(c4LocalUnitFootprintChanged)
    .sort(c4LocalUnitSeedOrder);
  return resizedUnits[0]?.node.id ?? null;
}

function packC4LocalInflateUnits(
  units: readonly C4LocalLayoutUnit[],
  anchorId: string | null = null,
) {
  const localPlacements = placeC4LocalInflateUnits(units, anchorId);
  if (localPlacements) return localPlacements;

  const placements = new Map<string, C4LayoutBox>();
  if (units.length === 0) return placements;

  const rows: Array<{
    units: C4LocalLayoutUnit[];
    centerY: number;
    minY: number;
    maxY: number;
    height: number;
    y: number;
  }> = [];
  for (const unit of [...units].sort(c4LocalUnitSeedOrder)) {
    const unitMinY = unit.seed.y - unit.rowGroupingHeight / 2;
    const unitMaxY = unit.seed.y + unit.rowGroupingHeight / 2;
    const row = rows.find(
      (candidate) =>
        Math.abs(unit.seed.y - candidate.centerY) <= C4_LOCAL_ROW_CLUSTER_GAP,
    );
    if (row) {
      row.units.push(unit);
      row.centerY =
        row.units.reduce((sum, next) => sum + next.seed.y, 0) /
        row.units.length;
      row.minY = Math.min(row.minY, unitMinY);
      row.maxY = Math.max(row.maxY, unitMaxY);
    } else {
      rows.push({
        units: [unit],
        centerY: unit.seed.y,
        minY: unitMinY,
        maxY: unitMaxY,
        height: 0,
        y: 0,
      });
    }
  }

  rows.sort((left, right) => left.centerY - right.centerY);
  for (const row of rows) {
    row.height = Math.max(...row.units.map((unit) => unit.height));
  }
  const anchorRowIndex = rows.findIndex((row) =>
    row.units.some((unit) => unit.node.id === anchorId),
  );
  if (anchorRowIndex >= 0) {
    const anchorUnit = rows[anchorRowIndex]?.units.find(
      (unit) => unit.node.id === anchorId,
    );
    const anchorRow = rows[anchorRowIndex];
    if (anchorUnit && anchorRow) {
      anchorRow.y = anchorUnit.seed.y - anchorRow.height / 2;
      for (let index = anchorRowIndex - 1; index >= 0; index -= 1) {
        const nextRow = rows[index + 1]!;
        const row = rows[index]!;
        row.y = nextRow.y - C4_LOCAL_SIBLING_Y_GAP - row.height;
      }
      for (let index = anchorRowIndex + 1; index < rows.length; index += 1) {
        const previousRow = rows[index - 1]!;
        const row = rows[index]!;
        row.y = previousRow.y + previousRow.height + C4_LOCAL_SIBLING_Y_GAP;
      }
    }
  } else {
    const rowHeights = rows.map((row) => row.height);
    const totalHeight =
      rowHeights.reduce((sum, height) => sum + height, 0) +
      Math.max(0, rows.length - 1) * C4_LOCAL_SIBLING_Y_GAP;
    const levelCenterY =
      units.reduce((sum, unit) => sum + unit.seed.y, 0) / units.length;
    let y = levelCenterY - totalHeight / 2;
    for (const row of rows) {
      row.y = y;
      y += row.height + C4_LOCAL_SIBLING_Y_GAP;
    }
  }

  for (const row of rows) {
    const sortedUnits = [...row.units].sort(
      (left, right) =>
        left.seed.x - right.seed.x || left.node.id.localeCompare(right.node.id),
    );
    const anchorIndex = sortedUnits.findIndex(
      (unit) => unit.node.id === anchorId,
    );
    if (anchorIndex >= 0) {
      const anchorUnit = sortedUnits[anchorIndex]!;
      const anchorX = anchorUnit.seed.x - anchorUnit.width / 2;
      placements.set(anchorUnit.node.id, {
        x: anchorX,
        y: row.y + (row.height - anchorUnit.height) / 2,
        width: anchorUnit.width,
        height: anchorUnit.height,
      });

      let leftCursor = anchorX;
      for (let index = anchorIndex - 1; index >= 0; index -= 1) {
        const unit = sortedUnits[index]!;
        leftCursor -= C4_LOCAL_SIBLING_X_GAP + unit.width;
        placements.set(unit.node.id, {
          x: leftCursor,
          y: row.y + (row.height - unit.height) / 2,
          width: unit.width,
          height: unit.height,
        });
      }

      let rightCursor = anchorX + anchorUnit.width;
      for (
        let index = anchorIndex + 1;
        index < sortedUnits.length;
        index += 1
      ) {
        const unit = sortedUnits[index]!;
        const x = rightCursor + C4_LOCAL_SIBLING_X_GAP;
        placements.set(unit.node.id, {
          x,
          y: row.y + (row.height - unit.height) / 2,
          width: unit.width,
          height: unit.height,
        });
        rightCursor = x + unit.width;
      }
    } else {
      const totalWidth =
        sortedUnits.reduce((sum, unit) => sum + unit.width, 0) +
        Math.max(0, sortedUnits.length - 1) * C4_LOCAL_SIBLING_X_GAP;
      const rowCenterX =
        sortedUnits.reduce((sum, unit) => sum + unit.seed.x, 0) /
        sortedUnits.length;
      let x = rowCenterX - totalWidth / 2;
      for (const unit of sortedUnits) {
        placements.set(unit.node.id, {
          x,
          y: row.y + (row.height - unit.height) / 2,
          width: unit.width,
          height: unit.height,
        });
        x += unit.width + C4_LOCAL_SIBLING_X_GAP;
      }
    }
  }

  return placements;
}

function c4LocalUnitFootprintChanged(unit: C4LocalLayoutUnit): boolean {
  if (!unit.previousBox) return false;
  return (
    Math.abs(unit.width - unit.previousBox.width) > 1 ||
    Math.abs(unit.height - unit.previousBox.height) > 1
  );
}

function placeC4LocalInflateUnits(
  units: readonly C4LocalLayoutUnit[],
  anchorId: string | null,
): Map<string, C4LayoutBox> | null {
  if (!anchorId) return null;
  const anchor = units.find((unit) => unit.node.id === anchorId);
  if (!anchor?.previousBox) return null;

  const placements = new Map<string, C4LayoutBox>();
  const previousAnchor = anchor.previousBox;
  const nextAnchor = c4BoxCenteredAt(anchor.seed, anchor.width, anchor.height);
  const previousAnchorRight = previousAnchor.x + previousAnchor.width;
  const previousAnchorBottom = previousAnchor.y + previousAnchor.height;
  const nextAnchorRight = nextAnchor.x + nextAnchor.width;
  const nextAnchorBottom = nextAnchor.y + nextAnchor.height;
  const boundaryDelta = {
    left: nextAnchor.x - previousAnchor.x,
    right: nextAnchorRight - previousAnchorRight,
    top: nextAnchor.y - previousAnchor.y,
    bottom: nextAnchorBottom - previousAnchorBottom,
  };

  for (const unit of units) {
    let placement = c4BoxCenteredAt(unit.seed, unit.width, unit.height);
    if (unit.node.id === anchor.node.id) {
      placements.set(unit.node.id, nextAnchor);
      continue;
    }

    const delta = c4LocalInflateDeltaForUnit(
      unit,
      anchor.seed,
      previousAnchor,
      boundaryDelta,
    );

    placement = {
      ...placement,
      x: placement.x + delta.x,
      y: placement.y + delta.y,
    };
    placement = c4NudgeBoxOutsideAnchor(
      placement,
      nextAnchor,
      unit.seed,
      delta,
    );
    placements.set(unit.node.id, placement);
  }

  return placements;
}

function c4LocalInflateDeltaForUnit(
  unit: C4LocalLayoutUnit,
  anchorSeed: C4ElkPoint,
  previousAnchor: C4LayoutBox,
  boundaryDelta: { left: number; right: number; top: number; bottom: number },
): C4ElkPoint {
  const previousAnchorRight = previousAnchor.x + previousAnchor.width;
  const previousAnchorBottom = previousAnchor.y + previousAnchor.height;
  const outsideLeft = unit.seed.x < previousAnchor.x;
  const outsideRight = unit.seed.x > previousAnchorRight;
  const outsideTop = unit.seed.y < previousAnchor.y;
  const outsideBottom = unit.seed.y > previousAnchorBottom;
  const horizontalDelta = outsideLeft
    ? boundaryDelta.left
    : outsideRight
      ? boundaryDelta.right
      : 0;
  const verticalDelta = outsideTop
    ? boundaryDelta.top
    : outsideBottom
      ? boundaryDelta.bottom
      : 0;
  if (horizontalDelta !== 0 || verticalDelta !== 0) {
    return { x: horizontalDelta, y: verticalDelta };
  }

  const normalizedDx =
    (unit.seed.x - anchorSeed.x) / Math.max(previousAnchor.width, 1);
  const normalizedDy =
    (unit.seed.y - anchorSeed.y) / Math.max(previousAnchor.height, 1);
  if (Math.abs(normalizedDx) >= Math.abs(normalizedDy)) {
    return {
      x:
        unit.seed.x < anchorSeed.x
          ? boundaryDelta.left
          : unit.seed.x > anchorSeed.x
            ? boundaryDelta.right
            : 0,
      y: 0,
    };
  }
  return {
    x: 0,
    y:
      unit.seed.y < anchorSeed.y
        ? boundaryDelta.top
        : unit.seed.y > anchorSeed.y
          ? boundaryDelta.bottom
          : 0,
  };
}

function c4BoxCenteredAt(
  center: C4ElkPoint,
  width: number,
  height: number,
): C4LayoutBox {
  return {
    x: center.x - width / 2,
    y: center.y - height / 2,
    width,
    height,
  };
}

function c4NudgeBoxOutsideAnchor(
  box: C4LayoutBox,
  anchor: C4LayoutBox,
  seed: C4ElkPoint,
  appliedDelta: C4ElkPoint,
): C4LayoutBox {
  const gap = Math.min(C4_LOCAL_SIBLING_X_GAP, C4_LOCAL_SIBLING_Y_GAP);
  const overlapX =
    Math.min(box.x + box.width, anchor.x + anchor.width) -
    Math.max(box.x, anchor.x);
  const overlapY =
    Math.min(box.y + box.height, anchor.y + anchor.height) -
    Math.max(box.y, anchor.y);
  if (overlapX <= 0 || overlapY <= 0) return box;

  const anchorCenter = {
    x: anchor.x + anchor.width / 2,
    y: anchor.y + anchor.height / 2,
  };
  const preferHorizontal =
    Math.abs(appliedDelta.x) > Math.abs(appliedDelta.y) ||
    (Math.abs(appliedDelta.x) === Math.abs(appliedDelta.y) &&
      Math.abs(seed.x - anchorCenter.x) >= Math.abs(seed.y - anchorCenter.y));
  if (preferHorizontal) {
    return {
      ...box,
      x:
        seed.x < anchorCenter.x
          ? anchor.x - gap - box.width
          : anchor.x + anchor.width + gap,
    };
  }
  return {
    ...box,
    y:
      seed.y < anchorCenter.y
        ? anchor.y - gap - box.height
        : anchor.y + anchor.height + gap,
  };
}

function c4LocalUnitSeedOrder(
  left: C4LocalLayoutUnit,
  right: C4LocalLayoutUnit,
) {
  return (
    left.seed.y - right.seed.y ||
    left.seed.x - right.seed.x ||
    left.node.id.localeCompare(right.node.id)
  );
}

function c4MeasuredNodeDimensions(
  node: SoftwareMapNodeSnapshot,
  nodeDimensions?: ReadonlyMap<string, C4NodeDimensions>,
): C4NodeDimensions {
  const measured = nodeDimensions?.get(node.id);
  return {
    width: c4PositiveDimension(measured?.width, C4_NODE_WIDTH),
    height: c4PositiveDimension(measured?.height, estimateC4NodeHeight(node)),
  };
}

function c4PositiveDimension(value: number | undefined, fallback: number) {
  return value !== undefined && c4FinitePositive(value) ? value : fallback;
}

function c4LocalFallbackPoint(index: number): C4ElkPoint {
  return {
    x: index * (C4_NODE_WIDTH + C4_LOCAL_SIBLING_X_GAP),
    y: 0,
  };
}

function c4EmptyLocalLayout(): C4LocalLayoutResult {
  return {
    entries: [],
    bbox: { x: 0, y: 0, width: 0, height: 0 },
  };
}

function c4LayoutEntriesBbox(entries: readonly C4LayoutEntry[]): C4LayoutBox {
  if (entries.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const minX = Math.min(...entries.map((entry) => entry.x));
  const minY = Math.min(...entries.map((entry) => entry.y));
  const maxX = Math.max(...entries.map((entry) => entry.x + entry.width));
  const maxY = Math.max(...entries.map((entry) => entry.y + entry.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

async function routeC4FixedLayoutEdges(
  layoutNodes: C4LayoutEntry[],
  relationships: SoftwareMapRelationshipSnapshot[],
  wasmUrl?: string,
): Promise<C4LayoutResult> {
  const nodeIds = new Set(layoutNodes.map((entry) => entry.node.id));
  const edgeRelationships = relationships
    .map((relationship, index) => ({
      relationship,
      edgeId: c4RelationshipEdgeId(relationship, index),
    }))
    .filter(
      ({ relationship }) =>
        nodeIds.has(relationship.from) && nodeIds.has(relationship.to),
    );

  if (edgeRelationships.length === 0) {
    return {
      nodes: layoutNodes,
      edgeSections: new Map(),
      edgeLabels: new Map(),
    };
  }

  await ensureC4LibavoidReady(wasmUrl);
  const routes = await routeC4FixedLayoutEdgeScopes(
    layoutNodes,
    edgeRelationships,
  );
  const edgeSections = new Map<string, C4ElkEdgeSection[]>();
  const edgeLabels = new Map<string, C4ElkLabel>();

  for (const { relationship, edgeId } of edgeRelationships) {
    const route = routes.get(edgeId);
    if (!route) continue;
    const section: C4ElkEdgeSection = {
      startPoint: route.sourcePoint,
      bendPoints: route.bendPoints.length > 0 ? route.bendPoints : undefined,
      endPoint: route.targetPoint,
    };
    edgeSections.set(edgeId, [section]);

    const label = relationship.hideLabel
      ? undefined
      : (relationship.label ?? relationship.semanticKind);
    if (label) {
      const labelDimensions = estimateC4EdgeLabelDimensions(label);
      const midpoint = c4PolylineMidpoint(c4EdgePointsFromSections([section]));
      edgeLabels.set(edgeId, {
        x: midpoint.x - labelDimensions.width / 2,
        y: midpoint.y - labelDimensions.height / 2,
        ...labelDimensions,
      });
    }
  }

  return {
    nodes: layoutNodes,
    edgeSections,
    edgeLabels: positionC4EdgeLabels(
      edgeSections,
      edgeLabels,
      c4EdgeLabelNodeObstacles(layoutNodes),
    ),
  };
}

// libavoid names two of its router options after "shapes" (its term for
// routing obstacles); the keys are spelled once here so the option object
// reads in this map's vocabulary.
const LIBAVOID_OBSTACLE_BUFFER_OPTION = "shapeBufferDistance";
const LIBAVOID_NUDGE_OBSTACLE_SEGMENTS_OPTION =
  "nudgeOrthogonalSegmentsConnectedToShapes";
const C4_LIBAVOID_ROUTING_OPTIONS = {
  routingType: "orthogonal",
  segmentPenalty: 10,
  [LIBAVOID_OBSTACLE_BUFFER_OPTION]: 14,
  idealNudgingDistance: 8,
  portDirectionPenalty: 100,
  [LIBAVOID_NUDGE_OBSTACLE_SEGMENTS_OPTION]: true,
  nudgeSharedPathsWithCommonEndPoint: true,
  performUnifyingNudgingPreprocessingStep: true,
  selfLoopHandling: "fallback",
} as const;
const C4_LIBAVOID_DENSE_EDGE_THRESHOLD = 48;
const C4_LIBAVOID_DENSE_EDGE_BATCH_SIZE = 16;

async function routeC4FixedLayoutEdgeScopes(
  layoutNodes: readonly C4LayoutEntry[],
  edgeRelationships: readonly {
    relationship: SoftwareMapRelationshipSnapshot;
    edgeId: string;
  }[],
) {
  const scopes = c4LibavoidRoutingScopes(layoutNodes, edgeRelationships);
  const routes = new Map<
    string,
    Awaited<ReturnType<typeof routeLibavoidEdges>> extends Map<
      string,
      infer TResult
    >
      ? TResult
      : never
  >();
  for (const scope of scopes) {
    if (scope.edgeRelationships.length === 0) continue;
    const scopedRoutes = await routeC4LibavoidScopeEdges(
      scope.layoutNodes,
      scope.edgeRelationships,
      scope.axis,
    );
    const entriesById = new Map(
      scope.layoutNodes.map((entry) => [entry.node.id, entry]),
    );
    const relationshipsByEdgeId = new Map(
      scope.edgeRelationships.map((edge) => [edge.edgeId, edge.relationship]),
    );
    for (const [edgeId, route] of scopedRoutes) {
      const relationship = relationshipsByEdgeId.get(edgeId);
      const source = relationship
        ? entriesById.get(relationship.from)
        : undefined;
      const target = relationship
        ? entriesById.get(relationship.to)
        : undefined;
      const orthogonalRoute = c4ValidOrthogonalRoute(route, source, target);
      if (orthogonalRoute) routes.set(edgeId, orthogonalRoute);
    }
  }
  return routes;
}

function c4ValidOrthogonalRoute<
  Route extends {
    sourcePoint: C4ElkPoint;
    targetPoint: C4ElkPoint;
    bendPoints: C4ElkPoint[];
  },
>(
  route: Route,
  source: C4LayoutEntry | undefined,
  target: C4LayoutEntry | undefined,
): Route | null {
  if (!source || !target) return null;
  const points = [route.sourcePoint, ...route.bendPoints, route.targetPoint];
  if (points.length < 2) return null;
  const normalized = [{ ...points[0]! }];
  for (const point of points.slice(1)) {
    const previous = normalized.at(-1)!;
    const next = { ...point };
    if (Math.abs(next.x - previous.x) <= 0.01) {
      next.x = previous.x;
    } else if (Math.abs(next.y - previous.y) <= 0.01) {
      next.y = previous.y;
    } else {
      return null;
    }
    normalized.push(next);
  }
  if (
    !c4PointOnBoxBorder(normalized[0]!, source) ||
    !c4PointOnBoxBorder(normalized.at(-1)!, target)
  ) {
    return null;
  }
  return {
    ...route,
    sourcePoint: normalized[0]!,
    bendPoints: normalized.slice(1, -1),
    targetPoint: normalized.at(-1)!,
  };
}

function c4PointOnBoxBorder(point: C4ElkPoint, box: C4LayoutBox) {
  const withinX =
    point.x >= box.x - 0.01 && point.x <= box.x + box.width + 0.01;
  const withinY =
    point.y >= box.y - 0.01 && point.y <= box.y + box.height + 0.01;
  return (
    (withinY &&
      (Math.abs(point.x - box.x) <= 0.01 ||
        Math.abs(point.x - (box.x + box.width)) <= 0.01)) ||
    (withinX &&
      (Math.abs(point.y - box.y) <= 0.01 ||
        Math.abs(point.y - (box.y + box.height)) <= 0.01))
  );
}

async function routeC4LibavoidScopeEdges(
  layoutNodes: readonly C4LayoutEntry[],
  edgeRelationships: readonly {
    relationship: SoftwareMapRelationshipSnapshot;
    edgeId: string;
  }[],
  axis: C4LayoutAxis,
) {
  if (edgeRelationships.length < C4_LIBAVOID_DENSE_EDGE_THRESHOLD) {
    return routeLibavoidEdges(
      c4FlatLibavoidGraphFromLayout(layoutNodes, edgeRelationships, axis),
      C4_LIBAVOID_ROUTING_OPTIONS,
    );
  }

  const routes = new Map<
    string,
    Awaited<ReturnType<typeof routeLibavoidEdges>> extends Map<
      string,
      infer TResult
    >
      ? TResult
      : never
  >();
  for (
    let startIndex = 0;
    startIndex < edgeRelationships.length;
    startIndex += C4_LIBAVOID_DENSE_EDGE_BATCH_SIZE
  ) {
    const batch = edgeRelationships.slice(
      startIndex,
      startIndex + C4_LIBAVOID_DENSE_EDGE_BATCH_SIZE,
    );
    const batchRoutes = await routeLibavoidEdges(
      c4FlatLibavoidGraphFromLayout(
        layoutNodes,
        batch,
        axis,
        edgeRelationships,
      ),
      C4_LIBAVOID_ROUTING_OPTIONS,
    );
    for (const [edgeId, route] of batchRoutes) {
      routes.set(edgeId, route);
    }
  }
  return routes;
}

function c4LibavoidRoutingScopes(
  layoutNodes: readonly C4LayoutEntry[],
  edgeRelationships: readonly {
    relationship: SoftwareMapRelationshipSnapshot;
    edgeId: string;
  }[],
) {
  const entriesById = new Map(
    layoutNodes.map((entry) => [entry.node.id, entry]),
  );
  const groupedEdges = new Map<
    string,
    Array<{
      relationship: SoftwareMapRelationshipSnapshot;
      edgeId: string;
    }>
  >();
  const globalEdges: Array<{
    relationship: SoftwareMapRelationshipSnapshot;
    edgeId: string;
  }> = [];

  const routingNodesForEdges = (
    entries: readonly C4LayoutEntry[],
    edges: readonly {
      relationship: SoftwareMapRelationshipSnapshot;
      edgeId: string;
    }[],
  ) => {
    const endpointIds = new Set(
      edges.flatMap(({ relationship }) => [relationship.from, relationship.to]),
    );
    return entries.filter(
      (entry) => !entry.expandedGroup || endpointIds.has(entry.node.id),
    );
  };

  for (const edge of edgeRelationships) {
    const scopeId = c4DeepestCommonExpandedAncestorId(
      edge.relationship.from,
      edge.relationship.to,
      entriesById,
    );
    if (!scopeId) {
      globalEdges.push(edge);
      continue;
    }
    const edges = groupedEdges.get(scopeId) ?? [];
    edges.push(edge);
    groupedEdges.set(scopeId, edges);
  }

  return [
    ...[...groupedEdges.entries()].map(([scopeId, edges]) => ({
      scopeId,
      axis: c4ChildLayoutAxis(entriesById.get(scopeId)?.node),
      edgeRelationships: edges,
      layoutNodes: routingNodesForEdges(
        layoutNodes.filter(
          (entry) =>
            entry.node.id !== scopeId &&
            c4IsLayoutDescendantOf(entry.node.id, scopeId, entriesById),
        ),
        edges,
      ),
    })),
    {
      scopeId: null,
      axis: c4ChildLayoutAxis(),
      edgeRelationships: globalEdges,
      layoutNodes: routingNodesForEdges(layoutNodes, globalEdges),
    },
  ].filter((scope) =>
    scope.edgeRelationships.every(
      ({ relationship }) =>
        scope.layoutNodes.some(
          (entry) => entry.node.id === relationship.from,
        ) &&
        scope.layoutNodes.some((entry) => entry.node.id === relationship.to),
    ),
  );
}

function c4DeepestCommonExpandedAncestorId(
  fromId: string,
  toId: string,
  entriesById: ReadonlyMap<string, C4LayoutEntry>,
): string | null {
  const toAncestors = c4ExpandedAncestorIds(toId, entriesById);
  for (const ancestorId of c4ExpandedAncestorIds(fromId, entriesById)) {
    if (toAncestors.has(ancestorId)) return ancestorId;
  }
  return null;
}

function c4ExpandedAncestorIds(
  nodeId: string,
  entriesById: ReadonlyMap<string, C4LayoutEntry>,
): Set<string> {
  const ancestors = new Set<string>();
  let current = entriesById.get(nodeId);
  while (current?.node.parentId) {
    const parent = entriesById.get(current.node.parentId);
    if (!parent) break;
    if (parent.expandedGroup) ancestors.add(parent.node.id);
    current = parent;
  }
  return ancestors;
}

function c4IsLayoutDescendantOf(
  nodeId: string,
  ancestorId: string,
  entriesById: ReadonlyMap<string, C4LayoutEntry>,
): boolean {
  let current = entriesById.get(nodeId);
  while (current?.node.parentId) {
    if (current.node.parentId === ancestorId) return true;
    current = entriesById.get(current.node.parentId);
  }
  return false;
}

function ensureC4LibavoidReady(wasmUrl?: string): Promise<void> {
  if (!c4LibavoidInitPromise) {
    c4LibavoidInitPromise = initializeC4Libavoid(wasmUrl);
  }
  return c4LibavoidInitPromise;
}

async function initializeC4Libavoid(wasmUrl?: string): Promise<void> {
  if (typeof document === "undefined") {
    await initLibavoidEdgeRouter();
    return;
  }
  try {
    await initLibavoidEdgeRouter(wasmUrl);
  } catch (error) {
    console.error("Review software-map libavoid initialization failed", error);
    throw error;
  }
}

function c4FlatLibavoidGraphFromLayout(
  layoutNodes: readonly C4LayoutEntry[],
  edgeRelationships: readonly {
    relationship: SoftwareMapRelationshipSnapshot;
    edgeId: string;
  }[],
  axis: C4LayoutAxis,
  portRelationships = edgeRelationships,
): LibavoidElkGraph {
  const bbox = c4LayoutEntriesBbox(layoutNodes);
  const portsByNodeId = c4RoutingPortsByNodeId(
    layoutNodes,
    portRelationships,
    axis,
  );
  return {
    id: "software-map-c4-fixed-flat",
    width: bbox.x + bbox.width + 80,
    height: bbox.y + bbox.height + 80,
    children: layoutNodes.map((entry) => ({
      id: entry.node.id,
      x: entry.x,
      y: entry.y,
      width: entry.width,
      height: entry.height,
      ports: portsByNodeId.get(entry.node.id),
    })),
    edges: edgeRelationships.map(({ relationship, edgeId }) => {
      const refs = c4RoutingEndpointRefs(
        relationship,
        edgeId,
        layoutNodes,
        axis,
      );
      return {
        id: edgeId,
        source: relationship.from,
        target: relationship.to,
        sourcePort: refs.sourcePortId,
        targetPort: refs.targetPortId,
      };
    }),
  };
}

async function runC4ElkLayout(
  nodes: SoftwareMapNodeSnapshot[],
  relationships: SoftwareMapRelationshipSnapshot[],
  nodeDimensions?: ReadonlyMap<string, C4NodeDimensions>,
  options: {
    previousLayout?: InlineC4LayoutResult;
    axis?: C4LayoutAxis;
  } = {},
): Promise<C4LayoutResult> {
  const previousCenters = c4PreviousLayoutCenters(options.previousLayout);
  const previousBoxes = c4PreviousLayoutBoxes(options.previousLayout);
  const layoutAxis = options.axis ?? c4ChildLayoutAxis();
  const sorted = [...nodes].sort((left, right) =>
    compareC4NodesForLayout(left, right, previousCenters, layoutAxis),
  );
  if (sorted.length === 0) {
    return { nodes: [], edgeSections: new Map(), edgeLabels: new Map() };
  }

  const nodeIds = new Set(sorted.map((node) => node.id));
  const nodesById = new Map(sorted.map((node) => [node.id, node]));
  const childIdsByParentId = new Map<string, string[]>();
  for (const node of sorted) {
    if (!node.parentId || !nodeIds.has(node.parentId)) continue;
    const children = childIdsByParentId.get(node.parentId) ?? [];
    children.push(node.id);
    childIdsByParentId.set(node.parentId, children);
  }
  const rootNodes = sorted.filter((node) => {
    if (!node.parentId) return true;
    const parent = nodesById.get(node.parentId);
    return !parent?.expanded;
  });
  const visibleRelationships = relationships.filter(
    (relationship) =>
      nodeIds.has(relationship.from) && nodeIds.has(relationship.to),
  );
  const layoutHintsByNodeId = new Map<string, C4LayoutEntry>(
    sorted.map((node) => {
      const hint = previousBoxes.get(node.id);
      const dimensions = c4MeasuredNodeDimensions(node, nodeDimensions);
      return [
        node.id,
        {
          node,
          x: hint?.x ?? 0,
          y: hint?.y ?? 0,
          width: hint?.width ?? dimensions.width,
          height: hint?.height ?? dimensions.height,
        },
      ];
    }),
  );
  const visibleEdgeRelationships = visibleRelationships.map(
    (relationship, index) => ({
      relationship,
      edgeId: c4RelationshipEdgeId(relationship, index),
    }),
  );
  const portsByNodeId = c4SchemaPortsByNodeId(
    [...layoutHintsByNodeId.values()],
    visibleEdgeRelationships,
  );
  // ELK ignores its cycle-breaking strategy for cross-hierarchy cycles under
  // INCLUDE_CHILDREN. Orient each edge along this layer's configured axis so
  // ELK cannot flip the previous arrangement during expansion.
  const reversedEdgeIds = new Set<string>();
  const elkEdges = visibleRelationships.map((relationship, index) => {
    const edgeId = c4RelationshipEdgeId(relationship, index);
    const label = relationship.hideLabel
      ? undefined
      : (relationship.label ?? relationship.semanticKind);
    const from = c4PreviousProxyCenter(
      relationship.from,
      nodesById,
      previousCenters,
    );
    const to = c4PreviousProxyCenter(
      relationship.to,
      nodesById,
      previousCenters,
    );
    const reversed = Boolean(
      from &&
      to &&
      c4PointAxisCoordinate(from, layoutAxis) >
        c4PointAxisCoordinate(to, layoutAxis),
    );
    if (reversed) reversedEdgeIds.add(edgeId);
    const refs = c4SchemaEndpointRefs(relationship, edgeId, [
      ...layoutHintsByNodeId.values(),
    ]);
    const sourceRef = refs.sourcePortId ?? relationship.from;
    const targetRef = refs.targetPortId ?? relationship.to;
    return {
      id: edgeId,
      sources: [reversed ? targetRef : sourceRef],
      targets: [reversed ? sourceRef : targetRef],
      labels: label
        ? [
            {
              id: `${edgeId}:label`,
              text: label,
              ...estimateC4EdgeLabelDimensions(label),
              layoutOptions: {
                "org.eclipse.elk.edgeLabels.placement": "TAIL",
                "org.eclipse.elk.edgeLabels.inline": "true",
              },
            },
          ]
        : undefined,
    };
  });
  const layoutOptions: LayoutOptions = {
    "elk.algorithm": "layered",
    "elk.direction": c4ElkDirectionForAxis(layoutAxis),
    "elk.hierarchyHandling": "INCLUDE_CHILDREN",
    "elk.spacing.nodeNode": "72",
    "elk.layered.spacing.nodeNodeBetweenLayers": "64",
    "elk.edgeRouting": "ORTHOGONAL",
    "elk.padding": "[top=40,left=40,bottom=40,right=40]",
    "org.eclipse.elk.layered.edgeLabels.centerLabelPlacementStrategy":
      "SPACE_EFFICIENT_LAYER",
    "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
    "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  };
  if (previousCenters.size > 0) {
    // With a previous/desired layout, model order and interactive positions
    // encode the on-screen arrangement so expansion can preserve the mental
    // map while ELK still owns layered orthogonal routing.
    Object.assign(layoutOptions, {
      "org.eclipse.elk.interactiveLayout": "true",
      "org.eclipse.elk.layered.cycleBreaking.strategy": "INTERACTIVE",
      "org.eclipse.elk.layered.layering.strategy": "INTERACTIVE",
      "org.eclipse.elk.layered.crossingMinimization.semiInteractive": "true",
      "org.eclipse.elk.layered.crossingMinimization.forceNodeModelOrder":
        "true",
      "org.eclipse.elk.separateConnectedComponents": "false",
    } satisfies LayoutOptions);
  }
  const result: C4ElkLayoutGraph = await c4Elk.layout({
    id: "software-map-c4",
    layoutOptions,
    children: rootNodes.map((node) =>
      c4ElkNodeForSnapshot(node, {
        childIdsByParentId,
        layoutHints: previousBoxes,
        nodeDimensions,
        nodesById,
        portsByNodeId,
      }),
    ),
    edges: elkEdges,
  });

  const nodeOffsets = new Map<string, C4ElkPoint>([
    [result.id, { x: 0, y: 0 }],
  ]);
  const layoutNodes = collectC4ElkLayoutEntries({
    children: result.children ?? [],
    nodesById,
    nodeOffsets,
    offset: { x: 0, y: 0 },
  });
  const edgeSections = new Map<string, C4ElkEdgeSection[]>();
  const edgeLabels = new Map<string, C4ElkLabel>();
  for (const edge of collectC4ElkEdges(result)) {
    const offset = nodeOffsets.get(edge.container ?? result.id) ?? {
      x: 0,
      y: 0,
    };
    if (edge.sections) {
      const sections = edge.sections.map((section) =>
        offsetC4ElkSection(section, offset),
      );
      edgeSections.set(
        edge.id,
        reversedEdgeIds.has(edge.id)
          ? reverseC4ElkSections(sections)
          : sections,
      );
    }
    const label = c4ElkLabelFromLayout(edge.labels?.[0]);
    if (label) {
      edgeLabels.set(edge.id, offsetC4ElkLabel(label, offset));
    }
  }

  return {
    nodes: layoutNodes,
    edgeSections,
    edgeLabels: positionC4EdgeLabels(
      edgeSections,
      edgeLabels,
      c4EdgeLabelNodeObstacles(layoutNodes),
    ),
  };
}

interface C4ElkLayoutGraph {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  children?: C4ElkLayoutNode[];
  edges?: C4ElkLayoutEdge[];
  layoutOptions?: Record<string, string>;
}

type C4ElkDirection = "RIGHT" | "DOWN";
type C4LayoutAxis = "horizontal" | "vertical";

// Keep the layer policy here. Layout, position preservation, and edge routing
// all translate this axis for their own APIs.
function c4ChildLayoutAxis(
  parent?: Pick<SoftwareMapNodeSnapshot, "type">,
): C4LayoutAxis {
  return parent?.type === "softwareSystem" ? "vertical" : "horizontal";
}

function c4ElkDirectionForAxis(axis: C4LayoutAxis): C4ElkDirection {
  return axis === "vertical" ? "DOWN" : "RIGHT";
}

function c4PointAxisCoordinate(point: C4ElkPoint, axis: C4LayoutAxis) {
  return axis === "vertical" ? point.y : point.x;
}

interface C4ElkLayoutNode extends C4ElkLayoutGraph {
  id: string;
  ports?: C4ElkPort[];
}

interface C4ElkPort {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  properties?: LayoutOptions;
}

interface C4ElkLayoutEdge {
  id: string;
  container?: string;
  sections?: C4ElkEdgeSection[];
  labels?: Array<Partial<C4ElkLabel>>;
  sources?: string[];
  targets?: string[];
  source?: string;
  target?: string;
  sourcePort?: string;
  targetPort?: string;
}

function c4ElkNodeForSnapshot(
  node: SoftwareMapNodeSnapshot,
  context: {
    childIdsByParentId: ReadonlyMap<string, readonly string[]>;
    layoutHints?: ReadonlyMap<string, C4LayoutBox>;
    nodeDimensions?: ReadonlyMap<string, C4NodeDimensions>;
    nodesById: ReadonlyMap<string, SoftwareMapNodeSnapshot>;
    portsByNodeId?: ReadonlyMap<string, C4ElkPort[]>;
  },
  parentOffset: C4ElkPoint = { x: 0, y: 0 },
): ElkNode {
  const hint = context.layoutHints?.get(node.id);
  const nodeOffset = hint ? { x: hint.x, y: hint.y } : parentOffset;
  const dimensions = c4MeasuredNodeDimensions(node, context.nodeDimensions);
  const children = node.expanded
    ? (context.childIdsByParentId.get(node.id) ?? [])
        .map((childId) => context.nodesById.get(childId))
        .filter((child): child is SoftwareMapNodeSnapshot => Boolean(child))
        .map((child) => c4ElkNodeForSnapshot(child, context, nodeOffset))
    : [];
  const elkNode: ElkNode = {
    id: node.id,
    width: hint?.width ?? dimensions.width,
    height: hint?.height ?? dimensions.height,
    ports: context.portsByNodeId?.get(node.id),
    children: children.length > 0 ? children : undefined,
    layoutOptions:
      children.length > 0
        ? {
            "elk.direction": c4ElkDirectionForAxis(c4ChildLayoutAxis(node)),
            "elk.padding": "[top=70,left=36,bottom=36,right=36]",
          }
        : undefined,
  };
  if (hint) {
    elkNode.x = hint.x - parentOffset.x;
    elkNode.y = hint.y - parentOffset.y;
  }
  return elkNode;
}

function collectC4ElkLayoutEntries({
  children,
  nodesById,
  nodeOffsets,
  offset,
}: {
  children: readonly C4ElkLayoutNode[];
  nodesById: ReadonlyMap<string, SoftwareMapNodeSnapshot>;
  nodeOffsets: Map<string, C4ElkPoint>;
  offset: C4ElkPoint;
}): C4LayoutEntry[] {
  return children.flatMap((child) => {
    const node = nodesById.get(child.id);
    if (!node) return [];
    const x = offset.x + (child.x ?? 0);
    const y = offset.y + (child.y ?? 0);
    const childOffset = { x, y };
    nodeOffsets.set(child.id, childOffset);
    return [
      {
        node,
        x,
        y,
        width: child.width ?? C4_NODE_WIDTH,
        height: child.height ?? estimateC4NodeHeight(node),
        expandedGroup: node.expanded && (child.children?.length ?? 0) > 0,
      },
      ...collectC4ElkLayoutEntries({
        children: child.children ?? [],
        nodesById,
        nodeOffsets,
        offset: childOffset,
      }),
    ];
  });
}

function collectC4ElkEdges(graph: C4ElkLayoutGraph): C4ElkLayoutEdge[] {
  return [
    ...(graph.edges ?? []),
    ...(graph.children ?? []).flatMap((child) => collectC4ElkEdges(child)),
  ];
}

function offsetC4ElkSection(
  section: C4ElkEdgeSection,
  offset: C4ElkPoint,
): C4ElkEdgeSection {
  return {
    ...section,
    startPoint: offsetC4ElkPoint(section.startPoint, offset),
    bendPoints: section.bendPoints?.map((point) =>
      offsetC4ElkPoint(point, offset),
    ),
    endPoint: offsetC4ElkPoint(section.endPoint, offset),
  };
}

function offsetC4ElkLabel(label: C4ElkLabel, offset: C4ElkPoint): C4ElkLabel {
  return {
    ...label,
    x: label.x + offset.x,
    y: label.y + offset.y,
  };
}

function offsetC4ElkPoint(point: C4ElkPoint, offset: C4ElkPoint): C4ElkPoint {
  return {
    x: point.x + offset.x,
    y: point.y + offset.y,
  };
}

export function positionC4EdgeLabels(
  edgeSections: Map<string, C4ElkEdgeSection[]>,
  edgeLabels: Map<string, C4ElkLabel>,
  nodeObstacles: C4LabelObstacle[] = [],
): Map<string, C4ElkLabel> {
  const positioned = new Map<string, C4ElkLabel>();
  const placed: C4ElkLabel[] = [];
  for (const edgeId of [...edgeLabels.keys()].sort()) {
    const label = edgeLabels.get(edgeId);
    if (!label) continue;
    const sections = edgeSections.get(edgeId);
    if (!sections || sections.length === 0) {
      positioned.set(edgeId, label);
      placed.push(label);
      continue;
    }
    const points = c4EdgePointsFromSections(sections);
    const center = {
      x: label.x + label.width / 2,
      y: label.y + label.height / 2,
    };
    const projected = projectPointOntoPolyline(center, points) ?? center;
    const baseDistance =
      c4PolylineDistanceForPoint(points, projected) ??
      c4PolylineTotalLength(points) / 2;
    const candidateDistances = c4LabelCandidateDistances(
      baseDistance,
      c4PolylineTotalLength(points),
      Math.max(C4_EDGE_LABEL_CANDIDATE_STEP, label.height),
    );
    const candidates = candidateDistances.flatMap((distance) =>
      c4EdgeLabelCandidatesAtDistance(points, distance, label),
    );
    const candidate = candidates.find(
      (next) =>
        !c4LabelOverlapsAny(next, placed, C4_EDGE_LABEL_LABEL_GUTTER) &&
        !c4LabelOverlapsAny(next, nodeObstacles, C4_EDGE_LABEL_NODE_GUTTER),
    ) ??
      c4LowestCollisionLabelCandidate(candidates, placed, nodeObstacles) ?? {
        ...label,
        x: projected.x - label.width / 2,
        y: projected.y - label.height / 2,
      };
    positioned.set(edgeId, candidate);
    placed.push(candidate);
  }
  return positioned;
}

function c4EdgeLabelNodeObstacles(
  layoutNodes: readonly C4LayoutEntry[],
): C4LabelObstacle[] {
  return layoutNodes.map((entry) => ({
    x: entry.x,
    y: entry.y,
    width: entry.width,
    height: entry.expandedGroup
      ? Math.min(entry.height, C4_EXPANDED_GROUP_LABEL_HEADER_HEIGHT)
      : entry.height,
  }));
}

function c4ElkLabelFromLayout(
  label: Partial<C4ElkLabel> | undefined,
): C4ElkLabel | null {
  const { x, y, width, height } = label ?? {};
  if (
    x === undefined ||
    y === undefined ||
    width === undefined ||
    height === undefined ||
    ![x, y, width, height].every(Number.isFinite)
  ) {
    return null;
  }
  return {
    x,
    y,
    width,
    height,
  };
}

function c4RelationshipEdgeId(
  relationship: SoftwareMapRelationshipSnapshot,
  index: number,
) {
  return (
    relationship.id ??
    `${relationship.from}:${relationship.to}:${
      relationship.label ?? relationship.semanticKind ?? index
    }`
  );
}

export function c4LayoutSignature(
  nodes: readonly SoftwareMapNodeSnapshot[],
  relationships: readonly SoftwareMapRelationshipSnapshot[],
  nodeDimensions?: ReadonlyMap<string, C4NodeDimensions> | null,
) {
  const nodeSignatures = nodes
    .map((node) =>
      [
        node.id,
        node.type,
        node.dataStoreKind ?? "",
        node.label,
        node.parentId ?? "",
        node.expanded ? "expanded" : "",
        node.description ?? "",
        node.changeStatus ?? "",
        node.boundary ? "boundary" : "",
        node.childCount ?? "",
        c4DataStoreSchemaSignature(node),
        nodeDimensions?.get(node.id)?.width ?? "",
        nodeDimensions?.get(node.id)?.height ?? "",
      ].join("\u001f"),
    )
    .sort();
  const relationshipSignatures = relationships
    .map((relationship) =>
      [
        relationship.id ?? "",
        relationship.from,
        relationship.to,
        relationship.label ?? "",
        relationship.kind ?? "",
        relationship.semanticKind ?? "",
        relationship.hideLabel ? "hide-label" : "",
      ].join("\u001f"),
    )
    .sort();
  return [...nodeSignatures, "\u001d", ...relationshipSignatures].join(
    "\u001e",
  );
}

export function c4PreviousInlineLayoutForRelationships(input: {
  previousLayout: InlineC4LayoutResult | null | undefined;
  previousRelationships:
    | readonly SoftwareMapRelationshipSnapshot[]
    | null
    | undefined;
  currentRelationships: readonly SoftwareMapRelationshipSnapshot[];
}): InlineC4LayoutResult | undefined {
  if (!input.previousLayout || !input.previousRelationships) return undefined;
  return c4RelationshipTopologySignature(input.previousRelationships) ===
    c4RelationshipTopologySignature(input.currentRelationships)
    ? input.previousLayout
    : undefined;
}

function c4RelationshipTopologySignature(
  relationships: readonly SoftwareMapRelationshipSnapshot[],
) {
  return relationships
    .map((relationship) =>
      [
        relationship.id ?? "",
        relationship.from,
        relationship.to,
        relationship.fromSchemaEndpointKind ?? "",
        ...(relationship.fromSchemaFieldPath ?? []),
        relationship.toSchemaEndpointKind ?? "",
        ...(relationship.toSchemaFieldPath ?? []),
      ].join("\u001f"),
    )
    .sort()
    .join("\u001e");
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

function c4DataStoreSchemaSignature(node: SoftwareMapNodeSnapshot): string {
  return (node.dataStoreSchemaSections ?? [])
    .map((section) =>
      [
        section.id,
        section.label,
        section.kind,
        section.key ?? "",
        ...section.rows.map((row) =>
          [
            row.id,
            row.label,
            row.depth ?? "",
            row.type ?? "",
            row.example ?? "",
            row.primaryKey ? "pk" : "",
            row.foreignKey ? "fk" : "",
          ].join("\u001d"),
        ),
      ].join("\u001c"),
    )
    .join("\u001b");
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

interface C4NodeMeasurementScheduler {
  requestFrame(callback: FrameRequestCallback): number;
  cancelFrame(frame: number): void;
  setTimer(callback: () => void, delay: number): number;
  clearTimer(timer: number): void;
}

export function scheduleC4NodeMeasurements(
  measure: () => void,
  scheduler: C4NodeMeasurementScheduler = {
    requestFrame: (callback) => requestAnimationFrame(callback),
    cancelFrame: (frame) => cancelAnimationFrame(frame),
    setTimer: (callback, delay) => window.setTimeout(callback, delay),
    clearTimer: (timer) => window.clearTimeout(timer),
  },
): () => void {
  let disposed = false;
  const run = () => {
    if (!disposed) measure();
  };

  // Native editor tabs can mount while Chromium reports the workbench page as
  // hidden. Animation frames are paused in that state, so take the initial
  // layout measurement synchronously and use frames only for refinement.
  run();
  const frame = scheduler.requestFrame(run);
  const followUpMeasurements = [120, 500].map((delay) =>
    scheduler.setTimer(run, delay),
  );

  return () => {
    disposed = true;
    scheduler.cancelFrame(frame);
    for (const timeout of followUpMeasurements) scheduler.clearTimer(timeout);
  };
}

type C4RoutingSide = "left" | "right" | "top" | "bottom";

function c4EdgeHandles(
  source?: C4LayoutBox,
  target?: C4LayoutBox,
  sections?: readonly C4ElkEdgeSection[],
) {
  if (!source || !target) {
    return {
      sourceHandle: "source-right",
      targetHandle: "target-left",
    };
  }
  const spatialSides = c4ConnectionSides(source, target);
  const firstSection = sections?.[0];
  const lastSection = sections?.at(-1);
  const sourceSide = firstSection
    ? c4RoutingSideForBorderPoint(
        source,
        firstSection.startPoint,
        spatialSides.source,
      )
    : spatialSides.source;
  const targetSide = lastSection
    ? c4RoutingSideForBorderPoint(
        target,
        lastSection.endPoint,
        spatialSides.target,
      )
    : spatialSides.target;
  return {
    sourceHandle: `source-${sourceSide}`,
    targetHandle: `target-${targetSide}`,
  };
}

function c4ConnectionSides(
  source: C4LayoutBox,
  target: C4LayoutBox,
): { source: C4RoutingSide; target: C4RoutingSide } {
  const sourceCenter = {
    x: source.x + source.width / 2,
    y: source.y + source.height / 2,
  };
  const targetCenter = {
    x: target.x + target.width / 2,
    y: target.y + target.height / 2,
  };
  const dx = targetCenter.x - sourceCenter.x;
  const dy = targetCenter.y - sourceCenter.y;
  const normalizedDx =
    Math.abs(dx) / Math.max((source.width + target.width) / 2, 1);
  const normalizedDy =
    Math.abs(dy) / Math.max((source.height + target.height) / 2, 1);
  if (normalizedDx >= normalizedDy) {
    return dx >= 0
      ? { source: "right", target: "left" }
      : { source: "left", target: "right" };
  }
  return dy >= 0
    ? { source: "bottom", target: "top" }
    : { source: "top", target: "bottom" };
}

function c4RoutingSideForBorderPoint(
  box: C4LayoutBox,
  point: C4ElkPoint,
  fallback: C4RoutingSide,
): C4RoutingSide {
  const distances: Array<[C4RoutingSide, number]> = [
    ["left", Math.abs(point.x - box.x)],
    ["right", Math.abs(point.x - (box.x + box.width))],
    ["top", Math.abs(point.y - box.y)],
    ["bottom", Math.abs(point.y - (box.y + box.height))],
  ];
  distances.sort((left, right) => left[1] - right[1]);
  const closest = distances[0];
  return closest && closest[1] <= 1 ? closest[0] : fallback;
}

function estimateC4NodeHeight(node: SoftwareMapNodeSnapshot): number {
  const dataStoreOutline =
    node.type === "dataStore"
      ? softwareMapDataStoreOutlineKind(node.dataStoreKind)
      : undefined;
  const storageOutlineExtraHeight =
    dataStoreOutline === "cylinder" || dataStoreOutline === "bucket"
      ? 70
      : dataStoreOutline === "folder"
        ? 40
        : 0;
  const minHeight =
    dataStoreOutline === "cylinder" || dataStoreOutline === "bucket"
      ? 168
      : dataStoreOutline === "folder"
        ? 168
        : C4_MIN_NODE_HEIGHT;
  const titleLines = Math.max(
    1,
    Math.ceil(node.label.length / C4_TITLE_CHARS_PER_LINE),
  );
  const descriptionLines = node.description
    ? Math.max(
        1,
        Math.ceil(node.description.length / C4_DESCRIPTION_CHARS_PER_LINE),
      )
    : 0;
  const metaCount =
    (node.file ? 1 : 0) +
    (node.childCount && node.childCount > 0 ? 1 : 0) +
    (node.boundary ? 1 : 0);
  const metaRows = metaCount > 0 ? Math.ceil(metaCount / 2) : 0;
  const verticalGaps =
    2 + (descriptionLines > 0 ? 1 : 0) + (metaRows > 0 ? 1 : 0);
  const schemaRows = (node.dataStoreSchemaSections ?? []).reduce(
    (total, section) => total + section.rows.length + 1 + (section.key ? 1 : 0),
    0,
  );
  const schemaHeight =
    schemaRows > 0
      ? 28 + schemaRows * 32 + (node.dataStoreSchemaSections?.length ?? 0) * 10
      : 0;

  return Math.max(
    schemaHeight > 0 ? Math.max(minHeight, 320) : minHeight,
    24 +
      storageOutlineExtraHeight +
      14 +
      titleLines * 19 +
      descriptionLines * 17 +
      metaRows * 20 +
      schemaHeight +
      verticalGaps * 7,
  );
}

function estimateC4EdgeLabelDimensions(label: string): C4LabelDimensions {
  const words = label.trim().split(/\s+/).filter(Boolean);
  let lineCount = 1;
  let currentLineLength = 0;
  let longestLineLength = 0;

  for (const word of words) {
    const nextLength =
      currentLineLength === 0
        ? word.length
        : currentLineLength + 1 + word.length;
    if (currentLineLength > 0 && nextLength > C4_EDGE_LABEL_CHARS_PER_LINE) {
      longestLineLength = Math.max(longestLineLength, currentLineLength);
      lineCount += 1;
      currentLineLength = word.length;
    } else {
      currentLineLength = nextLength;
    }

    while (currentLineLength > C4_EDGE_LABEL_CHARS_PER_LINE) {
      longestLineLength = Math.max(
        longestLineLength,
        C4_EDGE_LABEL_CHARS_PER_LINE,
      );
      lineCount += 1;
      currentLineLength -= C4_EDGE_LABEL_CHARS_PER_LINE;
    }
  }

  longestLineLength = Math.max(longestLineLength, currentLineLength, 1);
  return {
    width: Math.min(
      C4_EDGE_LABEL_MAX_WIDTH,
      longestLineLength * 6.4 + C4_EDGE_LABEL_HORIZONTAL_PADDING,
    ),
    height:
      lineCount * C4_EDGE_LABEL_LINE_HEIGHT + C4_EDGE_LABEL_VERTICAL_PADDING,
  };
}

function c4EdgeColor(): string {
  return "var(--map-edge)";
}

function c4EdgeDasharray(
  kind: SoftwareMapRelationshipKind,
  sourceNodeType?: SoftwareMapElementType,
  targetNodeType?: SoftwareMapElementType,
): string | undefined {
  if (kind === "implied") return "2 8";
  if (kind === "semantic") {
    return c4EdgeUsesCodeLevelDash(sourceNodeType, targetNodeType)
      ? "1 5"
      : undefined;
  }
  return undefined;
}

function c4EdgeUsesCodeLevelDash(
  sourceNodeType?: SoftwareMapElementType,
  targetNodeType?: SoftwareMapElementType,
) {
  return sourceNodeType === "codeElement" || targetNodeType === "codeElement";
}

type C4SchemaSide = "left" | "right";

function c4SchemaPortsByNodeId(
  layoutNodes: readonly C4LayoutEntry[],
  edgeRelationships: readonly {
    relationship: SoftwareMapRelationshipSnapshot;
    edgeId: string;
  }[],
): Map<string, C4ElkPort[]> {
  const entriesById = new Map(
    layoutNodes.map((entry) => [entry.node.id, entry]),
  );
  const portsByNodeId = new Map<string, C4ElkPort[]>();
  const seenPortIds = new Set<string>();

  for (const { relationship, edgeId } of edgeRelationships) {
    const refs = c4SchemaEndpointRefs(relationship, edgeId, layoutNodes);
    const sourceEntry = entriesById.get(relationship.from);
    if (
      sourceEntry &&
      refs.sourcePortId &&
      relationship.fromSchemaEndpointKind
    ) {
      c4AddSchemaPort({
        entry: sourceEntry,
        fieldPath: relationship.fromSchemaFieldPath ?? [],
        kind: relationship.fromSchemaEndpointKind,
        laneKey: `from:${edgeId}`,
        portId: refs.sourcePortId,
        portsByNodeId,
        seenPortIds,
        side: refs.sourceSide,
      });
    }

    const targetEntry = entriesById.get(relationship.to);
    if (targetEntry && refs.targetPortId && relationship.toSchemaEndpointKind) {
      c4AddSchemaPort({
        entry: targetEntry,
        fieldPath: relationship.toSchemaFieldPath ?? [],
        kind: relationship.toSchemaEndpointKind,
        laneKey: `to:${edgeId}`,
        portId: refs.targetPortId,
        portsByNodeId,
        seenPortIds,
        side: refs.targetSide,
      });
    }
  }

  return portsByNodeId;
}

function c4RoutingPortsByNodeId(
  layoutNodes: readonly C4LayoutEntry[],
  edgeRelationships: readonly {
    relationship: SoftwareMapRelationshipSnapshot;
    edgeId: string;
  }[],
  axis: C4LayoutAxis,
): Map<string, C4ElkPort[]> {
  const entriesById = new Map(
    layoutNodes.map((entry) => [entry.node.id, entry]),
  );
  const portsByNodeId = c4SchemaPortsByNodeId(layoutNodes, edgeRelationships);
  const seenPortIds = new Set(
    [...portsByNodeId.values()].flatMap((ports) =>
      ports.map((port) => port.id),
    ),
  );

  for (const { relationship, edgeId } of edgeRelationships) {
    const refs = c4RoutingEndpointRefs(relationship, edgeId, layoutNodes, axis);
    const sourceEntry = entriesById.get(relationship.from);
    if (
      sourceEntry &&
      refs.sourcePortId &&
      !relationship.fromSchemaEndpointKind
    ) {
      c4AddRoutingPort({
        entry: sourceEntry,
        portId: refs.sourcePortId,
        portsByNodeId,
        seenPortIds,
        side: refs.sourceSide,
      });
    }
    const targetEntry = entriesById.get(relationship.to);
    if (
      targetEntry &&
      refs.targetPortId &&
      !relationship.toSchemaEndpointKind
    ) {
      c4AddRoutingPort({
        entry: targetEntry,
        portId: refs.targetPortId,
        portsByNodeId,
        seenPortIds,
        side: refs.targetSide,
      });
    }
  }

  c4SpreadRoutingPorts(layoutNodes, edgeRelationships, portsByNodeId, axis);
  return portsByNodeId;
}

function c4SpreadRoutingPorts(
  layoutNodes: readonly C4LayoutEntry[],
  edgeRelationships: readonly {
    relationship: SoftwareMapRelationshipSnapshot;
    edgeId: string;
  }[],
  portsByNodeId: ReadonlyMap<string, C4ElkPort[]>,
  axis: C4LayoutAxis,
) {
  const entriesById = new Map(
    layoutNodes.map((entry) => [entry.node.id, entry]),
  );
  const laneByPortId = new Map<string, number>();
  for (const { relationship, edgeId } of edgeRelationships) {
    const source = entriesById.get(relationship.from);
    const target = entriesById.get(relationship.to);
    if (!source || !target) continue;
    const refs = c4RoutingEndpointRefs(relationship, edgeId, layoutNodes, axis);
    if (refs.sourcePortId && !relationship.fromSchemaEndpointKind) {
      laneByPortId.set(
        refs.sourcePortId,
        c4RoutingLaneCoordinate(refs.sourceSide, target),
      );
    }
    if (refs.targetPortId && !relationship.toSchemaEndpointKind) {
      laneByPortId.set(
        refs.targetPortId,
        c4RoutingLaneCoordinate(refs.targetSide, source),
      );
    }
  }

  for (const [nodeId, ports] of portsByNodeId) {
    const entry = entriesById.get(nodeId);
    if (!entry) continue;
    const portsBySide = new Map<string, C4ElkPort[]>();
    for (const port of ports) {
      if (!laneByPortId.has(port.id)) continue;
      const side = port.properties?.["port.side"];
      if (side === undefined) continue;
      const sidePorts = portsBySide.get(side) ?? [];
      sidePorts.push(port);
      portsBySide.set(side, sidePorts);
    }
    for (const [side, sidePorts] of portsBySide) {
      sidePorts.sort(
        (left, right) =>
          (laneByPortId.get(left.id) ?? 0) -
            (laneByPortId.get(right.id) ?? 0) ||
          left.id.localeCompare(right.id),
      );
      sidePorts.forEach((port, index) => {
        const position = (index + 1) / (sidePorts.length + 1);
        if (side === "NORTH" || side === "SOUTH") {
          port.x = entry.width * position;
        } else {
          port.y = entry.height * position;
        }
      });
    }
  }
}

function c4RoutingLaneCoordinate(side: C4RoutingSide, peer: C4LayoutEntry) {
  return side === "top" || side === "bottom"
    ? peer.x + peer.width / 2
    : peer.y + peer.height / 2;
}

function c4AddRoutingPort({
  entry,
  portId,
  portsByNodeId,
  seenPortIds,
  side,
}: {
  entry: C4LayoutEntry;
  portId: string;
  portsByNodeId: Map<string, C4ElkPort[]>;
  seenPortIds: Set<string>;
  side: C4RoutingSide;
}) {
  if (seenPortIds.has(portId)) return;
  seenPortIds.add(portId);
  const horizontal = side === "left" || side === "right";
  const ports = portsByNodeId.get(entry.node.id) ?? [];
  ports.push({
    id: portId,
    x: side === "right" ? entry.width : horizontal ? 0 : entry.width / 2,
    y: side === "bottom" ? entry.height : horizontal ? entry.height / 2 : 0,
    width: 0,
    height: 0,
    properties: {
      "port.side":
        side === "right"
          ? "EAST"
          : side === "left"
            ? "WEST"
            : side === "bottom"
              ? "SOUTH"
              : "NORTH",
    },
  });
  portsByNodeId.set(entry.node.id, ports);
}

function c4RoutingEndpointRefs(
  relationship: SoftwareMapRelationshipSnapshot,
  edgeId: string,
  layoutNodes: readonly C4LayoutEntry[],
  axis: C4LayoutAxis,
) {
  const entriesById = new Map(
    layoutNodes.map((entry) => [entry.node.id, entry]),
  );
  const source = entriesById.get(relationship.from);
  const target = entriesById.get(relationship.to);
  const connectionSides =
    source && target
      ? c4AxisConnectionSides(source, target, axis)
      : c4DefaultConnectionSides(axis);
  const schemaRefs = c4SchemaEndpointRefs(relationship, edgeId, layoutNodes);
  const sourceSide = relationship.fromSchemaEndpointKind
    ? schemaRefs.sourceSide
    : connectionSides.source;
  const targetSide = relationship.toSchemaEndpointKind
    ? schemaRefs.targetSide
    : connectionSides.target;
  return {
    sourcePortId: relationship.fromSchemaEndpointKind
      ? schemaRefs.sourcePortId
      : source
        ? c4RoutingPortId(relationship.from, edgeId, "source", sourceSide)
        : undefined,
    sourceSide,
    targetPortId: relationship.toSchemaEndpointKind
      ? schemaRefs.targetPortId
      : target
        ? c4RoutingPortId(relationship.to, edgeId, "target", targetSide)
        : undefined,
    targetSide,
  };
}

function c4AxisConnectionSides(
  source: C4LayoutBox,
  target: C4LayoutBox,
  axis: C4LayoutAxis,
): { source: C4RoutingSide; target: C4RoutingSide } {
  const sourceCenter = {
    x: source.x + source.width / 2,
    y: source.y + source.height / 2,
  };
  const targetCenter = {
    x: target.x + target.width / 2,
    y: target.y + target.height / 2,
  };
  if (axis === "vertical") {
    return targetCenter.y >= sourceCenter.y
      ? { source: "bottom", target: "top" }
      : { source: "top", target: "bottom" };
  }
  return targetCenter.x >= sourceCenter.x
    ? { source: "right", target: "left" }
    : { source: "left", target: "right" };
}

function c4DefaultConnectionSides(axis: C4LayoutAxis): {
  source: C4RoutingSide;
  target: C4RoutingSide;
} {
  return axis === "vertical"
    ? { source: "bottom", target: "top" }
    : { source: "right", target: "left" };
}

function c4RoutingPortId(
  nodeId: string,
  edgeId: string,
  role: "source" | "target",
  side: C4RoutingSide,
) {
  return `${nodeId}::edge-port:${role}:${side}:${edgeId}`;
}

function c4AddSchemaPort({
  entry,
  fieldPath,
  kind,
  laneKey,
  portId,
  portsByNodeId,
  seenPortIds,
  side,
}: {
  entry: C4LayoutEntry;
  fieldPath: readonly string[];
  kind: "field" | "header";
  laneKey: string;
  portId: string;
  portsByNodeId: Map<string, C4ElkPort[]>;
  seenPortIds: Set<string>;
  side: C4SchemaSide;
}) {
  if (seenPortIds.has(portId)) return;
  const y =
    kind === "header"
      ? c4SchemaHeaderCenterY(entry.node, entry.height, laneKey)
      : c4SchemaFieldCenterY(entry.node, entry.height, fieldPath);
  if (y === undefined) return;
  seenPortIds.add(portId);
  const ports = portsByNodeId.get(entry.node.id) ?? [];
  ports.push({
    id: portId,
    x: side === "right" ? entry.width : 0,
    y,
    width: 0,
    height: 0,
    properties: {
      "port.side": side === "right" ? "EAST" : "WEST",
    },
  });
  portsByNodeId.set(entry.node.id, ports);
}

function c4SchemaEndpointRefs(
  relationship: SoftwareMapRelationshipSnapshot,
  edgeId: string,
  layoutNodes: readonly C4LayoutEntry[],
) {
  const entriesById = new Map(
    layoutNodes.map((entry) => [entry.node.id, entry]),
  );
  const source = entriesById.get(relationship.from);
  const target = entriesById.get(relationship.to);
  const sourceSide =
    source && target ? c4SchemaPortSide(source, target, "source") : "right";
  const targetSide =
    source && target ? c4SchemaPortSide(target, source, "target") : "left";
  // Emit a port id only when c4AddSchemaPort can place that port, so an edge
  // never references a port that port registration skipped (ELK rejects the
  // whole graph on a dangling port reference).
  return {
    sourcePortId:
      relationship.fromSchemaEndpointKind &&
      c4SchemaPortPlaceable(
        source,
        relationship.fromSchemaEndpointKind,
        relationship.fromSchemaFieldPath ?? [],
      )
        ? c4SchemaPortId({
            edgeId,
            fieldPath: relationship.fromSchemaFieldPath ?? [],
            kind: relationship.fromSchemaEndpointKind,
            nodeId: relationship.from,
            side: sourceSide,
          })
        : undefined,
    sourceSide,
    targetPortId:
      relationship.toSchemaEndpointKind &&
      c4SchemaPortPlaceable(
        target,
        relationship.toSchemaEndpointKind,
        relationship.toSchemaFieldPath ?? [],
      )
        ? c4SchemaPortId({
            edgeId,
            fieldPath: relationship.toSchemaFieldPath ?? [],
            kind: relationship.toSchemaEndpointKind,
            nodeId: relationship.to,
            side: targetSide,
          })
        : undefined,
    targetSide,
  };
}

function c4SchemaPortPlaceable(
  entry: C4LayoutEntry | undefined,
  kind: "field" | "header",
  fieldPath: readonly string[],
): boolean {
  if (!entry) return false;
  if (kind === "header") return true;
  return (
    c4SchemaFieldCenterY(entry.node, entry.height, fieldPath) !== undefined
  );
}

function c4SchemaPortId({
  edgeId,
  fieldPath,
  kind,
  nodeId,
  side,
}: {
  edgeId: string;
  fieldPath: readonly string[];
  kind: "field" | "header";
  nodeId: string;
  side: C4SchemaSide;
}) {
  const fieldKey = fieldPath.length > 0 ? fieldPath.join(".") : "header";
  return `${nodeId}::schema-port:${kind}:${fieldKey}:${side}:${edgeId}`;
}

function c4SchemaPortSide(
  source: C4LayoutEntry,
  target: C4LayoutEntry,
  role: "source" | "target",
): C4SchemaSide {
  const sourceCenter = {
    x: source.x + source.width / 2,
    y: source.y + source.height / 2,
  };
  const targetCenter = {
    x: target.x + target.width / 2,
    y: target.y + target.height / 2,
  };
  if (sourceCenter.x === targetCenter.x && sourceCenter.y === targetCenter.y) {
    return role === "source" ? "right" : "left";
  }
  return target.x + target.width / 2 >= source.x + source.width / 2
    ? "right"
    : "left";
}

function c4SchemaHeaderCenterY(
  node: SoftwareMapNodeSnapshot,
  height: number,
  laneKey: string,
): number {
  return (
    c4SchemaBlockTop(node, height) + 15 + c4SchemaHeaderLaneOffset(laneKey)
  );
}

function c4SchemaHeaderLaneOffset(laneKey: string): number {
  const lanes = [-12, -9, -6, -3, 0, 3, 6, 9, 12];
  let hash = 2166136261;
  for (let index = 0; index < laneKey.length; index += 1) {
    hash ^= laneKey.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return lanes[hash % lanes.length] ?? 0;
}

function c4SchemaFieldCenterY(
  node: SoftwareMapNodeSnapshot,
  height: number,
  fieldPath: readonly string[],
): number | undefined {
  const sections = node.dataStoreSchemaSections ?? [];
  let y = c4SchemaBlockTop(node, height);
  for (const section of sections) {
    y += 30;
    if (section.key) y += 30;
    const rowIndex = section.rows.findIndex(
      (row) => row.id.split(":").slice(1).join(".") === fieldPath.join("."),
    );
    if (rowIndex >= 0) return y + rowIndex * 30 + 15;
    y += section.rows.length * 30 + 8;
  }
  return undefined;
}

function c4SchemaBlockTop(
  node: SoftwareMapNodeSnapshot,
  height: number,
): number {
  const sections = node.dataStoreSchemaSections ?? [];
  const blockHeight =
    sections.reduce(
      (total, section) =>
        total + 30 + (section.key ? 30 : 0) + section.rows.length * 30,
      0,
    ) +
    Math.max(0, sections.length - 1) * 8;
  return Math.max(0, height - blockHeight - 18);
}

export function c4EdgeEndpointBubbles(
  points: readonly C4ElkPoint[],
  relationship: Pick<SoftwareMapRelationshipSnapshot, "from" | "kind">,
  hoveredNodeId?: string | null,
): C4EdgeEndpointBubble[] {
  if (relationship.kind === "implied") return [];
  const sourcePoint = points[0];
  if (!sourcePoint) return [];

  return [
    {
      endpoint: "source",
      x: sourcePoint.x,
      y: sourcePoint.y,
      hovered: hoveredNodeId === relationship.from,
    },
  ];
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

function c4EdgeLabelPoint(
  labelPosition: C4ElkLabel | undefined,
  labelDimensions: C4LabelDimensions | undefined,
  fallbackPoints: C4ElkPoint[],
): C4ElkPoint {
  const fallback = c4PolylineMidpoint(fallbackPoints);
  if (
    labelPosition &&
    Number.isFinite(labelPosition.x) &&
    Number.isFinite(labelPosition.y)
  ) {
    const width = Number.isFinite(labelPosition.width)
      ? labelPosition.width
      : (labelDimensions?.width ?? 0);
    const height = Number.isFinite(labelPosition.height)
      ? labelPosition.height
      : (labelDimensions?.height ?? 0);
    return {
      x: labelPosition.x + width / 2,
      y: labelPosition.y + height / 2,
    };
  }
  return fallback;
}

export function c4EdgePointsFromSections(
  sections: C4ElkEdgeSection[] | undefined,
): C4ElkPoint[] {
  const section = sections?.[0];
  return section
    ? [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]
    : [];
}

function c4PolylinePath(points: C4ElkPoint[]): string {
  const [first, ...rest] = points;
  if (!first) return "";
  return [
    `M ${first.x} ${first.y}`,
    ...rest.map((point) => `L ${point.x} ${point.y}`),
  ].join(" ");
}

function c4PolylineMidpoint(points: C4ElkPoint[]): C4ElkPoint {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return points[0]!;

  const segments = points.slice(1).map((point, index) => {
    const previous = points[index]!;
    return {
      start: previous,
      end: point,
      length: Math.hypot(point.x - previous.x, point.y - previous.y),
    };
  });
  const totalLength = segments.reduce(
    (sum, segment) => sum + segment.length,
    0,
  );
  let cursor = 0;
  const halfway = totalLength / 2;
  for (const segment of segments) {
    if (cursor + segment.length >= halfway) {
      const progress =
        segment.length === 0 ? 0 : (halfway - cursor) / segment.length;
      return {
        x: segment.start.x + (segment.end.x - segment.start.x) * progress,
        y: segment.start.y + (segment.end.y - segment.start.y) * progress,
      };
    }
    cursor += segment.length;
  }
  return points.at(-1)!;
}

function projectPointOntoPolyline(
  point: C4ElkPoint,
  points: C4ElkPoint[],
): C4ElkPoint | null {
  if (points.length < 2) return null;
  let best: { point: C4ElkPoint; distance: number } | null = null;
  for (let index = 1; index < points.length; index++) {
    const start = points[index - 1]!;
    const end = points[index]!;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared === 0) continue;
    const progress = Math.max(
      0,
      Math.min(
        1,
        ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared,
      ),
    );
    const projected = {
      x: start.x + dx * progress,
      y: start.y + dy * progress,
    };
    const distance = Math.hypot(point.x - projected.x, point.y - projected.y);
    if (!best || distance < best.distance) {
      best = { point: projected, distance };
    }
  }
  return best?.point ?? null;
}

function c4PolylineTotalLength(points: C4ElkPoint[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    if (!start || !end) continue;
    total += Math.hypot(end.x - start.x, end.y - start.y);
  }
  return total;
}

function c4PolylineDistanceForPoint(
  points: C4ElkPoint[],
  point: C4ElkPoint,
): number | null {
  if (points.length < 2) return null;
  let cursor = 0;
  let best: { distance: number; pointDistance: number } | null = null;
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1]!;
    const end = points[index]!;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    if (length === 0) continue;
    const lengthSquared = length * length;
    const progress = Math.max(
      0,
      Math.min(
        1,
        ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared,
      ),
    );
    const projected = {
      x: start.x + dx * progress,
      y: start.y + dy * progress,
    };
    const pointDistance = Math.hypot(
      point.x - projected.x,
      point.y - projected.y,
    );
    const distance = cursor + length * progress;
    if (!best || pointDistance < best.pointDistance) {
      best = { distance, pointDistance };
    }
    cursor += length;
  }
  return best?.distance ?? null;
}

function c4PolylinePointAtDistance(
  points: C4ElkPoint[],
  distance: number,
): C4ElkPoint {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return points[0]!;
  let cursor = 0;
  const target = Math.max(0, Math.min(distance, c4PolylineTotalLength(points)));
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1]!;
    const end = points[index]!;
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    if (length === 0) continue;
    if (cursor + length >= target) {
      const progress = (target - cursor) / length;
      return {
        x: start.x + (end.x - start.x) * progress,
        y: start.y + (end.y - start.y) * progress,
      };
    }
    cursor += length;
  }
  return points.at(-1)!;
}

function c4EdgeLabelCandidatesAtDistance(
  points: C4ElkPoint[],
  distance: number,
  label: C4ElkLabel,
): C4ElkLabel[] {
  const point = c4PolylinePointAtDistance(points, distance);
  return [
    {
      ...label,
      x: point.x - label.width / 2,
      y: point.y - label.height / 2,
    },
  ];
}

function c4LabelCandidateDistances(
  baseDistance: number,
  totalLength: number,
  step: number,
): number[] {
  const distances = [baseDistance];
  const maxSteps = Math.max(1, Math.ceil(totalLength / Math.max(1, step)));
  for (let index = 1; index <= maxSteps; index += 1) {
    distances.push(baseDistance + step * index, baseDistance - step * index);
  }
  return distances.map((distance) =>
    Math.max(0, Math.min(totalLength, distance)),
  );
}

function c4LabelOverlapsAny(
  label: C4ElkLabel,
  obstacles: readonly C4LabelObstacle[],
  gutter: number,
): boolean {
  return obstacles.some((obstacle) =>
    c4LabelBoxesOverlap(label, obstacle, gutter),
  );
}

function c4LowestCollisionLabelCandidate(
  candidates: C4ElkLabel[],
  placedLabels: readonly C4ElkLabel[],
  nodeObstacles: readonly C4LabelObstacle[],
): C4ElkLabel | null {
  let best: { candidate: C4ElkLabel; score: number } | null = null;
  for (const candidate of candidates) {
    const score =
      c4LabelCollisionScore(
        candidate,
        placedLabels,
        C4_EDGE_LABEL_LABEL_GUTTER,
      ) +
      c4LabelCollisionScore(
        candidate,
        nodeObstacles,
        C4_EDGE_LABEL_NODE_GUTTER,
      ) *
        4;
    if (!best || score < best.score) {
      best = { candidate, score };
    }
  }
  return best?.candidate ?? null;
}

function c4LabelCollisionScore(
  label: C4ElkLabel,
  obstacles: readonly C4LabelObstacle[],
  gutter: number,
): number {
  return obstacles.reduce(
    (score, obstacle) => score + c4LabelOverlapArea(label, obstacle, gutter),
    0,
  );
}

function c4LabelOverlapArea(
  left: C4ElkLabel,
  right: C4LabelObstacle,
  gutter: number,
): number {
  const expandedRight = c4ExpandLabelBox(right, gutter);
  const overlapWidth = Math.max(
    0,
    Math.min(left.x + left.width, expandedRight.x + expandedRight.width) -
      Math.max(left.x, expandedRight.x),
  );
  const overlapHeight = Math.max(
    0,
    Math.min(left.y + left.height, expandedRight.y + expandedRight.height) -
      Math.max(left.y, expandedRight.y),
  );
  return overlapWidth * overlapHeight;
}

function c4ExpandLabelBox(
  box: C4LabelObstacle,
  gutter: number,
): C4LabelObstacle {
  return {
    x: box.x - gutter,
    y: box.y - gutter,
    width: box.width + gutter * 2,
    height: box.height + gutter * 2,
  };
}

function c4LabelBoxesOverlap(
  left: C4ElkLabel,
  right: C4LabelObstacle,
  gutter = 0,
): boolean {
  const expandedRight = c4ExpandLabelBox(right, gutter);
  return !(
    left.x + left.width <= expandedRight.x ||
    expandedRight.x + expandedRight.width <= left.x ||
    left.y + left.height <= expandedRight.y ||
    expandedRight.y + expandedRight.height <= left.y
  );
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

export function SoftwareMapDataStoreOutline({
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

export function SoftwareMapNodeFrame({
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

export function visibleSoftwareMapChangeCount(count?: number) {
  return count !== undefined && c4FinitePositive(count) ? count : 0;
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
