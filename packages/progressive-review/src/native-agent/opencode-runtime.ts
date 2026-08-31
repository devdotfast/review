import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import type { ReviewVerbRequest } from "@dev.fast/review-protocol";

import { AsyncQueue } from "./async-queue";
import type {
  LaunchReviewTurnInput,
  NativeReviewFailure,
  NativeReviewMessage,
  NativeSessionSnapshot,
  NativeSessionUpdate,
  NativeTerminalHandle,
  ObservedNativeSession,
  ReviewThreadAgentBinding,
  UpdatePipe,
} from "./native-session";
import {
  OpenCodeHttpClient,
  OpenCodeHttpError,
  delay,
  isOpenCodeMessageId,
  isOpenCodeProcessRunning,
  nonEmptyString,
  readServerSentEvents,
  reserveOpenCodePort,
  startOpenCodeServer,
  stopOpenCodeProcess,
} from "./opencode-http";
import { isJsonRecord } from "./transcript-json";

type NativeTerminalInput = Extract<
  ReviewVerbRequest,
  { name: "openNativeAgentTerminal" }
>["args"];

interface OpenCodeRuntimeProcess {
  child: ChildProcess;
  client: OpenCodeClient;
}

export interface OpenCodeWorkspaceRuntimeInput {
  directory: string;
  openTerminal(input: NativeTerminalInput): Promise<void>;
  spawn?: typeof spawn;
  fetch?: typeof fetch;
  reservePort?: () => Promise<number>;
  shutdownTimeoutMs?: number;
}

/** Owns the authenticated OpenCode server used by one active Review workspace. */
export class OpenCodeWorkspaceRuntime {
  readonly #directory: string;
  readonly #openTerminal: OpenCodeWorkspaceRuntimeInput["openTerminal"];
  readonly #spawn: typeof spawn;
  readonly #fetch: typeof fetch;
  readonly #reservePort: () => Promise<number>;
  readonly #shutdownTimeoutMs: number | undefined;
  readonly #ownedSessions = new Set<string>();
  #process: OpenCodeRuntimeProcess | undefined;
  #starting: Promise<OpenCodeRuntimeProcess> | undefined;
  #closed = false;

  constructor(input: OpenCodeWorkspaceRuntimeInput) {
    this.#directory = input.directory;
    this.#openTerminal = input.openTerminal;
    this.#spawn = input.spawn ?? spawn;
    this.#fetch = input.fetch ?? fetch;
    this.#reservePort = input.reservePort ?? reserveOpenCodePort;
    this.#shutdownTimeoutMs = input.shutdownTimeoutMs;
  }

  async launchTurn(
    input: LaunchReviewTurnInput,
  ): Promise<NativeTerminalHandle> {
    const promptMessageId = openCodeMessageId(input.reviewMessageId);
    const client = await this.#client();
    let sessionId: string;
    if (input.route.kind === "resume") {
      sessionId = input.route.session.sessionId;
    } else if (input.route.kind === "fork") {
      sessionId = await client.fork(input.route.source.sessionId, input.cwd);
    } else {
      sessionId = await client.create(
        `Review thread ${input.threadId}`,
        input.cwd,
      );
    }
    this.#ownedSessions.add(sessionId);
    await client.confirmSession(sessionId, input.cwd);
    try {
      await this.#attach(client, input.cwd, sessionId, input.launchId);
      await client.prompt(sessionId, promptMessageId, input.prompt, input.cwd);
    } catch (error) {
      if (input.route.kind !== "resume") {
        await this.#abortIfRunning(client, sessionId, input.cwd);
      }
      throw error;
    }
    return acceptedHandle({ harness: "opencode", sessionId });
  }

