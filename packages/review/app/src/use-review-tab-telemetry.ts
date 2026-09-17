import { useEffect, useEffectEvent, useRef } from "react";

import { useReviewSession } from "./host/review-session";
import type { ReviewView } from "./review-view-route";
import {
  type ReviewTabDwellTracker,
  type ReviewTelemetryTab,
  createReviewTabDwellTracker,
  createReviewTabTelemetryTransport,
} from "./tab-dwell-telemetry";
import { captureAppOpened } from "./ui-telemetry";

/**
 * The diff moved from its own editor tab into a Review view. Telemetry keeps
 * reporting it as "files" so the dwell series stays continuous.
 */
export function reviewTelemetryTab(view: ReviewView): ReviewTelemetryTab {
  return view === "diff" ? "files" : view;
}

export function useReviewTabTelemetry(activeView: ReviewView): void {
  const session = useReviewSession();
  const appSessionId = session.appSessionId;
  const trackerRef = useRef<ReviewTabDwellTracker | null>(null);
  const telemetryTab = reviewTelemetryTab(activeView);
  const captureOpened = useEffectEvent(() => captureAppOpened(session));

  const send = useEffectEvent<
    Parameters<typeof createReviewTabDwellTracker>[0]["send"]
  >((payload, options) => {
    createReviewTabTelemetryTransport({
      endpoint: session.beaconUrl("/telemetry/tab"),
      navigator: window.navigator,
      fetch: window.fetch.bind(window),
    })(payload, options);
  });

  useEffect(() => {
    captureOpened();

    const tracker = createReviewTabDwellTracker({
      initialTab: telemetryTab,
      appSessionId,
      now: () => performance.now(),
      isVisible: () => document.visibilityState === "visible",
      send,
    });

    trackerRef.current = tracker;

    const handleVisibilityChange = () => {
      tracker.handleVisibilityChange(document.visibilityState === "visible");
    };

    const handlePageHide = () => {
      tracker.handlePageHide();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", handlePageHide);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", handlePageHide);
      tracker.unmount();
      trackerRef.current = null;
    };
  }, [appSessionId]);

  useEffect(() => {
    trackerRef.current?.setActiveTab(telemetryTab);
  }, [telemetryTab]);
}
