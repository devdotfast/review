import type { ReviewRuntimeConfig } from "@dev.fast/review-protocol";

const REVIEW_API_PREFIX = "/__progressive-review";
export type ReviewClientConfig = Partial<
  Pick<
    ReviewRuntimeConfig,
    "routePath" | "serverUrl" | "sessionId" | "sessionUrl" | "token" | "wasmUrl"
  >
>;

export interface ReviewRequestOptions {
  origin?: string;
  routePath?: string;
  tokenInQuery?: boolean;
}

export function reviewApiUrl(
  config: ReviewClientConfig,
  endpoint: `/${string}`,
  options: ReviewRequestOptions = {},
): string {
  const origin = options.origin ?? config.sessionUrl;
  const pathname = `${REVIEW_API_PREFIX}${endpoint}`;
  const url = origin
    ? new URL(`${origin.replace(/\/$/, "")}${pathname}`)
    : new URL(pathname, browserOrigin());
  const routePath = options.routePath ?? config.routePath ?? "/";
  if (routePath !== "/") url.searchParams.set("document", routePath);
  if (options.tokenInQuery && config.token) {
    url.searchParams.set("token", config.token);
  }
  return origin || typeof window !== "undefined"
    ? url.href
    : `${url.pathname}${url.search}`;
}

export async function reviewFetch(
  config: ReviewClientConfig,
  endpoint: `/${string}`,
  init: RequestInit = {},
  options: ReviewRequestOptions = {},
): Promise<Response> {
  return reviewFetchUrl(config, reviewApiUrl(config, endpoint, options), init);
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

export function reviewBeaconUrl(
  config: ReviewClientConfig,
  endpoint: `/${string}`,
): string {
  return reviewApiUrl(config, endpoint, { tokenInQuery: true });
}

export function reviewWasmUrl(config: ReviewClientConfig): string {
  return config.wasmUrl || reviewApiUrl(config, "/libavoid.wasm");
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
    config?.routePath ?? "/",
    ...parts.map((part) => String(part ?? "")),
  ].join(":");
}

// Unlike reviewStorageKey, this omits the session and route: UI preferences
// like panel widths belong to the reader, not to one review session, so they
// outlive the session that set them.
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