  async openSession(input: {
    launchId: string;
    cwd: string;
    binding: ReviewThreadAgentBinding;
  }): Promise<NativeTerminalHandle> {
    const client = await this.#client();
    await client.confirmSession(input.binding.sessionId, input.cwd);
    this.#ownedSessions.add(input.binding.sessionId);
    await this.#attach(
      client,
      input.cwd,
      input.binding.sessionId,
      input.launchId,
    );
    return acceptedHandle(input.binding);
  }

  async createTutorialSource(
    prompt: string,
    signal?: AbortSignal,
  ): Promise<ReviewThreadAgentBinding> {
    const client = await this.#client();
    const sessionId = await client.create(
      "Review tutorial authoring",
      this.#directory,
    );
    this.#ownedSessions.add(sessionId);
    await client.prompt(
      sessionId,
      openCodeMessageId(randomUUID()),
      prompt,
      this.#directory,
      { "*": false },
    );
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        throw new Error("Tutorial authoring session creation was canceled.");
      }
      const snapshot = await client.snapshot(sessionId, this.#directory);
      const failure = snapshot.failures[0];
      if (failure) throw new Error(failure.error);
      if (snapshot.messages.some((message) => message.role === "assistant")) {
        return { harness: "opencode", sessionId };
      }
      await delay(250);
    }
    throw new Error(
      "OpenCode timed out while creating the tutorial authoring session.",
    );
  }

  observe(binding: ReviewThreadAgentBinding): ObservedNativeSession {
    this.#ownedSessions.add(binding.sessionId);
    return new OpenCodeObservedSession(this, binding, this.#directory);
  }

  async snapshot(
    sessionId: string,
    directory: string,
  ): Promise<OpenCodeSnapshot> {
    return (await this.#client()).snapshot(sessionId, directory);
  }

  async subscribe(
    directory: string,
    signal: AbortSignal,
    onEvent: (event: OpenCodeEvent) => void,
  ): Promise<OpenCodeSubscription> {
    return (await this.#client()).subscribe(directory, signal, onEvent);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const process =
      this.#process ?? (await this.#starting?.catch(() => undefined));
    if (!process) return;
    if (!isOpenCodeProcessRunning(process.child)) {
      this.#process = undefined;
      return;
    }
    const statuses = await process.client
      .status(this.#directory)
      .catch((): Record<string, OpenCodeStatus> => ({}));
    await Promise.allSettled(
      [...this.#ownedSessions]
        .filter((sessionId) => isRunning(statuses[sessionId]))
        .map((sessionId) => process.client.abort(sessionId, this.#directory)),
    );
    await process.client.dispose().catch(() => undefined);
    await stopOpenCodeProcess(process.child, this.#shutdownTimeoutMs, true);
    this.#process = undefined;
  }

  async #client(): Promise<OpenCodeClient> {
    if (this.#closed) throw new Error("The OpenCode runtime is closed.");
    if (this.#process && isOpenCodeProcessRunning(this.#process.child)) {
      return this.#process.client;
    }
    this.#process = undefined;
    this.#starting ??= this.#start().finally(() => {
      this.#starting = undefined;
    });
    return (await this.#starting).client;
  }

  async #start(): Promise<OpenCodeRuntimeProcess> {
    const server = await startOpenCodeServer({
      cwd: this.#directory,
      attempts: 2,
      detached: process.platform !== "win32",
      spawn: this.#spawn,
      fetch: this.#fetch,
      reservePort: this.#reservePort,
      shutdownTimeoutMs: this.#shutdownTimeoutMs,
    });
    const running = {
      child: server.child,
      client: new OpenCodeClient(server.http),
    };
    this.#process = running;
    return running;
  }

  async #attach(
    client: OpenCodeClient,
    directory: string,
    sessionId: string,
    launchId: string,
  ): Promise<void> {
    await this.#openTerminal({
      launchId,
      harness: "opencode",
      cwd: directory,
      executable: "opencode",
      args: [
        "attach",
        client.http.baseUrl,
        "--dir",
        directory,
        "--session",
        sessionId,
      ],
      env: {
        OPENCODE_SERVER_USERNAME: client.http.username,
        OPENCODE_SERVER_PASSWORD: client.http.password,
      },
    });
  }

  async #abortIfRunning(
    client: OpenCodeClient,
    sessionId: string,
    directory: string,
  ): Promise<void> {
    const statuses = await client
      .status(directory)
      .catch((): Record<string, OpenCodeStatus> => ({}));
    if (isRunning(statuses[sessionId])) {
      await client.abort(sessionId, directory).catch(() => undefined);
    }
  }
}

export class OpenCodeClient {
  constructor(readonly http: OpenCodeHttpClient) {}

  async create(title: string, directory: string): Promise<string> {
    return sessionId(
      await this.http.json("/session", directory, {
        method: "POST",
        body: JSON.stringify({ title }),
      }),
      this.http.contract("session creation returned an invalid response"),
    );
  }

  async fork(sourceSessionId: string, directory: string): Promise<string> {
    return sessionId(
      await this.http.json(
        `/session/${encodeURIComponent(sourceSessionId)}/fork`,
        directory,
        { method: "POST", body: "{}" },
      ),
      this.http.contract("session fork returned an invalid response"),
    );
  }

  async confirmSession(sessionId: string, directory: string): Promise<void> {
    const session = await this.http.json(
      `/session/${encodeURIComponent(sessionId)}`,
      directory,
    );
    if (!isJsonRecord(session) || session.id !== sessionId) {
      throw this.http.contract(
        `session confirmation did not return session "${sessionId}"`,
      );
    }
  }

  async prompt(
    sessionId: string,
    messageId: string,
    prompt: string,
    directory: string,
    tools?: Record<string, boolean>,
  ): Promise<void> {
    try {
      await this.http.json(
        `/session/${encodeURIComponent(sessionId)}/prompt_async`,
        directory,
        {
          method: "POST",
          body: JSON.stringify({
            messageID: messageId,
            parts: [{ type: "text", text: prompt }],
            ...(tools ? { tools } : {}),
          }),
        },
      );
    } catch (error) {
      if (error instanceof OpenCodeHttpError && error.responseReceived) {
        throw error;
      }
      for (const milliseconds of [0, 100, 250, 500]) {
        if (milliseconds > 0) await delay(milliseconds);
        try {
          const message = await this.http.json(
            `/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`,
            directory,
          );
          if (
            isJsonRecord(message) &&
            isJsonRecord(message.info) &&
            message.info.id === messageId &&
            message.info.sessionID === sessionId &&
            message.info.role === "user"
          ) {
            return;
          }
        } catch {
          // The POST is never retried; only its stable message identity is polled.
        }
      }
      throw error;
    }
  }

  async snapshot(
    sessionId: string,
    directory: string,
  ): Promise<OpenCodeSnapshot> {
    const [statuses, messages] = await Promise.all([
      this.status(directory),
      this.http.json(
        `/session/${encodeURIComponent(sessionId)}/message`,
        directory,
      ),
    ]);
    return {
      ...parseSnapshot(messages, sessionId, this.http.version),
      status: statuses[sessionId],
    };
  }

  async status(directory: string): Promise<Record<string, OpenCodeStatus>> {
    return parseStatuses(
      await this.http.json("/session/status", directory),
      this.http.version,
    );
  }

  async abort(sessionId: string, directory: string): Promise<void> {
    await this.http.json(
      `/session/${encodeURIComponent(sessionId)}/abort`,
      directory,
      { method: "POST" },
    );
  }

  async dispose(): Promise<void> {
    await this.http.json("/instance/dispose", undefined, { method: "POST" });
  }

  async subscribe(
    directory: string,
    signal: AbortSignal,
    onEvent: (event: OpenCodeEvent) => void,
  ): Promise<OpenCodeSubscription> {
    const response = await this.http.request("/event", directory, { signal });
    if (!response.body) throw this.http.contract("event stream has no body");
    return {
      done: readServerSentEvents(response.body, signal, (data) =>
        onEvent(parseEvent(data, this.http.version)),
      ),
      version: this.http.version,
    };
  }
}

interface OpenCodeSnapshot {
  messages: NativeReviewMessage[];
  failures: NativeReviewFailure[];
  status?: OpenCodeStatus;
}

type OpenCodeStatus = { type: "idle" | "busy" | "retry" };

interface OpenCodeEvent {
  type: string;
  sessionId?: string;
}

interface OpenCodeSubscription {
  done: Promise<void>;
  version: string;
}

class OpenCodeObservedSession implements ObservedNativeSession {
  constructor(
    readonly runtime: OpenCodeWorkspaceRuntime,
    readonly ref: ReviewThreadAgentBinding,
    readonly directory: string,
  ) {}

  async updates(): Promise<
    UpdatePipe<NativeSessionSnapshot, NativeSessionUpdate>
  > {
    const wakes = new AsyncQueue<OpenCodeEvent | Error>();
    const controller = new AbortController();
    let closed = false;
    let resolveConnected!: () => void;
    let rejectConnected!: (error: Error) => void;
    const connected = new Promise<void>((resolve, reject) => {
      resolveConnected = resolve;
      rejectConnected = reject;
    });
    const listener = this.#listen(
      controller.signal,
      wakes,
      resolveConnected,
      rejectConnected,
    );
    let initial: OpenCodeSnapshot;
    try {
      await connected;
      initial = await this.runtime.snapshot(this.ref.sessionId, this.directory);
    } catch (error) {
      controller.abort();
      wakes.close();
      await listener;
      throw error;
    }
    const seenMessages = new Set(initial.messages.map((message) => message.id));
    const seenFailures = new Set(initial.failures.map((failure) => failure.id));
    const state = { status: initial.status };
    return {
      snapshot: {
        session: this.ref,
        messages: initial.messages,
        failures: initial.failures,
      },
      updates: {
        [Symbol.asyncIterator]: () =>
          this.#updates(wakes, seenMessages, seenFailures, state)[
            Symbol.asyncIterator
          ](),
      },
      close: async () => {
        if (closed) return;
        closed = true;
        controller.abort();
        wakes.close();
        await listener;
      },
    };
  }

  async *#updates(
    wakes: AsyncQueue<OpenCodeEvent | Error>,
    seenMessages: Set<string | undefined>,
    seenFailures: Set<string>,
    state: { status: OpenCodeStatus | undefined },
  ): AsyncIterable<NativeSessionUpdate> {
    for await (const wake of wakes) {
      if (wake instanceof Error) throw wake;
      let snapshot: OpenCodeSnapshot | undefined;
      let lastError: unknown;
      for (const wait of [0, 250, 1_000]) {
        if (wait > 0) await delay(wait);
        try {
          snapshot = await this.runtime.snapshot(
            this.ref.sessionId,
            this.directory,
          );
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!snapshot) throw lastError;
      const wasRunning = isRunning(state.status);
      state.status = snapshot.status;
      if (wasRunning && !isRunning(state.status)) {
        wakes.push({ type: "session.settled", sessionId: this.ref.sessionId });
      }
      for (const message of snapshot.messages) {
        if (seenMessages.has(message.id)) continue;
        seenMessages.add(message.id);
        yield { type: "message.updated", message };
      }
      for (const failure of snapshot.failures) {
        if (seenFailures.has(failure.id)) continue;
        seenFailures.add(failure.id);
        yield { type: "session.failed", failure };
      }
    }
  }

  async #listen(
    signal: AbortSignal,
    wakes: AsyncQueue<OpenCodeEvent | Error>,
    resolveConnected: () => void,
    rejectConnected: (error: Error) => void,
  ): Promise<void> {
    let hasConnected = false;
    let reconnectFailures = 0;
    while (!signal.aborted) {
      try {
        const subscription = await this.runtime.subscribe(
          this.directory,
          signal,
          (event) => {
            // HTTP success alone does not prove the SSE stream works. Only a
            // non-handshake event proves it can carry session invalidations.
            if (event.type !== "server.connected") reconnectFailures = 0;
            if (!event.sessionId || event.sessionId === this.ref.sessionId) {
              wakes.push(event);
              if (
                event.type === "session.idle" ||
                event.type === "session.error"
              ) {
                for (const milliseconds of [250, 1_000]) {
                  const timer = setTimeout(
                    () => wakes.push(event),
                    milliseconds,
                  );
                  timer.unref();
                }
              }
            }
          },
        );
        hasConnected = true;
        resolveConnected();
        wakes.push({ type: "server.connected" });
        await subscription.done;
        throw new Error(
          `OpenCode event stream closed unexpectedly (reported version ${subscription.version}).`,
        );
      } catch (error) {
        if (signal.aborted) return;
        const failure =
          error instanceof Error ? error : new Error(String(error));
        if (!hasConnected) {
          rejectConnected(failure);
          return;
        }
        reconnectFailures += 1;
        wakes.push({ type: "server.disconnected" });
        if (reconnectFailures >= 2) {
          wakes.push(failure);
          return;
        }
        console.error(failure);
      }
      if (!signal.aborted) await delay(250);
    }
  }
}

