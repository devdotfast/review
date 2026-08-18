export interface C4LayoutBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface C4LayoutInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const C4_LAYOUT_CARD_WIDTH = 280;
export const C4_LAYOUT_CARD_HEIGHT = 112;

export const C4_LAYOUT_CARD_SIZE = {
  width: C4_LAYOUT_CARD_WIDTH,
  height: C4_LAYOUT_CARD_HEIGHT,
} as const;

export const C4_LAYOUT_GROUP_PADDING = {
  top: 84,
  right: 36,
  bottom: 36,
  left: 36,
} as const satisfies C4LayoutInsets;

export const C4_LAYOUT_GROUP_LABEL_OFFSET = {
  x: C4_LAYOUT_GROUP_PADDING.left,
  y: 16,
} as const;

export const C4_LAYOUT_CHILD_COLUMN_GAP = 96;
export const C4_LAYOUT_CHILD_ROW_GAP = 56;
export const C4_LAYOUT_ROOT_COLUMN_GAP = 112;
export const C4_LAYOUT_ROOT_ROW_GAP = 88;

export interface C4LayoutNode {
  id: string;
  path?: string;
  parentPath?: string;
  children?: readonly string[];
  width?: number;
  height?: number;
}

export interface C4LayoutRelationship {
  id?: string;
  kind: string;
  from: string;
  to: string;
  source?: string;
  label?: string;
  semanticKind?: string;
}

export interface C4LayoutResult {
  nodeBboxes: Map<string, C4LayoutBox>;
  groupBboxes: Map<string, C4LayoutBox>;
  childLayoutKeys: Map<string, string>;
}

export interface C4LayoutOptions {
  nodes: readonly C4LayoutNode[];
  relationships: readonly C4LayoutRelationship[];
  expandedIds: ReadonlySet<string> | readonly string[];
  previousLayout?: C4LayoutResult;
}

export type C4ChildLayoutKeyCache = Map<string, string>;

interface MeasuredLayoutNode {
  node: C4LayoutNode;
  expanded: boolean;
  width: number;
  height: number;
  childPlacements: MeasuredChildPlacement[];
}

interface MeasuredChildPlacement {
  nodeId: string;
  x: number;
  y: number;
}

interface PlacedAtomicUnit {
  id: string;
  nodeIds: string[];
  groupIds: string[];
  bbox: C4LayoutBox;
  grew: boolean;
  order: number;
}

export function createC4ChildLayoutKey(
  parentId: string,
  childIds: readonly string[],
  relationships: readonly C4LayoutRelationship[],
): string {
  const childIdSet = new Set(childIds);
  const relationshipSignatures = relationships
    .filter(
      (relationship) =>
        childIdSet.has(relationship.from) && childIdSet.has(relationship.to),
    )
    .map((relationship) =>
      [
        relationship.source ?? "",
        relationship.kind,
        relationship.semanticKind ?? "",
        relationship.from,
        relationship.to,
        relationship.label ?? "",
      ].join(":"),
    )
    .sort();

  return JSON.stringify({
    parentId,
    childIds,
    relationships: relationshipSignatures,
  });
}

export function cacheC4ChildLayoutKey(
  cache: C4ChildLayoutKeyCache,
  parentId: string,
  childIds: readonly string[],
  relationships: readonly C4LayoutRelationship[],
): string {
  const key = createC4ChildLayoutKey(parentId, childIds, relationships);
  cache.set(parentId, key);
  return key;
}

export function layoutInlineC4(options: C4LayoutOptions): C4LayoutResult {
  const expandedIds = normalizeExpandedIds(options.expandedIds);
  const nodesById = new Map(options.nodes.map((node) => [node.id, node]));
  const visibleIds = new Set(nodesById.keys());
  const childIdsByParentId = collectVisibleChildIds(options.nodes);
  const rootIds = options.nodes
    .filter((node) => !visibleParentIdForNode(node, nodesById, visibleIds))
    .map((node) => node.id);
  const measuredById = new Map<string, MeasuredLayoutNode>();
  const result: C4LayoutResult = {
    nodeBboxes: new Map(),
    groupBboxes: new Map(),
    childLayoutKeys: new Map(),
  };

  for (const node of options.nodes) {
    measureNode(node.id, {
      childIdsByParentId,
      expandedIds,
      measuredById,
      nodesById,
      relationships: options.relationships,
      result,
    });
  }

  const units = rootIds.map((rootId, order) => {
    const measured = requiredMeasuredNode(measuredById, rootId);
    const origin = originForMeasuredNode(
      measured,
      order,
      options.previousLayout,
    );
    return placeAtomicUnit(measured, origin.x, origin.y, measuredById, result, {
      order,
      previousLayout: options.previousLayout,
    });
  });

  displaceCollidingUnits(units, result);

  return result;
}

