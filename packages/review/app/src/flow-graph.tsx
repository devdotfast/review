import ELK, { type ElkNode } from "elkjs/lib/elk.bundled.js";
import { useEffect, useId, useState } from "react";

import type {
  FlowDiagramBlock,
  FlowDiagramNode,
} from "../../src/review-api/blocks/flow_diagram";
import { coverageProgress } from "../../src/viewed-coverage";
import { ElementCounts } from "./lens-counts";
import { useReviewLenses } from "./review-lenses";

/** Shared SVG layout, node styling and unread counts for every flow surface. */
export function FlowGraph({
  block,
  direction = block.direction,
  selectedKey,
  onSelect,
  requireReady = false,
}: {
  block: FlowDiagramBlock;
  direction?: "down" | "right";
  selectedKey?: string | null;
  requireReady?: boolean;
  onSelect(node: FlowDiagramNode): void;
}) {
  const lenses = useReviewLenses();
  const [error, setError] = useState<string>();
  const marker = useId().replaceAll(":", "");

  const [layout, setLayout] = useState<{
    width: number;
    height: number;
    nodes: Map<string, { x: number; y: number }>;
    edges: {
      id: string;
      label?: string;
      dashed?: boolean;
      points: { x: number; y: number }[];
    }[];
  }>();

  useEffect(() => {
    let cancelled = false;
    setLayout(undefined);
    setError(undefined);
    void new ELK()
      .layout<ElkNode>({
        id: "flow",
        layoutOptions: {
          "elk.algorithm": "layered",
          "elk.direction": direction === "right" ? "RIGHT" : "DOWN",
          "elk.spacing.nodeNode": "28",
          "elk.layered.spacing.nodeNodeBetweenLayers": "44",
        },
        children: block.nodes.map((node) => ({
          id: node.key,
          width: 210,
          height: 62,
        })),
        edges: block.edges.map((edge, index) => ({
          id: String(index),
          sources: [edge.from],
          targets: [edge.to],
        })),
      })
      .then((result) => {
        if (!cancelled)
          setLayout({
            width: result.width ?? 240,
            height: result.height ?? 100,
            nodes: new Map(
              result.children?.map((node) => [
                node.id,
                { x: node.x ?? 0, y: node.y ?? 0 },
              ]),
            ),
            edges: (result.edges ?? []).flatMap((edge) =>
              (edge.sections ?? []).map((section) => ({
                id: edge.id,
                label: block.edges[Number(edge.id)].label,
                dashed: block.edges[Number(edge.id)].style === "dashed",
                points: [
                  section.startPoint,
                  ...(section.bendPoints ?? []),
                  section.endPoint,
                ],
              })),
            ),
          });
      })
      .catch((error) => {
        if (!cancelled) setError(String(error));
      });

    return () => {
      cancelled = true;
    };
  }, [block, direction]);

  if (error) return <p role="alert">Could not lay out diagram: {error}</p>;

  if (!layout) return <p className="lens-diagram-note">Laying out flow…</p>;

  return (
    <div className="lens-flow-scroll">
      <svg
        className="lens-flow"
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        style={{
          minWidth: Math.min(layout.width, 520),
          width: layout.width,
          maxWidth: "100%",
          marginInline: "auto",
        }}
        aria-label={block.title}
      >
        <defs>
          <marker
            id={marker}
            viewBox="0 0 10 10"
            refX={9}
            refY={5}
            markerWidth={5}
            markerHeight={5}
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 z" />
          </marker>
        </defs>
        {layout.edges.map((edge, index) => (
          <g
            key={`${edge.id}-${index}`}
            className="lens-flow-edge-group"
            data-review-unit-id={block.edges[Number(edge.id)]?.id}
          >
            <path
              className="lens-flow-edge"
              strokeDasharray={edge.dashed ? "6 4" : undefined}
              markerEnd={`url(#${marker})`}
              d={edge.points
                .map(
                  (point, index) => `${index ? "L" : "M"}${point.x},${point.y}`,
                )
                .join(" ")}
            />
            {edge.label && (
              <text
                className="lens-flow-edge-label"
                x={edge.points[0].x + 7}
                y={edge.points[0].y + 20}
              >
                {edge.label.length > 28
                  ? `${edge.label.slice(0, 27)}…`
                  : edge.label}
              </text>
            )}
          </g>
        ))}
        {block.nodes.map((node) => {
          const position = layout.nodes.get(node.key);

          if (!position) return null;

          const sources = node.attachments.flatMap(
            (attachment) => attachment.sources,
          );

          const availability = requireReady
            ? lenses?.availability(sources)
            : "ready";

          const unavailable = availability !== "ready";

          const progress =
            lenses?.stats(lenses.resolve(sources)) ?? coverageProgress([]);

          const change =
            progress.total.additions && progress.total.deletions
              ? "modified"
              : progress.total.additions
                ? "added"
                : progress.total.deletions
                  ? "removed"
                  : "unchanged";

          return (
            <g
              key={node.key}
              data-review-unit-id={node.id}
              transform={`translate(${position.x},${position.y})`}
              className={`flow-node lens-flow-node ${selectedKey === node.key ? "is-selected" : ""} lens-flow-node--${change} ${progress.state === "viewed" ? "is-viewed" : ""}`}
              role="button"
              tabIndex={unavailable ? -1 : 0}
              aria-disabled={unavailable}
              style={{ opacity: unavailable ? 0.45 : undefined }}
              aria-pressed={selectedKey === node.key}
              aria-label={node.label}
              onClick={() => {
                if (!unavailable) onSelect(node);
              }}
              onKeyDown={(event) => {
                if (
                  !unavailable &&
                  (event.key === "Enter" || event.key === " ")
                ) {
                  event.preventDefault();
                  onSelect(node);
                }
              }}
            >
              <title>
                {unavailable
                  ? availability === "pending"
                    ? "Waiting for diff…"
                    : "Source unavailable at these pins"
                  : `${node.label} · Total +${progress.total.additions} −${progress.total.deletions}`}
              </title>
              <rect
                width={210}
                height={62}
                rx={node.kind === "terminal" ? 28 : 6}
              />
              <text x={12} y={26}>
                {node.label.length > 26
                  ? `${node.label.slice(0, 25)}…`
                  : node.label}
              </text>
              <text className="lens-flow-caption" x={12} y={45}>
                {unavailable ? (
                  availability === "pending" ? (
                    "…"
                  ) : (
                    "Unavailable"
                  )
                ) : sources.length ? (
                  <ElementCounts progress={progress} />
                ) : (
                  "Concept"
                )}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
