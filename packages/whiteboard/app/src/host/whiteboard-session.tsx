import type {
  WhiteboardCanvasBridge,
  WhiteboardCanvasDiagnostic,
  WhiteboardRuntimeConfig,
} from "@dev.fast/whiteboard-protocol";
import { type ReactNode, createContext, useContext } from "react";

import type { NormalizedSoftwareModel } from "../software-map/model";
import type { PinnedSoftwareMapData } from "../software-map/SoftwareMap";
import { createWhiteboardAppSessionId } from "../tab-dwell-telemetry";
import {
  type WhiteboardRequestOptions,
  jsonWhiteboardApiUrl,
  whiteboardStorageKey,
  whiteboardWasmUrl,
} from "./whiteboard-client";
import {
  type WhiteboardSurface,
  createWhiteboardSurface,
} from "./whiteboard-host";
import type { WhiteboardSessionData } from "./whiteboard-session-data";

export interface WhiteboardSession {
  review?: WhiteboardSessionData;
  appSessionId: string;
  bridge: WhiteboardCanvasBridge;
  config: WhiteboardRuntimeConfig;
  surface: WhiteboardSurface;
  softwareMapData?(
    model: NormalizedSoftwareModel,
  ): PinnedSoftwareMapData | undefined;
  apiUrl(endpoint: `/${string}`, options?: WhiteboardRequestOptions): string;
  fetch: (
    endpoint: `/${string}`,
    init?: RequestInit,
    options?: WhiteboardRequestOptions,
  ) => Promise<Response>;
  fetchUrl(url: string | URL, init?: RequestInit): Promise<Response>;
  beaconUrl(endpoint: `/${string}`): string;
  wasmUrl(): string;
  storageKey(
    namespace: string,
    ...parts: Array<string | number | undefined>
  ): string;
  theme(): WhiteboardRuntimeConfig["theme"];
  signalReady(): void;
  reportDiagnostic(diagnostic: WhiteboardCanvasDiagnostic): void;
}

export function createWhiteboardSession(
  bridge: WhiteboardCanvasBridge,
  options: { jsonWhiteboard: { id: string; version(): number | undefined } },
): WhiteboardSession {
  const config = bridge.config;
  const appSessionId = bridge.appSessionId ?? createWhiteboardAppSessionId();

  const request = (url: string | URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);

    if (config.token) headers.set("x-whiteboard-token", config.token);

    return bridge.request(String(url), { ...init, headers });
  };

  const apiUrl = (
    endpoint: `/${string}`,
    requestOptions?: WhiteboardRequestOptions,
  ) =>
    jsonWhiteboardApiUrl(config, options.jsonWhiteboard.id, endpoint, {
      version: options.jsonWhiteboard.version(),
      tokenInQuery: requestOptions?.tokenInQuery,
    });

  return {
    appSessionId,
    bridge,
    config,
    surface: createWhiteboardSurface(bridge),
    apiUrl,
    fetch: (endpoint, init, options) =>
      request(apiUrl(endpoint, options), init),
    fetchUrl: request,
    beaconUrl: (endpoint) => apiUrl(endpoint, { tokenInQuery: true }),
    wasmUrl: () => whiteboardWasmUrl(config),
    storageKey: (namespace, ...parts) =>
      whiteboardStorageKey(config, namespace, ...parts),
    theme: () => bridge.currentTheme(),
    signalReady: () => bridge.ready(),
    reportDiagnostic: (diagnostic) => bridge.reportDiagnostic?.(diagnostic),
  };
}

const WhiteboardSessionContext = createContext<WhiteboardSession | null>(null);

export function WhiteboardSessionProvider({
  session,
  children,
}: {
  session: WhiteboardSession;
  children: ReactNode;
}) {
  return (
    <WhiteboardSessionContext.Provider value={session}>
      {children}
    </WhiteboardSessionContext.Provider>
  );
}

export function useOptionalWhiteboardSession(): WhiteboardSession | null {
  return useContext(WhiteboardSessionContext);
}

export function useWhiteboardSession(): WhiteboardSession {
  const session = useOptionalWhiteboardSession();

  if (!session) {
    throw new Error(
      "useWhiteboardSession must be used within WhiteboardSessionProvider",
    );
  }

  return session;
}