function normalizeExpandedIds(
  expandedIds: ReadonlySet<string> | readonly string[],
) {
  return expandedIds instanceof Set ? expandedIds : new Set(expandedIds);
}

function collectVisibleChildIds(nodes: readonly C4LayoutNode[]) {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const childIdsByParentId = new Map<string, string[]>();

  for (const node of nodes) {
    const parentId = visibleParentIdForNode(node, nodesById, nodesById);
    if (!parentId) continue;
    const childIds = childIdsByParentId.get(parentId) ?? [];
    childIds.push(node.id);
    childIdsByParentId.set(parentId, childIds);
  }

  return childIdsByParentId;
}

function visibleParentIdForNode(
  node: C4LayoutNode,
  nodesById: ReadonlyMap<string, C4LayoutNode>,
  visibleIds: ReadonlySet<string> | ReadonlyMap<string, C4LayoutNode>,
) {
  if (!node.parentPath) return undefined;

  for (const candidate of nodesById.values()) {
    if (!hasVisibleId(candidate.id, visibleIds)) continue;
    if (
      node.parentPath === candidate.id ||
      node.parentPath === candidate.path
    ) {
      return candidate.id;
    }
    if (
      candidate.children?.includes(node.id) ||
      (node.path && candidate.children?.includes(node.path))
    ) {
      return candidate.id;
    }
  }

  return undefined;
}

function hasVisibleId(
  id: string,
  visibleIds: ReadonlySet<string> | ReadonlyMap<string, C4LayoutNode>,
) {
  return "has" in visibleIds && visibleIds.has(id);
}

function measureNode(
  nodeId: string,
  context: {
    childIdsByParentId: ReadonlyMap<string, readonly string[]>;
    expandedIds: ReadonlySet<string>;
    measuredById: Map<string, MeasuredLayoutNode>;
    nodesById: ReadonlyMap<string, C4LayoutNode>;
    relationships: readonly C4LayoutRelationship[];
    result: C4LayoutResult;
  },
): MeasuredLayoutNode {
  const existing = context.measuredById.get(nodeId);
  if (existing) return existing;

  const node = context.nodesById.get(nodeId);
  if (!node) {
    throw new Error(`Cannot layout missing C4 node "${nodeId}".`);
  }

  const childIds = context.childIdsByParentId.get(nodeId) ?? [];
  const expanded = context.expandedIds.has(nodeId) && childIds.length > 0;

  if (!expanded) {
    const measured = {
      node,
      expanded: false,
      width: cardWidth(node),
      height: cardHeight(node),
      childPlacements: [],
    };
    context.measuredById.set(nodeId, measured);
    return measured;
  }

  const childMeasures = childIds.map((childId) =>
    measureNode(childId, context),
  );
  const childPlacements = layoutChildMeasures(childMeasures);
  const childExtent = childPlacements.reduce(
    (extent, placement) => {
      const child = requiredMeasuredNode(
        context.measuredById,
        placement.nodeId,
      );
      return {
        width: Math.max(extent.width, placement.x + child.width),
        height: Math.max(extent.height, placement.y + child.height),
      };
    },
    { width: 0, height: 0 },
  );
  const measured = {
    node,
    expanded: true,
    width: Math.max(
      cardWidth(node) +
        C4_LAYOUT_GROUP_PADDING.left +
        C4_LAYOUT_GROUP_PADDING.right,
      C4_LAYOUT_GROUP_PADDING.left +
        childExtent.width +
        C4_LAYOUT_GROUP_PADDING.right,
    ),
    height: Math.max(
      cardHeight(node) +
        C4_LAYOUT_GROUP_PADDING.top +
        C4_LAYOUT_GROUP_PADDING.bottom,
      C4_LAYOUT_GROUP_PADDING.top +
        childExtent.height +
        C4_LAYOUT_GROUP_PADDING.bottom,
    ),
    childPlacements,
  };

  context.result.childLayoutKeys.set(
    nodeId,
    createC4ChildLayoutKey(nodeId, childIds, context.relationships),
  );
  context.measuredById.set(nodeId, measured);
  return measured;
}

