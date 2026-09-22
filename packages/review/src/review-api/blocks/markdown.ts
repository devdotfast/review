import { sourcePinsSchema } from "../../source.js";
import { defineBlock, text } from "./definition.js";

export const markdown = {
  type: "markdown",
  schema: defineBlock("markdown", {
    markdown: text.describe(
      "Safe Markdown. Use [label](review-source:head/path#L10-L24) or base for a validated native source peek.",
    ),
    pins: sourcePinsSchema
      .optional()
      .describe(
        "Repository and commits this block's review-source links resolve against, instead of the document's pins.",
      ),
  }),
} as const;
