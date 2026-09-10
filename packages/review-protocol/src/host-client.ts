import { z } from "zod";

import { HostPrincipalSchema } from "./host-api.js";
import {
  HOST_COMMAND_DEFINITIONS,
  HOST_QUERY_DEFINITIONS,
  type HostApiError,
  HostApiErrorSchema,
  type HostCommandInputs,
  type HostCommandName,
  type HostCommandResponse,
  HostCursorSchema,
  type HostQueryInputs,
  type HostQueryName,
  type HostQueryResponse,
  hostCommandResponseSchema,
  hostQueryResponseSchema,
} from "./host-commands.js";
import { validateHostDocument } from "./host-document-operations.js";
import {
  type HostDocumentCommit,
  HostDocumentCommitSchema,
  type HostDocumentState,
  HostDocumentStateSchema,
  HostIdSchema,
} from "./host-document.js";
import { type JsonValue, parseJsonText } from "./json.js";

export const HostConnectionSchema = z.strictObject({
  apiVersion: z.literal(1),
  hostId: HostIdSchema,
  workspaceId: HostIdSchema,
  principal: HostPrincipalSchema,
});
export type HostConnection = z.infer<typeof HostConnectionSchema>;

export const HostEventSchema = z.strictObject({
  cursor: HostCursorSchema,
  reviewId: HostIdSchema.nullable(),
  type: z.string().min(1).max(100),
  payload: z.json(),
});
export type HostEvent = z.infer<typeof HostEventSchema>;

export class ReviewClientError extends Error {
  constructor(readonly detail: HostApiError) {
    super(detail.message);
    this.name = "ReviewClientError";
  }
}

export interface ReviewClientOptions {
  serverUrl: string;
  token: string;
  clientId?: string;
  fetch?: typeof globalThis.fetch;
  /** Initial retry delay; increases up to 15 seconds after failed connections. */
  reconnectDelayMs?: number;
}

export interface HostEventSubscription {
  after: string;
  reviewId?: string;
  signal: AbortSignal;
  /** Return a snapshot cursor after resynchronizing to discard older replay. */
  onEvent(event: HostEvent): Promise<string | void> | string | void;
  onReset(): Promise<string>;
  onError?(error: Error): void;
}

/** Authenticated HTTP transport; contains no local repository or disk access. */
export class ReviewClient {
  readonly clientId: string;
  private readonly request: typeof globalThis.fetch;
  private readonly serverUrl: string;

  private constructor(
    private readonly options: ReviewClientOptions,
    readonly connection: HostConnection,
  ) {
    this.clientId = HostIdSchema.parse(options.clientId ?? crypto.randomUUID());
    this.request = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.serverUrl = options.serverUrl.replace(/\/$/, "");
  }

  static async connect(options: ReviewClientOptions, signal?: AbortSignal) {
    const response = await (options.fetch ?? globalThis.fetch)(
      `${options.serverUrl.replace(/\/$/, "")}/v1/connection`,
      { headers: { "x-review-token": options.token }, signal },
    );
    const value = parseJsonText(await response.text());
    if (!response.ok) throw hostClientResponseError(value);
    return new ReviewClient(options, HostConnectionSchema.parse(value));
  }

  async query<K extends HostQueryName>(
    type: K,
    input: HostQueryInputs[K],
    signal?: AbortSignal,
  ) {
    const value = await this.post(
      "queries",
      JSON.stringify({
        ...this.envelope(),
        type,
        input: HOST_QUERY_DEFINITIONS[type].input.parse(input),
      }),
      signal,
    );
    // SAFETY: The response schema is selected by precisely this operation key.
    const response = hostQueryResponseSchema(type).parse(
      value,
    ) as HostQueryResponse<K>;
    if (!response.ok) throw new ReviewClientError(response.error);
    return response.data;
  }

