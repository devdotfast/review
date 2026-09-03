import {
  type BeginUploadRequest,
  type BeginUploadResponse,
  type CompleteUploadRequest,
  type CompleteUploadResponse,
  type CreateStoreRequest,
  type ListSessionsQuery,
  type ListSessionsResponse,
  type StoreErrorCode,
  type StoreResponse,
  TRACE_STORE_API_PREFIX,
  TRACE_STORE_CLIENT_ID,
  beginUploadResponseSchema,
  completeUploadResponseSchema,
  listSessionsResponseSchema,
  storeErrorEnvelopeSchema,
  storeResponseSchema,
} from "@dev-fast/trace-shared";
import type { z } from "zod";

const DEFAULT_TIMEOUT_MS = 30_000;

export class StoreApiError extends Error {
  constructor(
    public readonly code: StoreErrorCode,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "StoreApiError";
  }
}

export interface StoreClientOptions {
  origin: string;
  token?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

type DeviceTokenResult =
  | { access_token: string }
  | { pending: "authorization_pending" | "slow_down" };

interface SessionResponse {
  user: { name: string };
}

export class StoreClient {
  private readonly origin: string;
  private readonly token: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: StoreClientOptions) {
    this.origin = options.origin;
    this.token = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async deviceCode(): Promise<DeviceCodeResponse> {
    return this.requestJson(
      "/api/auth/device/code",
      { client_id: TRACE_STORE_CLIENT_ID },
      undefined,
    );
  }

  async deviceToken(deviceCode: string): Promise<DeviceTokenResult> {
    const url = new URL("/api/auth/device/token", this.origin);
    const response = await this.fetchImpl(url.toString(), {
      method: "POST",
      headers: this.jsonHeaders(),
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: TRACE_STORE_CLIENT_ID,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.status === 400) {
      // SAFETY: a 400 from the device token endpoint carries an OAuth
      // device-flow error body; the read below only checks for the two
      // known polling codes and falls through to toStoreApiError otherwise.
      const body = (await response.json()) as { error?: string };
      if (
        body.error === "authorization_pending" ||
        body.error === "slow_down"
      ) {
        return { pending: body.error };
      }
    }
    if (!response.ok) {
      throw await this.toStoreApiError(response);
    }
    // SAFETY: a 2xx from the device token endpoint carries the OAuth
    // device-flow success body, which this client does not validate against
    // a zod schema because it is not part of the trace-shared contract.
    return (await response.json()) as { access_token: string };
  }

  async session(): Promise<SessionResponse> {
    return this.get<SessionResponse>("/api/auth/get-session", undefined);
  }

  async createStore(body: CreateStoreRequest): Promise<StoreResponse> {
    return this.requestJson(
      `${TRACE_STORE_API_PREFIX}/stores`,
      body,
      storeResponseSchema,
    );
  }

  async findStore(query: CreateStoreRequest): Promise<StoreResponse | null> {
    try {
      return await this.get(
        `${TRACE_STORE_API_PREFIX}/stores`,
        storeResponseSchema,
        new URLSearchParams({ owner: query.owner, name: query.name }),
      );
    } catch (error) {
      if (error instanceof StoreApiError && error.code === "not_found") {
        return null;
      }
      throw error;
    }
  }

  async beginUpload(
    repositoryId: number,
    sessionId: string,
    body: BeginUploadRequest,
  ): Promise<BeginUploadResponse> {
    return this.requestJson(
      `${TRACE_STORE_API_PREFIX}/stores/${repositoryId}/sessions/${sessionId}/begin-upload`,
      body,
      beginUploadResponseSchema,
    );
  }

  async completeUpload(
    repositoryId: number,
    sessionId: string,
    body: CompleteUploadRequest,
  ): Promise<CompleteUploadResponse> {
    return this.requestJson(
      `${TRACE_STORE_API_PREFIX}/stores/${repositoryId}/sessions/${sessionId}/complete-upload`,
      body,
      completeUploadResponseSchema,
    );
  }

  async listSessions(
    repositoryId: number,
    query: ListSessionsQuery,
  ): Promise<ListSessionsResponse> {
    const params = new URLSearchParams();
    if (query.commit) params.set("commit", query.commit);
    if (query.session) params.set("session", query.session);
    return this.get(
      `${TRACE_STORE_API_PREFIX}/stores/${repositoryId}/sessions`,
      listSessionsResponseSchema,
      params,
    );
  }

  private jsonHeaders(): Record<string, string> {
    return this.token
      ? {
          "content-type": "application/json",
          authorization: `Bearer ${this.token}`,
        }
      : { "content-type": "application/json" };
  }

  private async get<T>(
    path: string,
    schema: z.ZodType<T> | undefined,
    query?: URLSearchParams,
  ): Promise<T> {
    const url = new URL(path, this.origin);
    if (query) {
      for (const [key, value] of query) {
        url.searchParams.set(key, value);
      }
    }
    const headers: Record<string, string> = {};
    if (this.token) {
      headers.authorization = `Bearer ${this.token}`;
    }
    const response = await this.fetchImpl(url.toString(), {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw await this.toStoreApiError(response);
    }
    return this.parseJson(response, schema);
  }

  private async requestJson<T, Body>(
    path: string,
    body: Body,
    schema: z.ZodType<T> | undefined,
  ): Promise<T> {
    const url = new URL(path, this.origin);
    const response = await this.fetchImpl(url.toString(), {
      method: "POST",
      headers: this.jsonHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw await this.toStoreApiError(response);
    }
    return this.parseJson(response, schema);
  }

  private async parseJson<T>(
    response: Response,
    schema: z.ZodType<T> | undefined,
  ): Promise<T> {
    const raw = await response.json();
    // SAFETY: only session() omits a schema, and its response is not part of
    // the trace-shared contract; the caller's declared return type is the
    // sole source of truth for its shape.
    if (!schema) return raw as T;
    const result = schema.safeParse(raw);
    if (!result.success) {
      throw new Error(
        `Store API returned a response that does not match the contract: ${result.error.message}`,
      );
    }
    return result.data;
  }

  private async toStoreApiError(response: Response): Promise<StoreApiError> {
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      return new StoreApiError(
        "internal",
        response.status,
        "The store returned an unreadable response.",
      );
    }
    const result = storeErrorEnvelopeSchema.safeParse(raw);
    if (!result.success) {
      return new StoreApiError(
        "internal",
        response.status,
        "The store returned an error response that does not match the contract.",
      );
    }
    return new StoreApiError(
      result.data.error.code,
      response.status,
      result.data.error.message,
    );
  }
}
