import { sourceSchema } from "../../source.js";
import { defineBlock, text } from "./definition.js";

export const code_peek = {
  type: "code_peek",
  schema: defineBlock("code_peek", {
    source: sourceSchema,
    // Not rendered yet.
    caption: text.optional(),
  }),
} as const;
