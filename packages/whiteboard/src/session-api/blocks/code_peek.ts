import { diffSelectionSchema } from "../../lens-selection.js";
import { defineBlock, text } from "./definition.js";

export const code_peek = {
  type: "code_peek",
  schema: defineBlock("code_peek", {
    source: diffSelectionSchema,
    // Not rendered yet.
    caption: text.optional(),
  }),
} as const;
