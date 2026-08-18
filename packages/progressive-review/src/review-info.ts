import { requireHealthyReviewDesktop } from "./desktop-discovery";
import type { StoredReview } from "./review-home";

export interface RunReviewInfoInput {
  cwd: string;
  all?: boolean;
}

export interface ReviewInfoEvent {
  event: "info";
  warnings?: string[];
  reviews: Array<{
    uuid: string;
    dir: string;
    change: string | null;
    inSync: boolean;
    unresolvedComments: number;
    status: StoredReview["review"]["status"];
    title: string;
  }>;
}

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
  const payload: unknown = await response.json();
  if (!response.ok) {
    throw new Error(reviewInfoResponseError(payload, response.status));
  }
  return parseReviewInfoEvent(payload);
}

function parseReviewInfoEvent(value: unknown): ReviewInfoEvent {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("event" in value) ||
    value.event !== "info" ||
    !("reviews" in value) ||
    !Array.isArray(value.reviews)
  ) {
    throw new Error("Review Desktop returned an invalid info response.");
  }
  return value as ReviewInfoEvent;
}

function reviewInfoResponseError(payload: unknown, status: number): string {
  if (
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    "error" in payload &&
    typeof payload.error === "string"
  ) {
    return payload.error;
  }
  return `Review Desktop returned ${status} for info.`;
}