function layoutChildMeasures(
  childMeasures: readonly MeasuredLayoutNode[],
): MeasuredChildPlacement[] {
  if (childMeasures.length === 0) return [];

  const columnCount = Math.max(1, Math.ceil(Math.sqrt(childMeasures.length)));
  const columnWidth =
    Math.max(...childMeasures.map((measure) => measure.width)) +
    C4_LAYOUT_CHILD_COLUMN_GAP;
  const rowHeight =
    Math.max(...childMeasures.map((measure) => measure.height)) +
    C4_LAYOUT_CHILD_ROW_GAP;

  return childMeasures.map((measure, index) => ({
    nodeId: measure.node.id,
    x: (index % columnCount) * columnWidth,
    y: Math.floor(index / columnCount) * rowHeight,
  }));
}

function requiredMeasuredNode(
  measuredById: ReadonlyMap<string, MeasuredLayoutNode>,
  nodeId: string,
) {
  const measured = measuredById.get(nodeId);
  if (!measured) {
    throw new Error(`Cannot layout unmeasured C4 node "${nodeId}".`);
  }
  return measured;
}

function originForMeasuredNode(
  measured: MeasuredLayoutNode,
  order: number,
  previousLayout?: C4LayoutResult,
) {
  const previousGroup = previousLayout?.groupBboxes.get(measured.node.id);
  if (previousGroup && measured.expanded) {
    return { x: previousGroup.x, y: previousGroup.y };
  }

  const previousNode = previousLayout?.nodeBboxes.get(measured.node.id);
  if (previousNode) {
    if (!measured.expanded) return { x: previousNode.x, y: previousNode.y };
    return {
      x: centerX(previousNode) - measured.width / 2,
      y: centerY(previousNode) - measured.height / 2,
    };
  }

  return {
    x: order * (C4_LAYOUT_CARD_WIDTH + C4_LAYOUT_ROOT_COLUMN_GAP),
    y: 0,
  };
}

function placeAtomicUnit(
  measured: MeasuredLayoutNode,
  x: number,
  y: number,
  measuredById: ReadonlyMap<string, MeasuredLayoutNode>,
  result: C4LayoutResult,
  context: {
    order: number;
    previousLayout?: C4LayoutResult;
  },
): PlacedAtomicUnit {
  const ids = collectSubtreeIds(measured, measuredById);
  const groupIds: string[] = [];
  placeMeasuredNode(measured, x, y, measuredById, result, groupIds);
  const bbox = measured.expanded
    ? requiredBox(result.groupBboxes, measured.node.id)
    : requiredBox(result.nodeBboxes, measured.node.id);

  return {
    id: measured.node.id,
    nodeIds: ids,
    groupIds,
    bbox,
    grew: didFootprintGrow(measured.node.id, bbox, context.previousLayout),
    order: context.order,
  };
}

function placeMeasuredNode(
  measured: MeasuredLayoutNode,
  x: number,
  y: number,
  measuredById: ReadonlyMap<string, MeasuredLayoutNode>,
  result: C4LayoutResult,
  groupIds: string[],
) {
  if (!measured.expanded) {
    result.nodeBboxes.set(measured.node.id, {
      x,
      y,
      width: measured.width,
      height: measured.height,
    });
    return;
  }

  result.groupBboxes.set(measured.node.id, {
    x,
    y,
    width: measured.width,
    height: measured.height,
  });
  groupIds.push(measured.node.id);
  result.nodeBboxes.set(measured.node.id, {
    x: x + C4_LAYOUT_GROUP_LABEL_OFFSET.x,
    y: y + C4_LAYOUT_GROUP_LABEL_OFFSET.y,
    width: cardWidth(measured.node),
    height: cardHeight(measured.node),
  });

  for (const placement of measured.childPlacements) {
    const child = requiredMeasuredNode(measuredById, placement.nodeId);
    placeMeasuredNode(
      child,
      x + C4_LAYOUT_GROUP_PADDING.left + placement.x,
      y + C4_LAYOUT_GROUP_PADDING.top + placement.y,
      measuredById,
      result,
      groupIds,
    );
  }
}