function parseSnapshot(
  value: unknown,
  sessionId: string,
  version: string,
): { messages: NativeReviewMessage[]; failures: NativeReviewFailure[] } {
  if (!Array.isArray(value))
    throw contract(version, "messages are not an array");
  const messages: NativeReviewMessage[] = [];
  const failures: NativeReviewFailure[] = [];
  for (const entry of value) {
    if (
      !isJsonRecord(entry) ||
      !isJsonRecord(entry.info) ||
      !Array.isArray(entry.parts)
    ) {
      throw contract(version, "message snapshot contains an invalid entry");
    }
    const info = entry.info;
    if (info.role === "assistant" && info.error !== undefined) {
      if (
        !isOpenCodeMessageId(info.id) ||
        info.sessionID !== sessionId ||
        !isJsonRecord(info.time) ||
        typeof info.time.created !== "number"
      ) {
        continue;
      }
      const detail =
        isJsonRecord(info.error) &&
        isJsonRecord(info.error.data) &&
        nonEmptyString(info.error.data.message)
          ? info.error.data.message
          : isJsonRecord(info.error) && nonEmptyString(info.error.name)
            ? info.error.name
            : "unknown error";
      failures.push({
        id: `${sessionId}:${info.id}:error`,
        error: detail,
        createdAt: new Date(info.time.created).toISOString(),
      });
      continue;
    }
    if (
      !isOpenCodeMessageId(info.id) ||
      info.sessionID !== sessionId ||
      (info.role !== "user" && info.role !== "assistant") ||
      !isJsonRecord(info.time) ||
      typeof info.time.created !== "number"
    ) {
      throw contract(
        version,
        "message snapshot contains invalid message metadata",
      );
    }
    const createdAt = new Date(info.time.created).toISOString();
    if (info.role === "assistant") {
      if (typeof info.time.completed !== "number") continue;
    }
    const textParts = entry.parts.filter(
      (part): part is Record<string, unknown> =>
        isJsonRecord(part) && part.type === "text" && part.ignored !== true,
    );
    if (
      textParts.some(
        (part) =>
          !nonEmptyString(part.id) ||
          part.sessionID !== sessionId ||
          part.messageID !== info.id ||
          typeof part.text !== "string",
      )
    ) {
      throw contract(version, "message snapshot contains an invalid text part");
    }
    const body = textParts.map((part) => part.text as string).join("");
    if (!body) continue;
    messages.push({
      id: `${sessionId}:${info.id}:${textParts.map((part) => part.id).join(",")}`,
      role: info.role,
      body,
      createdAt,
    });
  }
  return { messages: messages.sort(compareCreated), failures };
}

