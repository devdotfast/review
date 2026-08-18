import type {
  ReviewTabTelemetryReason,
  ReviewTelemetryTab,
} from "../../src/telemetry";

export type { ReviewTabTelemetryReason, ReviewTelemetryTab };

export interface ReviewTabDwellPayload {
  tab: ReviewTelemetryTab;
  duration_ms: number;
  reason: ReviewTabTelemetryReason;
  app_session_id: string;
}

export interface ReviewTabDwellTracker {
  setActiveTab(tab: ReviewTelemetryTab): void;
  handleVisibilityChange(visible: boolean): void;
  handlePageHide(): void;
  unmount(): void;
}

export interface ReviewTabDwellTrackerInput {
  initialTab: ReviewTelemetryTab;
  appSessionId: string;
  now: () => number;
  isVisible: () => boolean;
  send: (
    payload: ReviewTabDwellPayload,
    options: { pageExit: boolean },
  ) => void;
  minDurationMs?: number;
  maxDurationMs?: number;
}

export interface ReviewTabTelemetryTransportOptions {
  endpoint: string;
  fetch?: typeof fetch;
  navigator?: Pick<Navigator, "sendBeacon">;
}

export type ReviewTabTelemetryDelivery = "beacon" | "fetch" | "none";

export const MIN_REVIEW_TAB_DWELL_MS = 250;
export const MAX_REVIEW_TAB_DWELL_MS = 4 * 60 * 60 * 1_000;

export function createReviewTabDwellTracker(
  input: ReviewTabDwellTrackerInput,
): ReviewTabDwellTracker {
  const minDurationMs = input.minDurationMs ?? MIN_REVIEW_TAB_DWELL_MS;
  const maxDurationMs = input.maxDurationMs ?? MAX_REVIEW_TAB_DWELL_MS;
  let activeTab = input.initialTab;
  let segmentStartMs: number | null = input.isVisible() ? input.now() : null;

  const flush = (
    reason: ReviewTabTelemetryReason,
    options: { pageExit: boolean },
  ): void => {
    if (segmentStartMs === null) return;
    const elapsedMs = input.now() - segmentStartMs;
    segmentStartMs = null;
    if (!Number.isFinite(elapsedMs) || elapsedMs < minDurationMs) return;
    const durationMs = Math.round(Math.min(elapsedMs, maxDurationMs));
    if (durationMs < minDurationMs) return;
    input.send(
      {
        tab: activeTab,
        duration_ms: durationMs,
        reason,
        app_session_id: input.appSessionId,
      },
      options,
    );
  };

  const restartIfVisible = (): void => {
    segmentStartMs = input.isVisible() ? input.now() : null;
  };

  return {
    setActiveTab(tab) {
      if (tab === activeTab) return;
      flush("tab_change", { pageExit: false });
      activeTab = tab;
      restartIfVisible();
    },
    handleVisibilityChange(visible) {
      if (!visible) {
        flush("visibility_hidden", { pageExit: false });
        return;
      }
      if (segmentStartMs === null) {
        segmentStartMs = input.now();
      }
    },
    handlePageHide() {
      flush("pagehide", { pageExit: true });
    },
    unmount() {
      flush("unmount", { pageExit: true });
    },
  };
}

export function createReviewTabTelemetryTransport(
  options: ReviewTabTelemetryTransportOptions,
): (
  payload: ReviewTabDwellPayload,
  sendOptions: { pageExit: boolean },
) => ReviewTabTelemetryDelivery {
  return (payload, sendOptions) =>
    sendReviewTabTelemetryPayload(payload, {
      ...options,
      pageExit: sendOptions.pageExit,
    });
}

export function sendReviewTabTelemetryPayload(
  payload: ReviewTabDwellPayload,
  options: ReviewTabTelemetryTransportOptions & { pageExit: boolean },
): ReviewTabTelemetryDelivery {
  const endpoint = options.endpoint;
  const body = JSON.stringify(payload);
  if (options.pageExit && options.navigator?.sendBeacon) {
    try {
      if (options.navigator.sendBeacon(endpoint, body)) {
        return "beacon";
      }
    } catch {
      // Electron's vscode-file workbench cannot originate a beacon. The
      // keepalive fetch below remains valid for the loopback review server.
    }
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!fetchImpl) return "none";
  void fetchImpl(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    keepalive: options.pageExit,
  }).catch(() => undefined);
  return "fetch";
}

export function createReviewAppSessionId(
  cryptoApi:
    | Pick<Crypto, "getRandomValues" | "randomUUID">
    | undefined = globalThis.crypto,
): string {
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  if (cryptoApi?.getRandomValues) {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  }
  return `session_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 14)}`;
}
