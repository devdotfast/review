import { z } from "zod";

import {
  type StructuralDiffEvent,
  StructuralDiffEventSchema,
} from "./diffr-contract.js";

/** Review's HTTP transport can fail independently of diffr's per-file outcomes. */
const ReviewStructuralDiffErrorSchema = z.object({
  type: z.literal("error"),
  message: z.string(),
});

export type ReviewStructuralDiffEvent =
  | StructuralDiffEvent
  | z.infer<typeof ReviewStructuralDiffErrorSchema>;

const ReviewStructuralDiffEventSchema = z.union([
  StructuralDiffEventSchema,
  ReviewStructuralDiffErrorSchema,
]);

/** JSON is untrusted until the complete nested Rust wire contract validates. */
export function decodeStructuralDiffEvent(line: string): StructuralDiffEvent {
  return parseStructuralRecord(StructuralDiffEventSchema, line);
}

export function decodeReviewStructuralDiffEvent(
  line: string,
): ReviewStructuralDiffEvent {
  return parseStructuralRecord(ReviewStructuralDiffEventSchema, line);
}

function parseStructuralRecord<T>(schema: z.ZodType<T>, line: string): T {
  try {
    return schema.parse(JSON.parse(line));
  } catch (cause) {
    throw new Error("Malformed diffr protocol record.", { cause });
  }
}
