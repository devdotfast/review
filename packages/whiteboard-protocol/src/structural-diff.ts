import {
  type StructuralDiffEvent,
  StructuralDiffEventSchema,
} from "@dev.fast/diffr";
import { z } from "zod";

// Review transport errors are separate from diffr file outcomes.
const WhiteboardStructuralDiffErrorSchema = z.object({
  type: z.literal("error"),
  message: z.string(),
});

export type WhiteboardStructuralDiffEvent =
  | StructuralDiffEvent
  | z.infer<typeof WhiteboardStructuralDiffErrorSchema>;

const WhiteboardStructuralDiffEventSchema = z.union([
  StructuralDiffEventSchema,
  WhiteboardStructuralDiffErrorSchema,
]);

export function decodeWhiteboardStructuralDiffEvent(
  line: string,
): WhiteboardStructuralDiffEvent {
  try {
    return WhiteboardStructuralDiffEventSchema.parse(JSON.parse(line));
  } catch (cause) {
    throw new Error("Malformed diffr protocol record.", { cause });
  }
}
