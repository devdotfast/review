import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

import {
  type ReviewSession,
  ReviewSessionProvider,
} from "./host/review-session";
import type { ReviewSessionData } from "./host/review-session-data";
import { testReviewSession } from "./review-session-test-utils";
import { useReviewTabTelemetry } from "./use-review-tab-telemetry";

let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function Telemetry() {
  useReviewTabTelemetry("review");

  return null;
}

it("keeps dwell continuous through live review updates and sends the latest version", () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const beacon = vi.spyOn(navigator, "sendBeacon").mockReturnValue(true);

  const request = vi.fn<ReviewSession["bridge"]["request"]>(async () =>
    Response.json({ ok: true }),
  );

  const base = testReviewSession({}, { request });

  const review: ReviewSessionData = {
    pins: { base: "base", head: "head" },
    historicalRevision: null,
    updatedAtMs: 0,
    traces: new Map(),
    listVersions: async () => [],
    stack: async () => [],
    dismiss: async () => {},
  };

  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);

  const render = (session: ReviewSession) =>
    act(() => {
      root!.render(
        <ReviewSessionProvider session={session}>
          <Telemetry />
        </ReviewSessionProvider>,
      );
    });

  render({
    ...base,
    review,
    beaconUrl: () => "http://localhost/telemetry?version=1",
  });
  now = 1000;
  render({
    ...base,
    review: { ...review, updatedAtMs: 1000 },
    beaconUrl: () => "http://localhost/telemetry?version=2",
  });

  expect(request).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body)).name).toBe(
    "app_opened",
  );
  expect(beacon).not.toHaveBeenCalled();
  now = 2500;
  act(() => window.dispatchEvent(new Event("pagehide")));

  expect(beacon).toHaveBeenCalledTimes(1);
  expect(beacon.mock.calls[0]?.[0]).toBe(
    "http://localhost/telemetry?version=2",
  );
  expect(JSON.parse(String(beacon.mock.calls[0]?.[1]))).toEqual({
    tab: "review",
    duration_ms: 2500,
    reason: "pagehide",
    app_session_id: base.appSessionId,
  });
});
