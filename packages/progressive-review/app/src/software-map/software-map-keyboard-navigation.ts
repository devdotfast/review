import type { ReviewNodeTint, ReviewTheme } from "../debug-settings";
import type {
  C4LayoutResult,
  C4MapAnyFlowNode,
  C4MapInteractionMode,
} from "./c4-map-flow-types";
import { collapseInlineC4Node } from "./c4-projection";
import type { SoftwareMapHotkeyGroup } from "./hotkeys-tab";
import type { SoftwareMapNodeSnapshot } from "./software-map-snapshot";

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

export type C4SpatialDirection = "left" | "right" | "down" | "up";

export interface C4SpatialNodePosition {
  id: string;
  parentId?: string | null;
  x: number;
  y: number;
  width?: number;
  height?: number;
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

export function c4SpatialPositions(
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

export function softwareMapKeyboardNodeDomAttributes(
  nodeId: string,
): C4MapAnyFlowNode["domAttributes"] {
  // SAFETY: React types data-* attributes only in JSX. React Flow spreads
  // domAttributes onto the node wrapper, so this attribute reaches the DOM.
  return {
    [SOFTWARE_MAP_KEYBOARD_NODE_ID_ATTRIBUTE]: nodeId,
  } as C4MapAnyFlowNode["domAttributes"];
}

export function softwareMapEventTargetNodeId(
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

export function isSoftwareMapEditableTarget(target: EventTarget | null) {
  if (typeof HTMLElement === "undefined") return false;
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT")
  );
}

export function focusSoftwareMapKeyboardTarget(element: HTMLElement | null) {
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
