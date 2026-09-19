import { z } from "zod";

import { codeEvidenceSchema } from "../../source.js";
import { codeFields } from "./code.js";
import {
  type BlockDefinition,
  defineBlock,
  identity,
  label,
  requireKey,
  text,
} from "./definition.js";

export const stepSchema = z
  .strictObject({
    ...identity,
    type: z.literal("step").default("step"),
    from: label,
    to: label,
    label,
    style: z.enum(["call", "return", "async"]).default("call"),
    source: codeEvidenceSchema.optional(),
    explanation: label.optional(),
    code: z.strictObject(codeFields).optional(),
  })
  .refine(
    (s) =>
      [s.source, s.explanation, s.code].filter((v) => v !== undefined)
        .length === 1,
    "A step needs exactly one of source, explanation, or code.",
  );

export type Step = z.infer<typeof stepSchema>;

/** Kept for callers that parsed sequences directly. */
export const sequenceSchema = defineBlock("sequence", {
  title: label,
  actors: z.record(text, label),
  steps: z.array(stepSchema),
});

export type SequenceBlock = z.infer<typeof sequenceSchema>;

export const sequence = {
  type: "sequence",
  schema: sequenceSchema,
  check(block: SequenceBlock) {
    for (const step of block.steps) {
      requireKey(block.actors, step.from);
      requireKey(block.actors, step.to);
    }
  },
} satisfies BlockDefinition<SequenceBlock>;
