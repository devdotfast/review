import { z } from "zod";

import {
  type TutorialAuthoringConversation,
  tutorialAuthoringConversationSchema,
} from "../../tutorial-conversation.js";
import { type BlockDefinition, defineBlock } from "./definition.js";
import { type Block, blockSchema } from "./index.js";

type TutorialContent =
  | { kind: "keymap" }
  | { kind: "conversation"; conversation: TutorialAuthoringConversation }
  | { kind: "view"; view: "review" | "commits" | "diff" | "map"; label: string }
  | { kind: "feature"; feature: "softwareMap"; children: Block[] };

export type TutorialBlock = { id?: string; type: "tutorial" } & TutorialContent;

const schema: z.ZodType<TutorialBlock> = z.discriminatedUnion("kind", [
  defineBlock("tutorial", { kind: z.literal("keymap") }),
  defineBlock("tutorial", {
    kind: z.literal("conversation"),
    conversation: tutorialAuthoringConversationSchema,
  }),
  defineBlock("tutorial", {
    kind: z.literal("view"),
    view: z.enum(["review", "commits", "diff", "map"]),
    label: z.string(),
  }),
  defineBlock("tutorial", {
    kind: z.literal("feature"),
    feature: z.literal("softwareMap"),
    children: z.array(z.lazy((): z.ZodType<Block> => blockSchema)),
  }),
]);

export const tutorial: BlockDefinition<TutorialBlock> = {
  type: "tutorial",
  schema,
};
