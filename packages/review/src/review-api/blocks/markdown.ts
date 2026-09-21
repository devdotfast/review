import { defineBlock, text } from "./definition.js";

export const markdown = {
  type: "markdown",
  schema: defineBlock("markdown", {
    markdown: text.describe(
      "Safe Markdown. Use [label](review-source:head/path#L10-L24) or base for a validated native source peek.",
    ),
  }),
} as const;
