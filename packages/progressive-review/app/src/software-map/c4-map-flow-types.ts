import type { Node as ReactFlowNode } from "@xyflow/react";

import type {
  SoftwareMapNodeSnapshot,
  SoftwareMapRelationshipSnapshot,
} from "./software-map-snapshot";

export interface C4MapNodeData extends Record<string, unknown> {
  node: SoftwareMapNodeSnapshot;
  selected: boolean;
  diagram: string;
  targetPath: string[];
  onSelect?: (node: SoftwareMapNodeSnapshot) => void;
  onExpandNode?: (node: SoftwareMapNodeSnapshot) => void;
  onCollapseNode?: (node: SoftwareMapNodeSnapshot) => void;
  onDrillNode?: (node: SoftwareMapNodeSnapshot) => void;
}

export type C4MapFlowNode = ReactFlowNode<C4MapNodeData, "softwareMapC4">;
export type C4MapFlowGroupNode = ReactFlowNode<
  C4MapNodeData,
  "softwareMapC4Group"
>;
export type C4MapAnyFlowNode = C4MapFlowNode | C4MapFlowGroupNode;
export type C4MapInteractionMode = "inline" | "standalone";

export interface C4MapEdgeData extends Record<string, unknown> {
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

export interface C4LayoutEntry {
  node: SoftwareMapNodeSnapshot;
  x: number;
  y: number;
  width: number;
  height: number;
  expandedGroup?: boolean;
}

export interface C4LayoutResult {
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

export interface C4ElkPoint {
  x: number;
  y: number;
}

export interface C4EdgeEndpointBubble extends C4ElkPoint {
  endpoint: "source";
  hovered: boolean;
}

export interface C4ElkEdgeSection {
  startPoint: C4ElkPoint;
  bendPoints?: C4ElkPoint[];
  endPoint: C4ElkPoint;
}

export interface C4ElkLabel {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type C4LabelObstacle = C4ElkLabel;

export interface C4NodeDimensions {
  width: number;
  height: number;
}

export interface C4LabelDimensions {
  width: number;
  height: number;
}
