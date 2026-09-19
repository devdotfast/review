import { z } from "zod";

import { sourceSchema } from "../../source.js";
import { ReviewInputError } from "../input-error.js";
import { type BlockDefinition, defineBlock, label } from "./definition.js";

export const flowNodeSchema = z.strictObject({
  key: label,
  label,
  description: z.string().optional(),
  kind: z.enum(["process", "decision", "terminal"]).optional(),
  attachments: z.array(
    z.strictObject({ label, sources: z.array(sourceSchema).min(1) }),
  ),
});

export const flowDiagramSchema = defineBlock("flow_diagram", {
  title: label,
  description: z.string().optional(),
  direction: z.enum(["right", "down"]).optional(),
  nodes: z.array(flowNodeSchema).min(1).max(100),
  edges: z
    .array(
      z.strictObject({
        from: label,
        to: label,
        label: z.string().optional(),
        style: z.enum(["solid", "dashed"]).optional(),
      }),
    )
    .max(300),
});

export type FlowDiagramBlock = z.infer<typeof flowDiagramSchema>;

export type FlowDiagramNode = z.infer<typeof flowNodeSchema>;

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
