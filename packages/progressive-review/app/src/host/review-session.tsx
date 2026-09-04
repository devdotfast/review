import type {
  ReviewCanvasBridge,
  ReviewCanvasDiagnostic,
  ReviewRuntimeConfig,
} from "@dev.fast/review-protocol";
import { type ReactNode, createContext, useContext } from "react";

import { createReviewAppSessionId } from "../tab-dwell-telemetry";
import {
  type ReviewRequestOptions,
  reviewApiUrl,
  reviewBeaconUrl,
  reviewStorageKey,
  reviewWasmUrl,
} from "./review-client";
import { type ReviewSurface, createReviewSurface } from "./review-host";

export interface ReviewSession {
  appSessionId: string;
  bridge: ReviewCanvasBridge;
  config: ReviewRuntimeConfig;
  surface: ReviewSurface;
  apiUrl(endpoint: `/${string}`, options?: ReviewRequestOptions): string;
  fetch: (
    endpoint: `/${string}`,
    init?: RequestInit,
    options?: ReviewRequestOptions,
  ) => Promise<Response>;
  fetchUrl(url: string | URL, init?: RequestInit): Promise<Response>;
  beaconUrl(endpoint: `/${string}`): string;
  wasmUrl(): string;
  storageKey(
    namespace: string,
    ...parts: Array<string | number | undefined>
  ): string;
  theme(): ReviewRuntimeConfig["theme"];
  signalReady(): void;
  reportDiagnostic(diagnostic: ReviewCanvasDiagnostic): void;
}

export type ReviewFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

export function createReviewSession(
  bridge: ReviewCanvasBridge,
  fetchUrl: ReviewFetch = (url, init) => globalThis.fetch(url, init),
): ReviewSession {
  const config = bridge.config;
  const appSessionId = bridge.appSessionId ?? createReviewAppSessionId();
  const request = (url: string | URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (config.token) headers.set("x-review-token", config.token);
    return fetchUrl(String(url), { ...init, headers });
  };
  return {
    appSessionId,
    bridge,
    config,
    surface: createReviewSurface(bridge),
    apiUrl: (endpoint, options) => reviewApiUrl(config, endpoint, options),
    fetch: (endpoint, init, options) =>
      request(reviewApiUrl(config, endpoint, options), init),
    fetchUrl: request,
    beaconUrl: (endpoint) => reviewBeaconUrl(config, endpoint),
    wasmUrl: () => reviewWasmUrl(config),
    storageKey: (namespace, ...parts) =>
      reviewStorageKey(config, namespace, ...parts),
    theme: () => bridge.currentTheme(),
    signalReady: () => bridge.ready(),
    reportDiagnostic: (diagnostic) => bridge.reportDiagnostic?.(diagnostic),
  };
}

const ReviewSessionContext = createContext<ReviewSession | null>(null);

export function ReviewSessionProvider({
  session,
  children,
}: {
  session: ReviewSession;
  children: ReactNode;
}) {
  return (
    <ReviewSessionContext.Provider value={session}>
      {children}
    </ReviewSessionContext.Provider>
  );
}

export function useOptionalReviewSession(): ReviewSession | null {
  return useContext(ReviewSessionContext);
}

export function useReviewSession(): ReviewSession {
  const session = useOptionalReviewSession();
  if (!session) {
    throw new Error(
      "useReviewSession must be used within ReviewSessionProvider",
    );
  }
  return session;
}
