import { defineBlock, text } from "./definition.js";

/** Shared with sequence steps. */
export const codeFields = { language: text.default("text"), text };

export const code = {
  type: "code",
  schema: defineBlock("code", { ...codeFields, caption: text.optional() }),
} as const;
