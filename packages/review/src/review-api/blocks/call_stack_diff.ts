import { z } from "zod";

import { lensSourceSchema } from "../../lens-selection.js";
import { SessionInputError } from "../input-error.js";
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
  parentKey: label.nullable().optional(),
  callSite: lensSourceSchema.optional(),
  source: lensSourceSchema,
  contextSources: z
    .array(lensSourceSchema)
    .max(1000)
    .optional()
    .describe(
      "Supporting code owned by this frame, such as field initializers. These ranges share the frame’s diff section and coverage; they do not create call edges.",
    ),
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
        throw new SessionInputError(
          `Frame keys must be unique within ${side}.`,
        );

      for (const [index, frame] of block[side].entries()) {
        if (
          frame.parentKey &&
          !block[side]
            .slice(0, index)
            .some((parent) => parent.key === frame.parentKey)
        )
          throw new SessionInputError(
            "A frame parentKey must name an earlier frame on the same side.",
          );
      }

      // Columns may compare two paths in one snapshot. Each source keeps its own pin.
    }
  },
} satisfies BlockDefinition<CallStackDiffBlock>;
