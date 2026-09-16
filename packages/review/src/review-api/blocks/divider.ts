import { defineBlock } from "./definition.js";

export const divider = {
  type: "divider",
  schema: defineBlock("divider", {}),
} as const;