function collectSubtreeIds(
  measured: MeasuredLayoutNode,
  measuredById: ReadonlyMap<string, MeasuredLayoutNode>,
): string[] {
  return [
    measured.node.id,
    ...measured.childPlacements.flatMap((placement) =>
      collectSubtreeIds(
        requiredMeasuredNode(measuredById, placement.nodeId),
        measuredById,
      ),
    ),
  ];
}

function didFootprintGrow(
  nodeId: string,
  bbox: C4LayoutBox,
  previousLayout?: C4LayoutResult,
) {
  const previous =
    previousLayout?.groupBboxes.get(nodeId) ??
    previousLayout?.nodeBboxes.get(nodeId);
  if (!previous) return false;
  return bbox.width > previous.width || bbox.height > previous.height;
}

function displaceCollidingUnits(
  units: PlacedAtomicUnit[],
  result: C4LayoutResult,
) {
  for (
    let iteration = 0;
    iteration < units.length * units.length;
    iteration += 1
  ) {
    let moved = false;

    for (let index = 0; index < units.length; index += 1) {
      for (
        let otherIndex = index + 1;
        otherIndex < units.length;
        otherIndex += 1
      ) {
        const first = units[index]!;
        const second = units[otherIndex]!;
        if (!boxesOverlap(first.bbox, second.bbox)) continue;

        const [blocker, mover] = chooseBlockerAndMover(first, second);
        const delta = displacementDelta(blocker.bbox, mover.bbox);
        shiftAtomicUnit(mover, delta.x, delta.y, result);
        moved = true;
      }
    }

    if (!moved) return;
  }
}

function chooseBlockerAndMover(
  first: PlacedAtomicUnit,
  second: PlacedAtomicUnit,
): [PlacedAtomicUnit, PlacedAtomicUnit] {
  if (first.grew && !second.grew) return [first, second];
  if (second.grew && !first.grew) return [second, first];
  return first.order <= second.order ? [first, second] : [second, first];
}

function displacementDelta(blocker: C4LayoutBox, mover: C4LayoutBox) {
  const overlapX =
    Math.min(blocker.x + blocker.width, mover.x + mover.width) -
    Math.max(blocker.x, mover.x);
  const overlapY =
    Math.min(blocker.y + blocker.height, mover.y + mover.height) -
    Math.max(blocker.y, mover.y);
  const centerDeltaX = centerX(mover) - centerX(blocker);
  const centerDeltaY = centerY(mover) - centerY(blocker);

  if (Math.abs(centerDeltaX) >= Math.abs(centerDeltaY) / 2) {
    return {
      x: (centerDeltaX < 0 ? -1 : 1) * (overlapX + C4_LAYOUT_ROOT_COLUMN_GAP),
      y: 0,
    };
  }

  return {
    x: 0,
    y: (centerDeltaY < 0 ? -1 : 1) * (overlapY + C4_LAYOUT_ROOT_ROW_GAP),
  };
}

function shiftAtomicUnit(
  unit: PlacedAtomicUnit,
  dx: number,
  dy: number,
  result: C4LayoutResult,
) {
  for (const nodeId of unit.nodeIds) {
    shiftBox(result.nodeBboxes, nodeId, dx, dy);
  }
  for (const groupId of unit.groupIds) {
    shiftBox(result.groupBboxes, groupId, dx, dy);
  }
  unit.bbox = {
    ...unit.bbox,
    x: unit.bbox.x + dx,
    y: unit.bbox.y + dy,
  };
}

function shiftBox(
  boxes: Map<string, C4LayoutBox>,
  id: string,
  dx: number,
  dy: number,
) {
  const box = boxes.get(id);
  if (!box) return;
  boxes.set(id, {
    ...box,
    x: box.x + dx,
    y: box.y + dy,
  });
}

function boxesOverlap(a: C4LayoutBox, b: C4LayoutBox) {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function requiredBox(boxes: ReadonlyMap<string, C4LayoutBox>, id: string) {
  const box = boxes.get(id);
  if (!box) {
    throw new Error(`Expected C4 layout box for "${id}".`);
  }
  return box;
}

function centerX(box: C4LayoutBox) {
  return box.x + box.width / 2;
}

function centerY(box: C4LayoutBox) {
  return box.y + box.height / 2;
}

function cardWidth(node: C4LayoutNode) {
  return node.width ?? C4_LAYOUT_CARD_WIDTH;
}

function cardHeight(node: C4LayoutNode) {
  return node.height ?? C4_LAYOUT_CARD_HEIGHT;
}