  async command<K extends HostCommandName>(
    type: K,
    input: HostCommandInputs[K],
    options: { commandId?: string; signal?: AbortSignal } = {},
  ) {
    const commandId = HostIdSchema.parse(
      options.commandId ?? crypto.randomUUID(),
    );
    const value = await this.post(
      "commands",
      JSON.stringify({
        ...this.envelope(),
        commandId,
        type,
        input: HOST_COMMAND_DEFINITIONS[type].input.parse(input),
      }),
      options.signal,
    );
    // SAFETY: The selected schema preserves the command's input/result pairing.
    const response = hostCommandResponseSchema(type).parse(
      value,
    ) as HostCommandResponse<K>;
    if (!response.ok) throw new ReviewClientError(response.error);
    if (response.data.commandId !== commandId)
      throw new Error("The host returned a different command receipt.");
    return response.data;
  }

  /** Every subscription has its own cursor, replay state and abort controller. */
  async subscribe(options: HostEventSubscription): Promise<void> {
    let cursor = options.after;
    let delay = this.options.reconnectDelayMs ?? 500;
    const seen = new Set<string>();
    while (!options.signal.aborted) {
      try {
        const url = new URL(this.url("events"));
        url.searchParams.set("after", cursor);
        if (options.reviewId)
          url.searchParams.set("reviewId", options.reviewId);
        const response = await this.request(url, {
          headers: {
            "x-review-token": this.options.token,
            accept: "text/event-stream",
          },
          signal: options.signal,
        });
        if (!response.ok)
          throw hostClientResponseError(parseJsonText(await response.text()));
        if (
          !response.body ||
          !response.headers.get("content-type")?.startsWith("text/event-stream")
        )
          throw new Error("The host did not return an event stream.");
        for await (const frame of hostClientFrames(response.body)) {
          if (options.signal.aborted) return;
          const event = HostEventSchema.parse(parseJsonText(frame.data));
          if (frame.id !== event.cursor)
            throw new Error("The event cursor does not match its frame.");
          if (options.reviewId && event.reviewId !== options.reviewId)
            throw new Error("The event belongs to a different review.");
          if (event.cursor === cursor || seen.has(event.cursor)) continue;
          const snapshotCursor = await options.onEvent(event);
          if (options.signal.aborted) return;
          seen.add(event.cursor);
          if (seen.size > 512) seen.delete(seen.values().next().value!);
          cursor = snapshotCursor ?? event.cursor;
          delay = this.options.reconnectDelayMs ?? 500;
          // The snapshot can be ahead of buffered events. Reconnect from its
          // exact cursor instead of applying events that preceded the snapshot.
          if (snapshotCursor !== undefined) break;
        }
      } catch (error) {
        if (options.signal.aborted) return;
        const failure =
          error instanceof Error ? error : new Error(String(error));
        if (
          failure instanceof ReviewClientError &&
          failure.detail.code === "CURSOR_EXPIRED"
        ) {
          cursor = await options.onReset();
          seen.clear();
          continue;
        }
        options.onError?.(failure);
        if (failure instanceof ReviewClientError && !failure.detail.retryable)
          throw failure;
      }
      await hostClientDelay(delay, options.signal);
      delay = Math.min(delay * 2, 15_000);
    }
  }

  /** Snapshot + atomic patches; historical documents intentionally never subscribe. */
  async watchDocument(options: {
    reviewId: string;
    version?: number;
    signal: AbortSignal;
    onDocument(document: HostDocumentState): void;
    onEvent?(event: HostEvent): void;
    onError?(error: Error): void;
  }): Promise<void> {
    let current: HostDocumentState;
    const reset = async () => {
      const input: HostQueryInputs["document.get"] = {
        reviewId: options.reviewId,
      };
      if (options.version !== undefined) input.version = options.version;
      const snapshot = await this.query("document.get", input, options.signal);
      if (!options.signal.aborted) {
        current = snapshot.result;
        options.onDocument(current);
      }
      return snapshot.eventCursor;
    };
    const after = await reset();
    if (options.version !== undefined || options.signal.aborted) return;
    await this.subscribe({
      after,
      reviewId: options.reviewId,
      signal: options.signal,
      onReset: reset,
      onError: options.onError,
      onEvent: async (event) => {
        options.onEvent?.(event);
        if (event.type === "document.resync_required") return reset();
        if (event.type !== "document.committed") return undefined;
        const { reviewId, commit } = z
          .strictObject({
            reviewId: HostIdSchema,
            commit: HostDocumentCommitSchema,
          })
          .parse(event.payload);
        if (reviewId !== options.reviewId)
          throw new Error("The document event belongs to a different review.");
        if (
          commit.documentId === current.documentId &&
          commit.version < current.version
        )
          return undefined;
        if (
          commit.documentId === current.documentId &&
          commit.version === current.version
        )
          return commit.contentHash === current.contentHash
            ? undefined
            : reset();
        if (
          commit.documentId !== current.documentId ||
          commit.previousVersion !== current.version
        )
          return reset();
        try {
          current = applyHostDocumentCommit(current, commit);
        } catch (error) {
          options.onError?.(
            error instanceof Error ? error : new Error(String(error)),
          );
          return reset();
        }
        options.onDocument(current);
        return undefined;
      },
    });
  }

