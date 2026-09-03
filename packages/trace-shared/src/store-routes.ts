import { TRACE_STORE_API_PREFIX } from "./store-api.js";

export const DEVICE_CODE_PATH = "/api/auth/device/code" as const;
export const DEVICE_TOKEN_PATH = "/api/auth/device/token" as const;
export const SESSION_PATH = "/api/auth/get-session" as const;

export const storeRoutes = {
  stores: () => `${TRACE_STORE_API_PREFIX}/stores`,
  store: (repositoryId: number) =>
    `${TRACE_STORE_API_PREFIX}/stores/${repositoryId}`,
  sessions: (repositoryId: number) =>
    `${TRACE_STORE_API_PREFIX}/stores/${repositoryId}/sessions`,
  uploads: (repositoryId: number, sessionId: string) =>
    `${TRACE_STORE_API_PREFIX}/stores/${repositoryId}/sessions/${encodeURIComponent(sessionId)}/uploads`,
  uploadsComplete: (repositoryId: number, sessionId: string) =>
    `${storeRoutes.uploads(repositoryId, sessionId)}/complete`,
} as const;

// The server applies these patterns after it removes TRACE_STORE_API_PREFIX.
export const storeRoutePatterns = {
  stores: /^\/stores$/,
  store: /^\/stores\/(\d+)$/,
  sessions: /^\/stores\/(\d+)\/sessions$/,
  uploads: /^\/stores\/(\d+)\/sessions\/([^/]+)\/uploads$/,
  uploadsComplete: /^\/stores\/(\d+)\/sessions\/([^/]+)\/uploads\/complete$/,
} as const;
