import { z } from "zod";

import { type BlockDefinition, defineBlock, label } from "./definition.js";
import { type Block, blockSchema } from "./index.js";

export interface SectionBlock {
  id?: string;
  type: "section";
  title: string;
  defaultCollapsed?: boolean;
  status?: "pending" | "in_progress" | "complete";
  children: Block[];
}

// blockSchema is read inside z.lazy, after every module in the cycle has evaluated.
const schema: z.ZodType<SectionBlock> = defineBlock("section", {
  title: label,
  defaultCollapsed: z.boolean().optional(),
  status: z.enum(["pending", "in_progress", "complete"]).optional(),
  children: z.array(z.lazy((): z.ZodType<Block> => blockSchema)),
});

export const section: BlockDefinition<SectionBlock> = {
  type: "section",
  schema,
};
