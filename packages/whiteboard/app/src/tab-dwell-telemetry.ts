import type {
  WhiteboardTabTelemetryReason,
  WhiteboardTelemetryTab,
} from "../../src/telemetry";

export type { WhiteboardTabTelemetryReason, WhiteboardTelemetryTab };

export interface WhiteboardTabDwellPayload {
  tab: WhiteboardTelemetryTab;
  duration_ms: number;
  reason: WhiteboardTabTelemetryReason;
  app_session_id: string;
}

export interface WhiteboardTabDwellTracker {
  setActiveTab(tab: WhiteboardTelemetryTab): void;
  handleVisibilityChange(visible: boolean): void;
  handlePageHide(): void;
  unmount(): void;
}

export interface WhiteboardTabDwellTrackerInput {
  initialTab: WhiteboardTelemetryTab;
  appSessionId: string;
  now: () => number;
  isVisible: () => boolean;
  send: (
    payload: WhiteboardTabDwellPayload,
    options: { pageExit: boolean },
  ) => void;
  minDurationMs?: number;
  maxDurationMs?: number;
}

export interface WhiteboardTabTelemetryTransportOptions {
  endpoint: string;
  fetch?: typeof fetch;
  navigator?: Pick<Navigator, "sendBeacon">;
}

export type WhiteboardTabTelemetryDelivery = "beacon" | "fetch" | "none";

export const MIN_WHITEBOARD_TAB_DWELL_MS = 250;

export const MAX_WHITEBOARD_TAB_DWELL_MS = 4 * 60 * 60 * 1_000;

export function createWhiteboardTabDwellTracker(
  input: WhiteboardTabDwellTrackerInput,
): WhiteboardTabDwellTracker {
  const minDurationMs = input.minDurationMs ?? MIN_WHITEBOARD_TAB_DWELL_MS;
  const maxDurationMs = input.maxDurationMs ?? MAX_WHITEBOARD_TAB_DWELL_MS;
  let activeTab = input.initialTab;
  let segmentStartMs: number | null = input.isVisible() ? input.now() : null;

  const flush = (
    reason: WhiteboardTabTelemetryReason,
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

export function createWhiteboardTabTelemetryTransport(
  options: WhiteboardTabTelemetryTransportOptions,
): (
  payload: WhiteboardTabDwellPayload,
  sendOptions: { pageExit: boolean },
) => WhiteboardTabTelemetryDelivery {
  return (payload, sendOptions) =>
    sendWhiteboardTabTelemetryPayload(payload, {
      ...options,
      pageExit: sendOptions.pageExit,
    });
}

export function sendWhiteboardTabTelemetryPayload(
  payload: WhiteboardTabDwellPayload,
  options: WhiteboardTabTelemetryTransportOptions & { pageExit: boolean },
): WhiteboardTabTelemetryDelivery {
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

export function createWhiteboardAppSessionId(
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
