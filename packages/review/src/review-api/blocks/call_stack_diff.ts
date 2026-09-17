import { z } from "zod";

import { sourceSchema } from "../../source.js";
import { ReviewInputError } from "../input-error.js";
import {
  type BlockDefinition,
  defineBlock,
  identity,
  label,
} from "./definition.js";

export const frameSchema = z.strictObject({
  ...identity,
  // Optional component-local name for the same frame on both sides (even if moved).
  key: label.optional(),
  source: sourceSchema,
  label: label.optional(),
  via: z
    .strictObject({
      kind: z.enum(["call", "queue", "callback", "rpc"]),
      reason: label,
    })
    .optional(),
});

export type Frame = z.infer<typeof frameSchema>;

const schema = defineBlock("call_stack_diff", {
  title: label,
  base: z.array(frameSchema),
  head: z.array(frameSchema),
});

export type CallStackDiffBlock = z.infer<typeof schema>;

export const call_stack_diff = {
  type: "call_stack_diff",
  schema,
  check(block: CallStackDiffBlock) {
    for (const side of ["base", "head"] as const) {
      const keys = block[side].flatMap((frame) =>
        frame.key ? [frame.key] : [],
      );

      if (new Set(keys).size !== keys.length)
        throw new ReviewInputError(`Frame keys must be unique within ${side}.`);

      // Columns may compare two paths in one snapshot. Each source keeps its own pin.
    }
  },
} satisfies BlockDefinition<CallStackDiffBlock>;
