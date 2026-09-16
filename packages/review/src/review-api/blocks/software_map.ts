import { defineBlock, label } from "./definition.js";

export const software_map = {
  type: "software_map",
  schema: defineBlock("software_map", {
    mapVersionId: label,
    focusElementId: label.optional(),
  }),
} as const;
