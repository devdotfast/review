import type {
  C4ElkEdgeSection,
  C4ElkLabel,
  C4ElkPoint,
  C4LabelDimensions,
  C4LabelObstacle,
  C4LayoutEntry,
} from "./c4-map-flow-types";

const C4_EDGE_LABEL_MAX_WIDTH = 132;
const C4_EDGE_LABEL_HORIZONTAL_PADDING = 16;
const C4_EDGE_LABEL_VERTICAL_PADDING = 8;
const C4_EDGE_LABEL_CHARS_PER_LINE = 18;
const C4_EDGE_LABEL_LINE_HEIGHT = 15;
const C4_EDGE_LABEL_LABEL_GUTTER = 8;
const C4_EDGE_LABEL_NODE_GUTTER = 14;
const C4_EDGE_LABEL_CANDIDATE_STEP = 28;
export const C4_EXPANDED_GROUP_LABEL_HEADER_HEIGHT = 70;

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

export function c4EdgeLabelNodeObstacles(
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

export function c4ElkLabelFromLayout(
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

export function estimateC4EdgeLabelDimensions(
  label: string,
): C4LabelDimensions {
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

export function c4EdgeLabelPoint(
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

export function c4PolylineMidpoint(points: C4ElkPoint[]): C4ElkPoint {
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
