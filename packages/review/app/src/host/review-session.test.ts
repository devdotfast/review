import { expect, it, vi } from "vitest";

import { testReviewBridge } from "../review-session-test-utils";
import { createReviewSession } from "./review-session";

it("sends JSON requests to the displayed version with authentication, including beacon delivery", async () => {
  const request = vi.fn<ReturnType<typeof testReviewBridge>["request"]>(
    async () => Response.json({ text: "copied" }),
  );

  let version = 2;

  const session = createReviewSession(testReviewBridge({}, { request }), {
    jsonReview: { id: "review/id", version: () => version },
  });

  await session.fetch("/copy-context", { method: "POST" });
  const [url, init] = request.mock.calls[0]!;
  expect(new URL(url).pathname).toBe("/sessions-api/review%2Fid/copy-context");
  expect(new URL(url).searchParams.get("version")).toBe("2");
  expect(new URL(url).searchParams.has("document")).toBe(false);
  expect(new Headers(init?.headers).get("x-review-token")).toBe("secret-token");

  version = 3;
  await session.fetch("/telemetry/event", { method: "POST" });
  expect(new URL(request.mock.calls[1]![0]).searchParams.get("version")).toBe(
    "3",
  );
  const beacon = new URL(session.beaconUrl("/telemetry/tab"));
  expect(beacon.pathname).toBe("/sessions-api/review%2Fid/telemetry/tab");
  expect(beacon.searchParams.get("version")).toBe("3");
  expect(beacon.searchParams.get("token")).toBe("secret-token");
});
