import type { PostHogCaptureProperties } from "../posthog-capture-client";
import type { ReviewApiHooks } from "../review-api/http.js";
import type { ReviewSessionAgent, ReviewTelemetry } from "../review-telemetry";

/**
 * Review created, published and revoked, and agent authoring completed, as
 * server events. Authoring is complete at the first publish of a review an
 * agent created through `review api` or `review mcp`, timed from the review's
 * creation. Which reviews an agent created is known only to this process, so
 * a server restart between create and publish loses that one completion.
 */
export function reviewLifecycleTelemetry(
  telemetry: Pick<ReviewTelemetry, "captureEvent">,
  firstCreatedAt: (reviewId: string) => string | undefined,
  now: () => number = Date.now,
): ReviewApiHooks {
  const reported = new Set<string>();
  const authoring = new Map<string, ReviewSessionAgent | undefined>();

  const capture = (
    event: string,
    properties?: PostHogCaptureProperties,
    reviewUuid?: string,
  ) =>
    void telemetry.captureEvent(
      event,
      properties,
      reviewUuid ? { reviewUuid } : undefined,
    );

  return {
    onReviewCreated: ({ reviewId, kind, blocks, via, agentKind }) => {
      if (reported.has(reviewId)) return;
      reported.add(reviewId);

      if (via === "api" || via === "mcp") authoring.set(reviewId, agentKind);
      const properties: PostHogCaptureProperties = { kind, blocks, via };

      if (agentKind) properties.agent_kind = agentKind;
      capture("review_review_created", properties, reviewId);
    },
    sharing: {
      onPublished: ({ reviewId, version }) => {
        capture("review_review_published", { version }, reviewId);

        if (!authoring.has(reviewId)) return;
        const agentKind = authoring.get(reviewId);
        authoring.delete(reviewId);
        const createdAt = Date.parse(firstCreatedAt(reviewId) ?? "");

        if (Number.isNaN(createdAt)) return;

        const properties: PostHogCaptureProperties = {
          duration_ms: Math.max(0, now() - createdAt),
        };

        if (agentKind) properties.agent_kind = agentKind;
        capture("review_authoring_completed", properties, reviewId);
      },
      onRevoked: () => capture("review_review_revoked"),
    },
  };
}