function parseStatuses(
  value: unknown,
  version: string,
): Record<string, OpenCodeStatus> {
  if (!isJsonRecord(value)) throw contract(version, "status is not an object");
  const statuses: Record<string, OpenCodeStatus> = {};
  for (const [sessionId, status] of Object.entries(value)) {
    if (!isJsonRecord(status) || !nonEmptyString(status.type)) {
      throw contract(version, `status for session "${sessionId}" is invalid`);
    }
    statuses[sessionId] =
      status.type === "idle" ||
      status.type === "busy" ||
      status.type === "retry"
        ? { type: status.type }
        : { type: "busy" };
  }
  return statuses;
}

function parseEvent(data: string, version: string): OpenCodeEvent {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    throw contract(version, "event stream returned invalid JSON");
  }
  if (!isJsonRecord(value) || !nonEmptyString(value.type)) {
    throw contract(version, "event stream returned an invalid event");
  }
  const properties = isJsonRecord(value.properties) ? value.properties : {};
  const info = isJsonRecord(properties.info) ? properties.info : {};
  const sessionId = firstString(
    properties.sessionID,
    info.sessionID,
    value.type === "session.created" || value.type === "session.updated"
      ? info.id
      : undefined,
  );
  return { type: value.type, ...(sessionId ? { sessionId } : {}) };
}