  private envelope() {
    return {
      apiVersion: 1 as const,
      hostId: this.connection.hostId,
      workspaceId: this.connection.workspaceId,
      clientId: this.clientId,
    };
  }

  private url(kind: string) {
    return `${this.serverUrl}/v1/workspaces/${this.connection.workspaceId}/${kind}`;
  }

  private async post(
    kind: string,
    body: string,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    const response = await this.request(this.url(kind), {
      method: "POST",
      headers: {
        "x-review-token": this.options.token,
        "content-type": "application/json",
      },
      body,
      signal,
    });
    const value = parseJsonText(await response.text());
    if (!response.ok) throw hostClientResponseError(value);
    return value;
  }
}

/** Builds and validates the next state before exposing it to any consumer. */
export function applyHostDocumentCommit(
  before: HostDocumentState,
  commit: HostDocumentCommit,
): HostDocumentState {
  if (
    commit.documentId !== before.documentId ||
    commit.previousVersion !== before.version ||
    commit.version !== before.version + 1
  )
    throw new Error("The document patch is not the next version.");
  const merge = <T>(
    prior: Record<string, T>,
    changed: Record<string, T>,
    removed: string[],
  ) => {
    const result = { ...prior, ...changed };
    for (const id of removed) delete result[id];
    return result;
  };
  const next = HostDocumentStateSchema.parse({
    ...before,
    version: commit.version,
    contentHash: commit.contentHash,
    createdAt: commit.createdAt,
    binding: commit.binding,
    roots: commit.roots,
    nodes: merge(before.nodes, commit.changedNodes, commit.removedNodeIds),
    definitions: merge(
      before.definitions,
      commit.changedDefinitions,
      commit.removedDefinitionIds,
    ),
    evidence: merge(
      before.evidence,
      commit.changedEvidence,
      commit.removedEvidenceIds,
    ),
  });
  const issues = validateHostDocument({
    schemaVersion: next.schemaVersion,
    roots: next.roots,
    nodes: next.nodes,
    definitions: next.definitions,
  });
  if (issues.length) throw new Error(issues[0]!.message);
  return next;
}

function hostClientResponseError(value: JsonValue): Error {
  const result = z
    .object({ ok: z.literal(false), error: HostApiErrorSchema })
    .safeParse(value);
  return result.success
    ? new ReviewClientError(result.data.error)
    : new Error("The host returned an invalid response.");
}

async function* hostClientFrames(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return;
      buffer = (
        buffer + decoder.decode(chunk.value, { stream: true })
      ).replaceAll("\r\n", "\n");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        if (boundary > 1_048_576)
          throw new Error("An event frame exceeds the client size limit.");
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        let id = "";
        const data: string[] = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith("id:")) id = line.slice(3).trimStart();
          if (line.startsWith("data:"))
            data.push(line.slice(5).replace(/^ /, ""));
        }
        if (data.length) yield { id, data: data.join("\n") };
      }
      if (buffer.length > 1_048_576)
        throw new Error("An event frame exceeds the client size limit.");
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

function hostClientDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}
