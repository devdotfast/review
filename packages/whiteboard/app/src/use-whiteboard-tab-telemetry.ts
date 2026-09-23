import { useEffect, useEffectEvent, useRef } from "react";

import { useWhiteboardSession } from "./host/whiteboard-session";
import {
  type WhiteboardTabDwellTracker,
  type WhiteboardTelemetryTab,
  createWhiteboardTabDwellTracker,
  createWhiteboardTabTelemetryTransport,
} from "./tab-dwell-telemetry";
import { captureAppOpened } from "./ui-telemetry";
import type { WhiteboardView } from "./whiteboard-view-route";

/**
 * The diff moved from its own editor tab into a Review view. Telemetry keeps
 * reporting it as "files" so the dwell series stays continuous.
 */
export function whiteboardTelemetryTab(
  view: WhiteboardView,
): WhiteboardTelemetryTab {
  return view === "diff" ? "files" : view;
}

export function useWhiteboardTabTelemetry(activeView: WhiteboardView): void {
  const session = useWhiteboardSession();
  const appSessionId = session.appSessionId;
  const trackerRef = useRef<WhiteboardTabDwellTracker | null>(null);
  const telemetryTab = whiteboardTelemetryTab(activeView);
  const captureOpened = useEffectEvent(() => captureAppOpened(session));

  const send = useEffectEvent<
    Parameters<typeof createWhiteboardTabDwellTracker>[0]["send"]
  >((payload, options) => {
    createWhiteboardTabTelemetryTransport({
      endpoint: session.beaconUrl("/telemetry/tab"),
      navigator: window.navigator,
      fetch: window.fetch.bind(window),
    })(payload, options);
  });

  useEffect(() => {
    captureOpened();

    const tracker = createWhiteboardTabDwellTracker({
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