export function openCodeMessageId(reviewMessageId: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      reviewMessageId,
    )
  ) {
    throw new Error("OpenCode prompts require a Review UUID message ID.");
  }
  return `msg_${reviewMessageId.replaceAll("-", "").toLowerCase()}`;
}

function sessionId(value: unknown, error: Error): string {
  if (!isJsonRecord(value) || !nonEmptyString(value.id)) throw error;
  return value.id;
}

function contract(version: string, message: string): Error {
  return new Error(`OpenCode ${message} (reported version ${version}).`);
}

function isRunning(status: OpenCodeStatus | undefined): boolean {
  return status?.type === "busy" || status?.type === "retry";
}

function compareCreated(
  a: NativeReviewMessage,
  b: NativeReviewMessage,
): number {
  return (
    a.createdAt.localeCompare(b.createdAt) ||
    (a.role === b.role ? 0 : a.role === "user" ? -1 : 1) ||
    (a.id ?? "").localeCompare(b.id ?? "")
  );
}

function firstString(...values: unknown[]): string | undefined {
  return values.find(nonEmptyString);
}

function acceptedHandle(
  binding: ReviewThreadAgentBinding,
): NativeTerminalHandle {
  return {
    accepted: Promise.resolve(binding),
    events: { async *[Symbol.asyncIterator]() {} },
    detach: async () => undefined,
  };
}
