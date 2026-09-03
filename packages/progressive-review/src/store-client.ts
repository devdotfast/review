import { type JsonValue, parseJsonText } from "@dev.fast/review-protocol";
import {
  type BeginUploadRequest,
  type BeginUploadResponse,
  type CompleteUploadRequest,
  type CompleteUploadResponse,
  type CreateStoreRequest,
  DEVICE_CODE_PATH,
  DEVICE_TOKEN_PATH,
  type ListSessionsQuery,
  type ListSessionsResponse,
  SESSION_PATH,
  type StoreErrorCode,
  type StoreResponse,
  TRACE_STORE_CLIENT_ID,
  beginUploadResponseSchema,
  completeUploadResponseSchema,
  listSessionsResponseSchema,
  storeErrorCodeSchema,
  storeErrorEnvelopeSchema,
  storeResponseSchema,
  storeRoutes,
} from "@dev.fast/trace-shared";
import { z } from "zod";

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The OAuth device-flow error shape used by the Better Auth device
 * endpoints, e.g. `{"error":"invalid_grant","error_description":"..."}`.
 * This is distinct from the store's own `storeErrorEnvelopeSchema`.
 */
const oauthDeviceErrorSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});

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
      DEVICE_CODE_PATH,
      { client_id: TRACE_STORE_CLIENT_ID },
      undefined,
    );
  }

  async deviceToken(deviceCode: string): Promise<DeviceTokenResult> {
    const url = new URL(DEVICE_TOKEN_PATH, this.origin);
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
      // The device token endpoint answers with an OAuth device-flow error
      // body, not the store's own error envelope. Read the body once here,
      // since the response stream cannot be read a second time.
      const raw = await this.readJsonBody(response);
      const oauthError = oauthDeviceErrorSchema.safeParse(raw);
      if (
        oauthError.success &&
        (oauthError.data.error === "authorization_pending" ||
          oauthError.data.error === "slow_down")
      ) {
        return { pending: oauthError.data.error };
      }
      throw this.oauthOrEnvelopeError(raw, response.status);
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
    return this.get<SessionResponse>(SESSION_PATH, undefined);
  }

  async createStore(body: CreateStoreRequest): Promise<StoreResponse> {
    return this.requestJson(storeRoutes.stores(), body, storeResponseSchema);
  }

  async findStore(query: CreateStoreRequest): Promise<StoreResponse | null> {
    try {
      return await this.get(
        storeRoutes.stores(),
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
      storeRoutes.uploads(repositoryId, sessionId),
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
      storeRoutes.uploadsComplete(repositoryId, sessionId),
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
      storeRoutes.sessions(repositoryId),
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
    if (!schema) {
      // SAFETY: only session() omits a schema. The caller defines that private
      // response because it is not part of the trace-shared contract.
      return raw as T;
    }
    const result = schema.safeParse(raw);
    if (!result.success) {
      throw new Error(
        `Store API returned a response that does not match the contract: ${result.error.message}`,
      );
    }
    return result.data;
  }

  private async toStoreApiError(response: Response): Promise<StoreApiError> {
    const raw = await this.readJsonBody(response);
    return this.oauthOrEnvelopeError(raw, response.status);
  }

  /**
   * Reads a response body once, as text, and parses it as JSON. Returns
   * `undefined` if the body cannot be read or is not valid JSON.
   */
  private async readJsonBody(
    response: Response,
  ): Promise<JsonValue | undefined> {
    let text: string;
    try {
      text = await response.text();
    } catch {
      return undefined;
    }
    try {
      return parseJsonText(text);
    } catch {
      return undefined;
    }
  }

  /**
   * Builds a StoreApiError from an already-parsed body, which is either the
   * store's own `{ error: { code, message } }` envelope or the OAuth
   * device-flow error shape `{ error, error_description }` used by the
   * Better Auth device endpoints.
   */
  private oauthOrEnvelopeError(
    raw: JsonValue | undefined,
    status: number,
  ): StoreApiError {
    if (raw === undefined) {
      return new StoreApiError(
        "internal",
        status,
        "The store returned an unreadable response.",
      );
    }
    const oauthError = oauthDeviceErrorSchema.safeParse(raw);
    if (oauthError.success) {
      const knownCode = storeErrorCodeSchema.safeParse(oauthError.data.error);
      return new StoreApiError(
        knownCode.success ? knownCode.data : "invalid_request",
        status,
        oauthError.data.error_description ?? oauthError.data.error,
      );
    }
    const result = storeErrorEnvelopeSchema.safeParse(raw);
    if (!result.success) {
      return new StoreApiError(
        "internal",
        status,
        "The store returned an error response that does not match the contract.",
      );
    }
    return new StoreApiError(
      result.data.error.code,
      status,
      result.data.error.message,
    );
  }
}
