import { defineBlock, label } from "./definition.js";

export const trace_quote = {
  type: "trace_quote",
  schema: defineBlock("trace_quote", {
    traceId: label,
    eventId: label,
    text: label,
  }),
} as const;
