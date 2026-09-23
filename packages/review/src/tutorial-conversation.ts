import { z } from "zod";

export const tutorialAuthoringConversationSchema = z.strictObject({
  version: z.literal(1),
  title: z.string().trim().min(1),
  messages: z
    .array(
      z.strictObject({
        role: z.enum(["user", "assistant"]),
        body: z.string().trim().min(1),
      }),
    )
    .min(2),
});

export type TutorialAuthoringConversation = z.infer<
  typeof tutorialAuthoringConversationSchema
>;
