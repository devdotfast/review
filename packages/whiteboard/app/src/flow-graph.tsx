import {
  BaseEdge,
  type Edge,
  type EdgeProps,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import ELK, { type ElkNode } from "elkjs/lib/elk.bundled.js";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";

import type {
  FlowDiagramBlock,
  FlowDiagramNode,
} from "../../src/session-api/blocks/flow_diagram";
import {
  type CoverageProgress,
  coverageProgress,
} from "../../src/viewed-coverage";
import { useWhiteboardDebugSettings } from "./debug-settings";
import { useMotionPhase } from "./draw-queue-provider";
import { ElementCountsText } from "./lens-counts";
import { useWhiteboardLenses } from "./whiteboard-lenses";

/**
 * Every flow surface: the document block, the Diff sidebar lens and the
 * fullscreen tour. ELK lays the graph out; React Flow draws it in a box that
 * fits the whole drawing to itself, so a node landing at the bottom of a
 * tall layout is still inside the box the reader is looking at. Nodes are
 * DOM, edges are paths, so the draw queue's phases apply as they do to a
 * sequence diagram. A decision is a dashed box, a terminal a pill.
 */
export function FlowGraph({
  block,
  direction = block.direction,
  selectedKey,
  onSelect,
  requireReady = false,
  interactive = false,
  height = 340,
}: {
  block: FlowDiagramBlock;
  direction?: "down" | "right";
  selectedKey?: string | null;
  requireReady?: boolean;
  /** Pan and zoom by hand, for the fullscreen tour. */
  interactive?: boolean;
  height?: number | string;
  onSelect(node: FlowDiagramNode): void;
}) {
  const { theme } = useWhiteboardDebugSettings();
  const [error, setError] = useState<string>();
  const [layout, setLayout] = useState<Layout>();
  const frame = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setError(undefined);
    void layoutFlow(block, direction)
      .then((result) => {
        if (!cancelled) setLayout(result);
      })
      .catch((error) => {
        if (!cancelled) setError(String(error));
      });

    return () => {
      cancelled = true;
    };
  }, [block, direction]);

  const nodes = useMemo<FlowNodeType[]>(
    () =>
      layout
        ? block.nodes.flatMap((node) => {
            const position = layout.nodes.get(node.key);

            if (!position) return [];

            return [
              {
                id: node.key,
                type: "flowNode",
                position,
                ...SIZE,
                draggable: false,
                selectable: false,
                data: {
                  node,
                  requireReady,
                  selected: selectedKey === node.key,
                  select: () => onSelect(node),
                },
              },
            ];
          })
        : [],
    [block, layout, requireReady, selectedKey, onSelect],
  );

  const edges = useMemo<FlowEdgeType[]>(
    () =>
      layout
        ? layout.edges.map((edge) => ({
            id: `${edge.index}:${edge.section}`,
            source: block.edges[edge.index]!.from,
            target: block.edges[edge.index]!.to,
            type: "flowEdge",
            selectable: false,
            markerEnd: ARROW,
            data: {
              unitId: block.edges[edge.index]!.id,
              label: block.edges[edge.index]!.label,
              dashed: block.edges[edge.index]!.style === "dashed",
              points: edge.points,
            },
          }))
        : [],
    [block, layout],
  );

  if (error) return <p role="alert">Could not lay out diagram: {error}</p>;

  if (!layout) return <p className="lens-diagram-note">Laying out flow…</p>;

  return (
    <div
      ref={frame}
      className="lens-flow"
      style={{ height }}
      aria-label={block.title}
    >
      <ReactFlowProvider>
        <ReactFlow
          colorMode={theme}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          minZoom={0.1}
          maxZoom={1}
          onNodeClick={(_, node) => {
            if (node.type === "flowNode") node.data.select();
          }}
          nodesDraggable={false}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          elementsSelectable={false}
          panActivationKeyCode={null}
          panOnDrag={interactive}
          preventScrolling={interactive}
          zoomOnScroll={interactive}
          zoomOnPinch={interactive}
          zoomOnDoubleClick={false}
          proOptions={{ hideAttribution: true }}
        >
          <FitToLayout layout={layout} frame={frame} />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}

const PADDING = 24;

const ARROW = {
  type: MarkerType.ArrowClosed,
  width: 14,
  height: 14,
  color: "var(--ink-muted)",
};

/**
 * Fits the box to the layout: ELK reports the drawing's size, the frame
 * reports its own, so the viewport is set outright instead of asking React
 * Flow to measure nodes first. Refits on every layout and every resize,
 * animated once the first fit has landed. Never enlarges past 1:1.
 */
function FitToLayout({
  layout,
  frame,
}: {
  layout: Layout;
  frame: RefObject<HTMLDivElement | null>;
}) {
  const flow = useReactFlow();
  const fitted = useRef(false);

  useEffect(() => {
    const element = frame.current;

    if (!element) return;

    const fit = () => {
      const { width, height } = element.getBoundingClientRect();

      if (!width || !height) return;

      const zoom = Math.min(
        1,
        (width - PADDING * 2) / Math.max(1, layout.width),
        (height - PADDING * 2) / Math.max(1, layout.height),
      );

      void flow.setViewport(
        {
          x: (width - layout.width * zoom) / 2,
          y: (height - layout.height * zoom) / 2,
          zoom,
        },
        { duration: fitted.current ? 300 : 0 },
      );
      fitted.current = true;
    };

    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);

    return () => observer.disconnect();
  }, [flow, frame, layout]);

  return null;
}

