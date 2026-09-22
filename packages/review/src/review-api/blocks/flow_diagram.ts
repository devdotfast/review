import { z } from "zod";

import { lensSourceSchema } from "../../lens-selection.js";
import { ReviewInputError } from "../input-error.js";
import {
  type BlockDefinition,
  defineBlock,
  identity,
  label,
} from "./definition.js";

/** Nodes and edges are the diagram's children: each is its own edit target,
 * so an agent can draw a diagram one unit at a time. Edges still name nodes
 * by their diagram-local key. */
export const flowNodeSchema = z.strictObject({
  ...identity,
  type: z.literal("flow_node").default("flow_node"),
  key: label,
  label,
  description: z.string().optional(),
  kind: z.enum(["process", "decision", "terminal"]).optional(),
  attachments: z.array(
    z.strictObject({ label, sources: z.array(lensSourceSchema).min(1) }),
  ),
});

export const flowEdgeSchema = z.strictObject({
  ...identity,
  type: z.literal("flow_edge").default("flow_edge"),
  from: label,
  to: label,
  label: z.string().optional(),
  style: z.enum(["solid", "dashed"]).optional(),
});

/** The edge a new node arrives with: `from` a node already drawn to this
 * one, or from this one `to` a node already drawn. Insert-time only; the
 * server stores it as an ordinary edge. */
export const flowLinkSchema = z.strictObject({
  from: label.optional(),
  to: label.optional(),
  label: z.string().optional(),
  style: z.enum(["solid", "dashed"]).optional(),
});

export const flowNodeInsertSchema = flowNodeSchema.extend({
  link: flowLinkSchema.optional(),
});

export type FlowLink = z.infer<typeof flowLinkSchema>;

export const flowDiagramSchema = defineBlock("flow_diagram", {
  title: label,
  description: z.string().optional(),
  direction: z.enum(["right", "down"]).optional(),
  nodes: z.array(flowNodeSchema).min(1).max(100),
  edges: z.array(flowEdgeSchema).max(300),
});

export type FlowDiagramBlock = z.infer<typeof flowDiagramSchema>;

export type FlowDiagramNode = z.infer<typeof flowNodeSchema>;

export type FlowDiagramEdge = z.infer<typeof flowEdgeSchema>;

export const flow_diagram = {
  type: "flow_diagram",
  schema: flowDiagramSchema,
  check(block: FlowDiagramBlock) {
    const keys = new Set(block.nodes.map((node) => node.key));

    if (keys.size !== block.nodes.length)
      throw new ReviewInputError(
        "Flow node keys must be unique within the diagram.",
      );

    for (const edge of block.edges) {
      if (!keys.has(edge.from) || !keys.has(edge.to))
        throw new ReviewInputError(
          `Unknown flow endpoint: ${edge.from} → ${edge.to}`,
        );
    }
  },
} satisfies BlockDefinition<FlowDiagramBlock>;
