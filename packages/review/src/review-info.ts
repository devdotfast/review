import {
  SessionApiClient,
  type SessionSummary,
} from "@dev.fast/review-protocol";

import { requireHealthyReviewDesktop } from "./desktop-discovery";
import { resolveReviewRoot } from "./runtime";

export interface RunReviewInfoInput {
  cwd: string;
  all?: boolean;
  sessionId?: string;
}

export interface ReviewInfoEvent {
  event: "info";
  sessions: SessionSummary[];
}

export async function runReviewInfo(
  input: RunReviewInfoInput,
  runtime = { requireHealthyReviewDesktop, resolveReviewRoot },
): Promise<ReviewInfoEvent> {
  if (input.all && input.sessionId)
    throw new Error("Review info cannot combine all and sessionId.");
  const discovery = await runtime.requireHealthyReviewDesktop("review info");

  const client = new SessionApiClient({
    serverUrl: discovery.url,
    apiPath: "/sessions-api",

    token: discovery.token,
  });

  // The API is mounted at "/sessions-api" and Hono matches strictly; "" is the
  // catalog route and "/" is a 404.
  const sessions = await client.read<SessionSummary[]>("");

  if (input.sessionId) {
    const selected = sessions.find(
      (review) => review.sessionId === input.sessionId,
    );

    if (!selected) throw new Error(`Review not found: ${input.sessionId}`);

    return { event: "info", sessions: [selected] };
  }

  const root = await runtime.resolveReviewRoot(input.cwd);

  return {
    event: "info",
    sessions: sessions.filter(
      (review) =>
        review.repositoryPath === root && (input.all || !review.dismissedAt),
    ),
  };
}
