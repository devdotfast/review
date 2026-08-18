import type { ReviewRuntimeConfig } from "@dev.fast/review-protocol";

const REVIEW_API_PREFIX = "/__progressive-review";
const reviewModuleCache = new Map<string, Promise<unknown>>();

export type ReviewClientConfig = Partial<
  Pick<
    ReviewRuntimeConfig,
    | "docRuntimeUrl"
    | "routePath"
    | "serverUrl"
    | "sessionId"
    | "sessionUrl"
    | "token"
    | "wasmUrl"
  >
>;

export type ReviewModuleImporter = (url: string) => Promise<unknown>;

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

export function reviewEventSource(
  config: ReviewClientConfig,
  endpoint: `/${string}`,
  options: Omit<ReviewRequestOptions, "tokenInQuery"> = {},
): EventSource {
  return new EventSource(
    reviewApiUrl(config, endpoint, { ...options, tokenInQuery: true }),
  );
}

export function importReviewModule<T>(
  config: ReviewClientConfig,
  moduleUrl: string,
  importModule: ReviewModuleImporter = importBlobReviewModule,
): Promise<T> {
  const url = new URL(moduleUrl, config.serverUrl ?? browserOrigin());
  if (config.token) url.searchParams.set("token", config.token);
  if (!config.docRuntimeUrl) {
    return Promise.reject(
      new Error("Review document runtime URL is unavailable."),
    );
  }
  const docRuntimeUrl = config.docRuntimeUrl;
  const cacheKey = `${url.href}\u0000${docRuntimeUrl}`;
  const cached = reviewModuleCache.get(cacheKey);
  if (cached) return cached as Promise<T>;

  const pending: Promise<unknown> = loadReviewModule(
    config,
    url,
    docRuntimeUrl,
    importModule,
  ).catch((error) => {
    if (reviewModuleCache.get(cacheKey) === pending) {
      reviewModuleCache.delete(cacheKey);
    }
    throw error;
  });
  reviewModuleCache.set(cacheKey, pending);
  return pending as Promise<T>;
}

async function loadReviewModule(
  config: ReviewClientConfig,
  url: URL,
  docRuntimeUrl: string,
  importModule: ReviewModuleImporter,
): Promise<unknown> {
  const response = await reviewFetchUrl(config, url);
  if (!response.ok) {
    throw new Error(`Review document module returned ${response.status}.`);
  }
  const source = await response.text();
  const rewritten = rewriteReviewDocumentRuntime(source, docRuntimeUrl);
  // Published bundles carry no origin or token; hand the runtime this
  // session's request context before the document module evaluates.
  const runtime = (await importModule(new URL(docRuntimeUrl).href)) as {
    setReviewRequestContext?: (context: {
      origin?: string;
      token?: string;
    }) => void;
  };
  runtime.setReviewRequestContext?.({
    origin: config.sessionUrl,
    token: config.token,
  });
  const blobUrl = URL.createObjectURL(
    new Blob([rewritten], { type: "text/javascript" }),
  );
  try {
    return await importModule(blobUrl);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

function importBlobReviewModule(url: string): Promise<unknown> {
  return import(/* @vite-ignore */ url);
}

export function rewriteReviewDocumentRuntime(
  source: string,
  runtimeUrl: string,
): string {
  const runtimeSpecifier = JSON.stringify("review-doc-runtime");
  if (!source.includes(runtimeSpecifier)) {
    throw new Error("Review document module has no runtime import.");
  }
  return source
    .split(runtimeSpecifier)
    .join(JSON.stringify(new URL(runtimeUrl).href));
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

export function reviewAuthHeaders(
  config: ReviewClientConfig | null,
): HeadersInit {
  return config?.token ? { "x-review-token": config.token } : {};
}

function browserOrigin(): string {
  return typeof window === "undefined"
    ? "http://127.0.0.1"
    : window.location.origin;
}