interface Layout {
  width: number;
  height: number;
  nodes: Map<string, { x: number; y: number }>;
  edges: {
    index: number;
    section: number;
    points: { x: number; y: number }[];
  }[];
}

const SIZE = { width: 210, height: 62 };

async function layoutFlow(
  block: FlowDiagramBlock,
  direction: "down" | "right" | undefined,
): Promise<Layout> {
  const result = await new ELK().layout<ElkNode>({
    id: "flow",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": direction === "right" ? "RIGHT" : "DOWN",
      "elk.spacing.nodeNode": "28",
      "elk.layered.spacing.nodeNodeBetweenLayers": "44",
    },
    children: block.nodes.map((node) => ({ id: node.key, ...SIZE })),
    edges: block.edges.map((edge, index) => ({
      id: String(index),
      sources: [edge.from],
      targets: [edge.to],
    })),
  });

  return {
    width: result.width ?? 240,
    height: result.height ?? 100,
    nodes: new Map(
      result.children?.map((node) => [
        node.id,
        { x: node.x ?? 0, y: node.y ?? 0 },
      ]),
    ),
    edges: (result.edges ?? []).flatMap((edge) =>
      (edge.sections ?? []).map((section, index) => ({
        index: Number(edge.id),
        section: index,
        points: [
          section.startPoint,
          ...(section.bendPoints ?? []),
          section.endPoint,
        ],
      })),
    ),
  };
}

interface FlowNodeData extends Record<string, unknown> {
  node: FlowDiagramNode;
  requireReady: boolean;
  selected: boolean;
  select(): void;
}

type FlowNodeType = Node<FlowNodeData, "flowNode">;

interface FlowEdgeData extends Record<string, unknown> {
  unitId: string | undefined;
  label: string | undefined;
  dashed: boolean;
  points: { x: number; y: number }[];
}

type FlowEdgeType = Edge<FlowEdgeData, "flowEdge">;

const change = (progress: CoverageProgress) =>
  progress.total.additions && progress.total.deletions
    ? "modified"
    : progress.total.additions
      ? "added"
      : progress.total.deletions
        ? "removed"
        : "unchanged";

function FlowNode({ data }: NodeProps<FlowNodeType>) {
  const { node, requireReady, selected } = data;
  const lenses = useWhiteboardLenses();
  const motion = useMotionPhase(node.id);

  const sources = node.attachments.flatMap((attachment) => attachment.sources);

  const availability = requireReady ? lenses?.availability(sources) : "ready";
  const unavailable = availability !== "ready";

  const progress =
    lenses?.stats(lenses.resolve(sources)) ?? coverageProgress([]);

  // The flow's onNodeClick handles the mouse; the keyboard lands here.
  const select = () => {
    if (!unavailable) data.select();
  };

  return (
    <div
      className={[
        "flow-node",
        "lens-flow-node",
        `lens-flow-node--${change(progress)}`,
        `lens-flow-node--${node.kind ?? "process"}`,
        selected ? "is-selected" : "",
        progress.state === "viewed" ? "is-viewed" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ width: SIZE.width, height: SIZE.height }}
      role="button"
      tabIndex={unavailable ? -1 : 0}
      aria-disabled={unavailable}
      aria-pressed={selected}
      aria-label={node.label}
      data-whiteboard-unit-id={node.id}
      data-motion={motion}
      title={
        unavailable
          ? availability === "pending"
            ? "Waiting for diff…"
            : "Source unavailable at these pins"
          : `${node.label} · Total +${progress.total.additions} −${progress.total.deletions}`
      }
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          select();
        }
      }}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="flow-node-handle"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        className="flow-node-handle"
      />
      <svg
        className="flow-node-shape"
        viewBox={`0 0 ${SIZE.width} ${SIZE.height}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <rect
          pathLength={1}
          x={0.5}
          y={0.5}
          width={SIZE.width - 1}
          height={SIZE.height - 1}
          rx={node.kind === "terminal" ? SIZE.height / 2 : 6}
        />
      </svg>
      <div className="flow-node-text">
        <span className="flow-node-label">
          {node.label.length > 26 ? `${node.label.slice(0, 25)}…` : node.label}
        </span>
        <span className="flow-node-caption lens-flow-caption">
          {unavailable ? (
            availability === "pending" ? (
              "…"
            ) : (
              "Unavailable"
            )
          ) : sources.length ? (
            <ElementCountsText progress={progress} />
          ) : (
            "Concept"
          )}
        </span>
      </div>
    </div>
  );
}

function FlowEdge({ id, data, markerEnd }: EdgeProps<FlowEdgeType>) {
  const motion = useMotionPhase(data?.unitId);

  if (!data) return null;

  const path = data.points
    .map((point, index) => `${index ? "L" : "M"}${point.x},${point.y}`)
    .join(" ");

  const start = data.points[0]!;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        className="lens-flow-edge"
        // The arrowhead is the last stroke.
        markerEnd={
          motion === "outline" || motion === "stroke" ? undefined : markerEnd
        }
        strokeDasharray={data.dashed ? "6 4" : undefined}
        pathLength={1}
        interactionWidth={0}
        data-whiteboard-unit-id={data.unitId}
        data-motion={motion}
      />
      {data.label && (
        <text
          className="lens-flow-edge-label"
          x={start.x + 7}
          y={start.y + 20}
          data-motion={motion}
        >
          {data.label.length > 28 ? `${data.label.slice(0, 27)}…` : data.label}
        </text>
      )}
    </>
  );
}

const nodeTypes = { flowNode: FlowNode };

const edgeTypes = { flowEdge: FlowEdge };
