import type { WhiteboardRuntimeConfig } from "@dev.fast/whiteboard-protocol";

export type WhiteboardClientConfig = Partial<
  Pick<WhiteboardRuntimeConfig, "serverUrl" | "sessionId" | "token" | "wasmUrl">
>;

export interface WhiteboardRequestOptions {
  tokenInQuery?: boolean;
}

export function jsonWhiteboardApiUrl(
  config: WhiteboardClientConfig,
  sessionId: string,
  endpoint: `/${string}`,
  options: { version?: number; tokenInQuery?: boolean } = {},
): string {
  const url = new URL(
    `${config.serverUrl?.replace(/\/$/, "") ?? browserOrigin()}/sessions-api/${encodeURIComponent(sessionId)}${endpoint}`,
  );

  if (options.version !== undefined)
    url.searchParams.set("version", String(options.version));

  if (options.tokenInQuery && config.token)
    url.searchParams.set("token", config.token);

  return url.href;
}

export async function whiteboardFetchUrl(
  config: WhiteboardClientConfig,
  url: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);

  if (config.token) headers.set("x-whiteboard-token", config.token);

  return fetch(url, { ...init, headers });
}

export function whiteboardWasmUrl(config: WhiteboardClientConfig): string {
  if (!config.wasmUrl) throw new Error("Review WASM asset URL is missing.");

  return config.wasmUrl;
}

export function whiteboardStorageKey(
  config: WhiteboardClientConfig | null,
  namespace: string,
  ...parts: Array<string | number | undefined>
): string {
  return [
    "progressive-review",
    namespace,
    config?.sessionId ?? "server-render",
    ...parts.map((part) => String(part ?? "")),
  ].join(":");
}

// Unlike whiteboardStorageKey, this omits the review identity: UI preferences
// like panel widths belong to the reader, not to one review, so they
// apply across reviews.
export function whiteboardPreferenceKey(
  namespace: string,
  ...parts: Array<string | number | undefined>
): string {
  return [
    "progressive-review",
    namespace,
    ...parts.map((part) => String(part ?? "")),
  ].join(":");
}

function browserOrigin(): string {
  return typeof window === "undefined"
    ? "http://127.0.0.1"
    : window.location.origin;
}
