import { z } from "zod";

import {
  type HostActivitySnapshot,
  HostActivitySnapshotSchema,
} from "./host-activity.js";
import {
  HostPrincipalSchema,
  HostRepositorySchema,
  HostReviewCommitSchema,
  HostReviewStateSchema,
  type HostReviewWithSnapshot,
  HostReviewWithSnapshotSchema,
} from "./host-api.js";
import {
  HOST_CAPABILITY_LIMITS,
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
import {
  HostAttentionSchema,
  HostDraftSchema,
  HostFeedbackSubmissionSchema,
  HostMessageSchema,
  HostQuestionRunSchema,
  HostThreadSchema,
} from "./host-feedback.js";
import { type JsonValue, parseJsonText } from "./json.js";

export const HostConnectionSchema = z.strictObject({
  apiVersion: z.literal(1),
  hostId: HostIdSchema,
  workspaceId: HostIdSchema,
  principal: HostPrincipalSchema,
});
export type HostConnection = z.infer<typeof HostConnectionSchema>;

const eventPayloads = {
  "repository.registered": HostRepositorySchema,
  "review.created": HostReviewWithSnapshotSchema,
  "review.committed": HostReviewCommitSchema,
  "review.resync_required": z.strictObject({
    reviewId: HostIdSchema,
    reviewVersion: z.number().int().nonnegative(),
  }),
  "review.state_changed": z.strictObject({ review: HostReviewStateSchema }),
  "draft.saved": z.strictObject({ draft: HostDraftSchema }),
  "draft.deleted": z.strictObject({ draftId: HostIdSchema }),
  "thread.created": z.strictObject({ thread: HostThreadSchema }),
  "thread.updated": z.strictObject({ thread: HostThreadSchema }),
  "message.appended": z.strictObject({ message: HostMessageSchema }),
  "feedback.submitted": z.strictObject({
    submission: HostFeedbackSubmissionSchema,
  }),
  "question.updated": z.strictObject({ run: HostQuestionRunSchema }),
  "attention.updated": z.strictObject({ attention: HostAttentionSchema }),
};
function isKnownHostEvent(type: string): type is keyof typeof eventPayloads {
  return Object.hasOwn(eventPayloads, type);
}
export const HostEventSchema = z
  .strictObject({
    cursor: HostCursorSchema,
    reviewId: HostIdSchema.nullable(),
    type: z.string().min(1).max(100),
    payload: z.json(),
  })
  .superRefine((event, context) => {
    if (!isKnownHostEvent(event.type)) return; // Unknown future events trigger a snapshot refresh.
    const schema = eventPayloads[event.type];
    const parsed = schema.safeParse(event.payload);
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        context.addIssue({ ...issue, path: ["payload", ...issue.path] });
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
  /** Transient snapshots do not advance the durable event cursor. Undefined means disconnected. */
  onActivity?(activity: HostActivitySnapshot | undefined): void;
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
    const result = z
      .strictObject({ ok: z.literal(true), data: HostConnectionSchema })
      .parse(value);
    return new ReviewClient(options, result.data);
  }

  async query<K extends HostQueryName>(
    type: K,
    input: HostQueryInputs[K],
    signal?: AbortSignal,
  ) {
    const value = await this.post(
      "queries",
      JSON.stringify({
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
    let reconnecting = false;
    const seen = new Set<string>();
    while (!options.signal.aborted) {
      let retryAfterMs = 0;
      try {
        if (reconnecting) {
          const verified = await ReviewClient.connect(
            this.options,
            options.signal,
          );
          if (
            verified.connection.hostId !== this.connection.hostId ||
            verified.connection.workspaceId !== this.connection.workspaceId ||
            verified.connection.principal.id !== this.connection.principal.id ||
            verified.connection.principal.kind !==
              this.connection.principal.kind
          )
            throw new ReviewClientError({
              code: "FORBIDDEN",
              message:
                "The Review connection identity changed. Reconnect explicitly.",
              retryable: false,
              diagnostics: [],
            });
        }
        reconnecting = true;
        const url = new URL(this.url("events"));
        url.searchParams.set("after", cursor);
        if (options.reviewId)
          url.searchParams.set("reviewId", options.reviewId);
        if (options.reviewId && options.onActivity)
          url.searchParams.set("activity", "1");
        const response = await this.request(url, {
          headers: {
            "x-review-token": this.options.token,
            accept: "text/event-stream",
          },
          signal: options.signal,
        });
        if (!response.ok) {
          const retryAfter = response.headers.get("retry-after");
          if (retryAfter)
            retryAfterMs = /^\d+$/.test(retryAfter)
              ? Number(retryAfter) * 1000
              : Math.max(0, Date.parse(retryAfter) - Date.now());
          throw hostClientResponseError(parseJsonText(await response.text()));
        }
        if (
          !response.body ||
          !response.headers.get("content-type")?.startsWith("text/event-stream")
        )
          throw new Error("The host did not return an event stream.");
        for await (const frame of hostClientFrames(
          response.body,
          options.signal,
        )) {
          if (options.signal.aborted) return;
          if (!frame.data) continue; // Heartbeats keep the connection alive without changing its cursor.
          if (frame.event === "authoring.activity") {
            const activity = HostActivitySnapshotSchema.parse(
              parseJsonText(frame.data),
            );
            if (!options.reviewId || activity.reviewId !== options.reviewId)
              throw new Error("The activity belongs to a different review.");
            options.onActivity?.(activity);
            continue;
          }
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
        options.onActivity?.(undefined);
        let failure = error instanceof Error ? error : new Error(String(error));
        if (
          failure instanceof ReviewClientError &&
          failure.detail.code === "CURSOR_EXPIRED"
        ) {
          try {
            cursor = await options.onReset();
            seen.clear();
            continue;
          } catch (resetError) {
            if (options.signal.aborted) return;
            failure =
              resetError instanceof Error
                ? resetError
                : new Error(String(resetError));
          }
        }
        options.onError?.(failure);
        if (failure instanceof ReviewClientError && !failure.detail.retryable)
          throw failure;
      }
      if (!options.signal.aborted) options.onActivity?.(undefined);
      await hostClientDelay(
        Math.max(delay, Number.isFinite(retryAfterMs) ? retryAfterMs : 0),
        options.signal,
      );
      delay = Math.min(delay * 2, 15_000);
    }
  }

  /** Metadata, source selection and canvas are delivered as one saved version. */
  async watchReview(options: {
    reviewId: string;
    reviewVersion?: number;
    signal: AbortSignal;
    onReview(
      review: HostReviewWithSnapshot & { document: HostDocumentState },
    ): void;
    onEvent?(event: HostEvent): void;
    onError?(error: Error): void;
    onActivity?(activity: HostActivitySnapshot | undefined): void;
  }): Promise<void> {
    let current: HostReviewWithSnapshot & { document: HostDocumentState };
    const reset = async () => {
      const snapshot = await this.query(
        "review.get",
        {
          reviewId: options.reviewId,
          reviewVersion: options.reviewVersion,
        },
        options.signal,
      );
      const document = await this.query(
        "document.get",
        {
          reviewId: options.reviewId,
          reviewVersion: snapshot.result.snapshot.reviewVersion,
        },
        options.signal,
      );
      if (!options.signal.aborted) {
        current = { ...snapshot.result, document: document.result };
        options.onReview(current);
      }
      return snapshot.eventCursor;
    };
    const after = await reset();
    if (options.signal.aborted) return;
    await this.subscribe({
      after,
      reviewId: options.reviewId,
      signal: options.signal,
      onReset: reset,
      onError: options.onError,
      onActivity: options.onActivity,
      onEvent: async (event) => {
        options.onEvent?.(event);
        if (!isKnownHostEvent(event.type)) return reset();
        if (event.type === "review.state_changed") {
          const { review } = z
            .strictObject({ review: HostReviewStateSchema })
            .parse(event.payload);
          if (review.id !== options.reviewId)
            throw new Error("The review state belongs to a different review.");
          if (review.stateVersion >= current.review.stateVersion) {
            current = { ...current, review };
            options.onReview(current);
          }
          return;
        }
        // Historical material stays fixed; its latest-version pointer and lifecycle remain live.
        if (options.reviewVersion !== undefined) {
          if (
            event.type === "review.committed" ||
            event.type === "review.resync_required"
          ) {
            const nextVersion =
              event.type === "review.committed"
                ? HostReviewCommitSchema.parse(event.payload).reviewVersion
                : z.object({ reviewVersion: z.number() }).parse(event.payload)
                    .reviewVersion;
            if (nextVersion > current.review.latestReviewVersion) {
              current = {
                ...current,
                review: { ...current.review, latestReviewVersion: nextVersion },
              };
              options.onReview(current);
            }
          }
          return;
        }
        if (event.type === "review.resync_required") return reset();
        if (event.type !== "review.committed") return;
        const commit = HostReviewCommitSchema.parse(event.payload);
        if (
          commit.reviewId !== options.reviewId ||
          commit.snapshot.reviewId !== options.reviewId
        )
          throw new Error("The document event belongs to a different review.");
        if (commit.reviewVersion <= current.snapshot.reviewVersion) return;
        if (
          commit.previousReviewVersion !== current.snapshot.reviewVersion ||
          commit.reviewVersion !== commit.previousReviewVersion + 1 ||
          commit.snapshot.reviewVersion !== commit.reviewVersion
        )
          return reset();
        try {
          const document = commit.documentDelta
            ? applyHostDocumentCommit(current.document, commit.documentDelta)
            : {
                ...current.document,
                reviewVersion: commit.reviewVersion,
                createdAt: commit.snapshot.createdAt,
              };
          current = {
            review: {
              ...current.review,
              latestReviewVersion: commit.reviewVersion,
            },
            snapshot: commit.snapshot,
            document,
          };
        } catch (error) {
          options.onError?.(
            error instanceof Error ? error : new Error(String(error)),
          );
          return reset();
        }
        options.onReview(current);
        return undefined;
      },
    });
  }

  async watchDocument(options: {
    reviewId: string;
    reviewVersion?: number;
    signal: AbortSignal;
    onDocument(document: HostDocumentState): void;
    onEvent?(event: HostEvent): void;
    onError?(error: Error): void;
    onActivity?(activity: HostActivitySnapshot | undefined): void;
  }): Promise<void> {
    return this.watchReview({
      ...options,
      onReview: (value) => options.onDocument(value.document),
    });
  }

  private url(kind: string) {
    return `${this.serverUrl}/v1/workspaces/${this.connection.workspaceId}/${kind}`;
  }

  private async post(
    kind: string,
    body: string,
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    const headers = new Headers({
      "x-review-token": this.options.token,
      "content-type": "application/json",
    });
    if (kind === "commands") headers.set("x-review-client-id", this.clientId);
    const response = await this.request(this.url(kind), {
      method: "POST",
      headers,
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
    commit.reviewId !== before.reviewId ||
    commit.previousReviewVersion !== before.reviewVersion ||
    commit.reviewVersion !== before.reviewVersion + 1
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
    reviewVersion: commit.reviewVersion,
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

async function* hostClientFrames(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let deadline = Date.now() + 45_000;
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      if (signal.aborted) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error("The Review event stream stopped responding.")),
            Math.max(0, deadline - Date.now()),
          );
        }),
      ]).finally(() => clearTimeout(timer));
      if (chunk.done) return;
      buffer += decoder.decode(chunk.value, { stream: true });
      let separator: RegExpExecArray | null;
      while ((separator = /\r?\n\r?\n/.exec(buffer)) !== null) {
        const boundary = separator.index + separator[0].length;
        const serializedFrame = buffer.slice(0, boundary);
        if (
          encoder.encode(serializedFrame).byteLength >
          HOST_CAPABILITY_LIMITS.eventFrameBytes
        )
          throw new Error("An event frame exceeds the client size limit.");
        const frame = buffer.slice(0, separator.index).replaceAll("\r\n", "\n");
        buffer = buffer.slice(boundary);
        deadline = Date.now() + 45_000;
        let id = "";
        let event = "";
        const data: string[] = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith("id:")) id = line.slice(3).trimStart();
          if (line.startsWith("event:")) event = line.slice(6).trimStart();
          if (line.startsWith("data:"))
            data.push(line.slice(5).replace(/^ /, ""));
        }
        yield { id, event, data: data.join("\n") };
      }
      if (
        encoder.encode(buffer).byteLength >
        HOST_CAPABILITY_LIMITS.eventFrameBytes
      )
        throw new Error("An event frame exceeds the client size limit.");
    }
  } finally {
    signal.removeEventListener("abort", cancel);
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
