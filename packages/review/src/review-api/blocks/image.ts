import { defineBlock, label, text } from "./definition.js";

export const image = {
  type: "image",
  schema: defineBlock("image", {
    assetId: label,
    alt: label,
    caption: text.optional(),
  }),
} as const;
