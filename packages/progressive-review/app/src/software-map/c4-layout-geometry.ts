import {
  type ElkGraph as LibavoidElkGraph,
  init as initLibavoidEdgeRouter,
  routeEdges as routeLibavoidEdges,
} from "@mr_mint/elkjs-libavoid";
import {
  MarkerType,
  type Edge as ReactFlowEdge,
  type ReactFlowInstance,
  type Viewport,
} from "@xyflow/react";
import ELK, {
  type ElkNode,
  type LayoutOptions,
} from "elkjs/lib/elk.bundled.js";
import type { CSSProperties } from "react";

import {
  C4_EXPANDED_GROUP_LABEL_HEADER_HEIGHT,
  c4EdgeLabelNodeObstacles,
  c4EdgeLabelPoint,
  c4EdgePointsFromSections,
  c4ElkLabelFromLayout,
  c4PolylineMidpoint,
  estimateC4EdgeLabelDimensions,
  positionC4EdgeLabels,
} from "./c4-edge-label-geometry";
import type {
  C4EdgeEndpointBubble,
  C4ElkEdgeSection,
  C4ElkLabel,
  C4ElkPoint,
  C4LayoutBox,
  C4LayoutEntry,
  C4LayoutResult,
  C4MapAnyFlowNode,
  C4NodeDimensions,
  InlineC4LayoutResult,
} from "./c4-map-flow-types";
import type { SoftwareDataStoreKind } from "./model";
import {
  focusSoftwareMapKeyboardTarget,
  softwareMapKeyboardNodeDomAttributes,
} from "./software-map-keyboard-navigation";
import {
  softwareMapNodeLabelPath,
  softwareMapRelationshipLabelPath,
} from "./software-map-paths";
import {
  type SoftwareMapElementType,
  type SoftwareMapNodeSnapshot,
  type SoftwareMapRelationshipKind,
  type SoftwareMapRelationshipSnapshot,
  type SoftwareMapResolvedSnapshot,
  c4FinitePositive,
} from "./software-map-snapshot";

export type SoftwareMapDataStoreOutlineKind = "cylinder" | "bucket" | "folder";

const TYPE_ORDER: Record<SoftwareMapElementType, number> = {
  person: 0,
  softwareSystem: 1,
  container: 2,
  dataStore: 3,
  dataStoreCollection: 4,
  component: 5,
  codeElement: 6,
};

export function softwareMapDataStoreOutlineKind(
  kind: SoftwareDataStoreKind | undefined,
): SoftwareMapDataStoreOutlineKind {
  if (kind === "bucket" || kind === "objectStore") return "bucket";
  if (kind === "artifactStore" || kind === "fileStore") return "folder";
  return "cylinder";
}

const C4_NODE_WIDTH = 280;

const C4_MIN_NODE_HEIGHT = 112;

export const C4_FLOW_MIN_ZOOM = 0.03;

export const C4_FLOW_MAX_ZOOM = 1.6;

const C4_SELECTED_NODE_FOCUS_PADDING = 0.16;

const C4_SELECTED_NODE_FOCUS_DURATION_MS = 140;

export const C4_FIT_VIEW_PADDING = 0.18;

const C4_FIT_VIEW_DURATION_MS = 140;

const C4_NAV_NODE_REVEAL_PADDING_PX = 8;

const C4_NAV_NODE_REVEAL_DURATION_MS = 110;

const C4_DESCRIPTION_CHARS_PER_LINE = 42;

const C4_TITLE_CHARS_PER_LINE = 28;

const C4_LOCAL_GROUP_PADDING = {
  top: C4_EXPANDED_GROUP_LABEL_HEADER_HEIGHT,
  right: 36,
  bottom: 36,
  left: 36,
} as const;

const C4_LOCAL_SIBLING_X_GAP = 96;

const C4_LOCAL_SIBLING_Y_GAP = 72;

const C4_LOCAL_ROW_CLUSTER_GAP = 24;

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

export function revealC4MapNode(
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

export function c4DataStoreSchemaSignature(
  node: SoftwareMapNodeSnapshot,
): string {
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
