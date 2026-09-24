import { describe, expect, it } from "vitest";

import { reviewLifecycleTelemetry } from "./review-lifecycle-telemetry";

function harness() {
  const events: Array<[string, object | undefined, object | undefined]> = [];
  let now = Date.parse("2026-09-23T10:05:00.000Z");

  const hooks = reviewLifecycleTelemetry(
    {
      captureEvent: async (event, properties, context) => {
        events.push([event, properties, context]);
      },
    },
    () => "2026-09-23T10:00:00.000Z",
    () => now,
  );

  return {
    events,
    hooks,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("reviewLifecycleTelemetry", () => {
  it("reports each created review once, with its origin", () => {
    const { events, hooks } = harness();

    const created = {
      reviewId: "r1",
      kind: "review" as const,
      blocks: 0,
      via: "mcp" as const,
      agentKind: "claude" as const,
    };

    hooks.onReviewCreated?.(created);
    hooks.onReviewCreated?.(created);
    hooks.onReviewCreated?.({
      ...created,
      reviewId: "r2",
      via: "other",
      agentKind: undefined,
    });

    expect(events).toEqual([
      [
        "review_review_created",
        { kind: "review", blocks: 0, via: "mcp", agent_kind: "claude" },
        { reviewUuid: "r1" },
      ],
      [
        "review_review_created",
        { kind: "review", blocks: 0, via: "other" },
        { reviewUuid: "r2" },
      ],
    ]);
  });

  it("completes agent authoring at the first publish, timed from creation", () => {
    const { events, hooks, advance } = harness();

    hooks.onReviewCreated?.({
      reviewId: "agent",
      kind: "review",
      blocks: 0,
      via: "api",
      agentKind: "codex",
    });
    hooks.onReviewCreated?.({
      reviewId: "human",
      kind: "review",
      blocks: 0,
      via: "other",
    });
    events.length = 0;

    hooks.sharing?.onPublished?.({ reviewId: "human", version: 0 });
    hooks.sharing?.onPublished?.({ reviewId: "agent", version: 3 });
    advance(1_000);
    hooks.sharing?.onPublished?.({ reviewId: "agent", version: 4 });
    hooks.sharing?.onRevoked?.({ shareId: "s1" });

    expect(events).toEqual([
      ["review_review_published", { version: 0 }, { reviewUuid: "human" }],
      ["review_review_published", { version: 3 }, { reviewUuid: "agent" }],
      [
        "review_authoring_completed",
        { duration_ms: 300_000, agent_kind: "codex" },
        { reviewUuid: "agent" },
      ],
      ["review_review_published", { version: 4 }, { reviewUuid: "agent" }],
      ["review_review_revoked", undefined, undefined],
    ]);
  });
});
