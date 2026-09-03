import {
  type JsonValue,
  ReviewStatusSchema,
  jsonObject,
  jsonString,
} from "@dev.fast/review-protocol";
import { z } from "zod";

import { requireHealthyReviewDesktop } from "./desktop-discovery";
import type { StoredReview } from "./review-home";

export interface RunReviewInfoInput {
  cwd: string;
  all?: boolean;
  reviewUuid?: string;
}

export interface ReviewInfoEvent {
  event: "info";
  warnings?: string[];
  reviews: Array<{
    uuid: string;
    dir: string;
    change: string | null;
    inSync: boolean;
    matchesCheckout: boolean;
    unresolvedComments: number;
    status: StoredReview["review"]["status"];
    title: string;
  }>;
}

const ReviewInfoEventSchema: z.ZodType<ReviewInfoEvent> = z.object({
  event: z.literal("info"),
  warnings: z.array(z.string()).optional(),
  reviews: z.array(
    z.object({
      uuid: z.string(),
      dir: z.string(),
      change: z.string().nullable(),
      inSync: z.boolean(),
      matchesCheckout: z.boolean(),
      unresolvedComments: z.number(),
      status: ReviewStatusSchema,
      title: z.string(),
    }),
  ),
});

export async function runReviewInfo(
  input: RunReviewInfoInput,
): Promise<ReviewInfoEvent> {
  const discovery = await requireHealthyReviewDesktop("review info");
  const response = await fetch(`${discovery.url}/info`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-review-token": discovery.token,
    },
    body: JSON.stringify(input),
  });
  const payload: JsonValue = await response.json();
  if (!response.ok) {
    throw new Error(reviewInfoResponseError(payload, response.status));
  }
  return parseReviewInfoEvent(payload);
}

function parseReviewInfoEvent(value: JsonValue): ReviewInfoEvent {
  const parsed = ReviewInfoEventSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Review Desktop returned an invalid info response.");
  }
  return parsed.data;
}

function reviewInfoResponseError(payload: JsonValue, status: number): string {
  return (
    jsonString(jsonObject(payload)?.error) ??
    `Review Desktop returned ${status} for info.`
  );
}
