import type { ReviewRuntimeConfig } from "@dev.fast/review-protocol";

export type ReviewClientConfig = Partial<
  Pick<ReviewRuntimeConfig, "serverUrl" | "sessionId" | "token" | "wasmUrl">
>;

export interface ReviewRequestOptions {
  tokenInQuery?: boolean;
}

export function jsonReviewApiUrl(
  config: ReviewClientConfig,
  sessionId: string,
  endpoint: `/${string}`,
  options: { version?: number; tokenInQuery?: boolean } = {},
): string {
  const url = new URL(
    `${config.serverUrl?.replace(/\/$/, "") ?? browserOrigin()}/reviews-api/${encodeURIComponent(sessionId)}${endpoint}`,
  );

  if (options.version !== undefined)
    url.searchParams.set("version", String(options.version));

  if (options.tokenInQuery && config.token)
    url.searchParams.set("token", config.token);

  return url.href;
}

export async function reviewFetchUrl(
  config: ReviewClientConfig,
  url: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);

  if (config.token) headers.set("x-review-token", config.token);

  return fetch(url, { ...init, headers });
}

export function reviewWasmUrl(config: ReviewClientConfig): string {
  if (!config.wasmUrl) throw new Error("Review WASM asset URL is missing.");

  return config.wasmUrl;
}

export function reviewStorageKey(
  config: ReviewClientConfig | null,
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

// Unlike reviewStorageKey, this omits the review identity: UI preferences
// like panel widths belong to the reader, not to one review, so they
// apply across reviews.
export function reviewPreferenceKey(
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
