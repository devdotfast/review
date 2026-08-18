import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { type Socket, createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  type ReviewCodexWaitRegistration,
  registerReviewCodexWait,
} from "./review-codex-wait-state";

const IPC_FRAME_HEADER_BYTES = 4;
const MAX_IPC_FRAME_BYTES = 256 * 1024 * 1024;
const IPC_REQUEST_TIMEOUT_MS = 30_000;
const WAKE_RETRY_INTERVAL_MS = 2_000;
const WAKE_RETRY_TIMEOUT_MS = 60_000;
const CODEX_START_TURN_METHOD = "thread-follower-start-turn";
const CODEX_START_TURN_VERSION = 1;

type JsonRecord = Record<string, unknown>;

// Deliberately duplicated from packages/cli/src/commands/codex-thread-wakeup.ts.
export type CodexWaitProcessInput = {
  cliEntryPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  reviewUuid: string;
  threadId: string;
  timeout: string;
};

export type CodexWaitRegistration = ReviewCodexWaitRegistration;

export type CodexThreadWakeupInput = {
  clientUserMessageId: string;
  env: NodeJS.ProcessEnv;
  prompt: string;
  threadId: string;
};

export class CodexThreadIdUnavailableError extends Error {
  constructor() {
    super(
      "--codex requires CODEX_THREAD_ID. Run the command from the Codex task that should be resumed.",
    );
    this.name = new.target.name;
  }
}

export class CodexIpcUnavailableError extends Error {
  readonly socketPath: string;

  constructor(socketPath: string, options?: ErrorOptions) {
    super(
      `The Codex desktop IPC endpoint is unavailable at ${socketPath}. Keep the Codex app running while the workflow wait is active.`,
      options,
    );
    this.name = new.target.name;
    this.socketPath = socketPath;
  }
}

export class CodexIpcProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export function requireCodexThreadId(env: NodeJS.ProcessEnv): string {
  const threadId = env.CODEX_THREAD_ID?.trim();
  if (!threadId) {
    throw new CodexThreadIdUnavailableError();
  }
  return threadId;
}

export async function startCodexWaitProcess(
  input: CodexWaitProcessInput,
): Promise<CodexWaitRegistration> {
  return await registerReviewCodexWait({
    env: input.env,
    reviewUuid: input.reviewUuid,
    threadId: input.threadId,
    start: (ownerToken) => spawnCodexWaitProcess(input, ownerToken),
  });
}

function spawnCodexWaitProcess(
  input: CodexWaitProcessInput,
  ownerToken: string,
): number {
  const child = spawn(
    process.execPath,
    [
      input.cliEntryPath,
      "wait-codex",
      input.reviewUuid,
      "--thread-id",
      input.threadId,
      "--owner-token",
      ownerToken,
      "--timeout",
      input.timeout,
    ],
    {
      cwd: input.cwd,
      detached: true,
      env: input.env,
      stdio: "ignore",
    },
  );
  child.unref();
  if (child.pid === undefined) {
    throw new Error("Could not start the detached Codex Review waiter.");
  }
  return child.pid;
}

export async function wakeCodexThread(
  input: CodexThreadWakeupInput,
): Promise<void> {
  const socketPath = codexIpcSocketPath(input.env);
  let socket: Socket;
  try {
    socket = await connectSocket(socketPath);
  } catch (error) {
    throw new CodexIpcUnavailableError(socketPath, { cause: error });
  }

  const messages = framedMessages(socket);
  try {
    const initializeRequestId = randomUUID();
    writeFrame(socket, {
      method: "initialize",
      params: { clientType: "dev-workflow-wait" },
      requestId: initializeRequestId,
      type: "request",
      version: 0,
    });
    const initialized = await messages.waitForResponse(initializeRequestId);
    const clientId = initializedClientId(initialized);

    const wakeRequestId = randomUUID();
    writeFrame(socket, {
      method: CODEX_START_TURN_METHOD,
      params: {
        conversationId: input.threadId,
        turnStartParams: {
          clientUserMessageId: input.clientUserMessageId,
          input: [
            {
              text: input.prompt,
              text_elements: [],
              type: "text",
            },
          ],
        },
      },
      requestId: wakeRequestId,
      sourceClientId: clientId,
      timeoutMs: IPC_REQUEST_TIMEOUT_MS,
      type: "request",
      version: CODEX_START_TURN_VERSION,
    });
    assertSuccessfulWake(await messages.waitForResponse(wakeRequestId));
  } finally {
    messages.dispose();
    socket.destroy();
  }
}

export async function wakeCodexThreadWithRetry(
  input: CodexThreadWakeupInput,
  options: {
    retryIntervalMs?: number;
    send?: (input: CodexThreadWakeupInput) => Promise<void>;
    sleep?: (milliseconds: number) => Promise<void>;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  const retryIntervalMs = options.retryIntervalMs ?? WAKE_RETRY_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? WAKE_RETRY_TIMEOUT_MS;
  const send = options.send ?? wakeCodexThread;
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const startedAt = Date.now();
  for (;;) {
    try {
      await send(input);
      return;
    } catch (error) {
      if (
        !(error instanceof CodexIpcUnavailableError) &&
        !(error instanceof CodexIpcProtocolError)
      ) {
        throw error;
      }
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= timeoutMs) {
        throw error;
      }
      await sleep(Math.min(retryIntervalMs, timeoutMs - elapsedMs));
    }
  }
}

export function codexIpcSocketPath(env: NodeJS.ProcessEnv): string {
  const codexHome = env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  return join(codexHome, "ipc", "ipc.sock");
}

function connectSocket(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const onError = (error: Error): void => {
      socket.off("connect", onConnect);
      reject(error);
    };
    const onConnect = (): void => {
      socket.off("error", onError);
      resolve(socket);
    };
    socket.once("error", onError);
    socket.once("connect", onConnect);
  });
}

function framedMessages(socket: Socket): {
  dispose(): void;
  waitForResponse(requestId: string): Promise<JsonRecord>;
} {
  let buffered = Buffer.alloc(0);
  let failed: Error | undefined;
  const queued: JsonRecord[] = [];
  const waiters = new Map<
    string,
    {
      reject(error: Error): void;
      resolve(message: JsonRecord): void;
      timer: NodeJS.Timeout;
    }
  >();

  const fail = (error: Error): void => {
    if (failed !== undefined) return;
    failed = error;
    for (const waiter of waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    waiters.clear();
  };

  const dispatch = (message: JsonRecord): void => {
    const requestId =
      typeof message.requestId === "string" ? message.requestId : undefined;
    if (requestId === undefined) {
      queued.push(message);
      return;
    }
    const waiter = waiters.get(requestId);
    if (waiter === undefined) {
      queued.push(message);
      return;
    }
    clearTimeout(waiter.timer);
    waiters.delete(requestId);
    waiter.resolve(message);
  };

  const onData = (chunk: Buffer): void => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= IPC_FRAME_HEADER_BYTES) {
      const frameBytes = buffered.readUInt32LE(0);
      if (frameBytes === 0 || frameBytes > MAX_IPC_FRAME_BYTES) {
        fail(
          new CodexIpcProtocolError(
            `Codex IPC returned an invalid frame length (${frameBytes} bytes).`,
          ),
        );
        return;
      }
      const totalBytes = IPC_FRAME_HEADER_BYTES + frameBytes;
      if (buffered.length < totalBytes) return;
      const frame = buffered.subarray(IPC_FRAME_HEADER_BYTES, totalBytes);
      buffered = buffered.subarray(totalBytes);
      try {
        const parsed = JSON.parse(frame.toString("utf8")) as unknown;
        if (!isRecord(parsed)) {
          throw new TypeError("frame is not an object");
        }
        dispatch(parsed);
      } catch (error) {
        fail(
          new CodexIpcProtocolError(
            "Codex IPC returned a malformed JSON frame.",
            { cause: error },
          ),
        );
        return;
      }
    }
  };
  const onError = (error: Error): void => fail(error);
  const onClose = (): void =>
    fail(new CodexIpcProtocolError("Codex IPC closed before responding."));
  socket.on("data", onData);
  socket.on("error", onError);
  socket.on("close", onClose);

  return {
    dispose() {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      for (const waiter of waiters.values()) {
        clearTimeout(waiter.timer);
      }
      waiters.clear();
    },
    async waitForResponse(requestId) {
      if (failed !== undefined) throw failed;
      const queuedIndex = queued.findIndex(
        (message) => message.requestId === requestId,
      );
      if (queuedIndex >= 0) {
        return queued.splice(queuedIndex, 1)[0]!;
      }
      return await new Promise<JsonRecord>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(requestId);
          reject(
            new CodexIpcProtocolError(
              `Codex IPC request timed out after ${IPC_REQUEST_TIMEOUT_MS}ms.`,
            ),
          );
        }, IPC_REQUEST_TIMEOUT_MS);
        timer.unref();
        waiters.set(requestId, { reject, resolve, timer });
      });
    },
  };
}

function writeFrame(socket: Socket, message: JsonRecord): void {
  const json = JSON.stringify(message);
  const bodyBytes = Buffer.byteLength(json, "utf8");
  const frame = Buffer.allocUnsafe(IPC_FRAME_HEADER_BYTES + bodyBytes);
  frame.writeUInt32LE(bodyBytes, 0);
  frame.write(json, IPC_FRAME_HEADER_BYTES, "utf8");
  socket.write(frame);
}

function initializedClientId(message: JsonRecord): string {
  if (message.resultType !== "success" || message.method !== "initialize") {
    throw responseError("initialize", message);
  }
  const result = message.result;
  if (!isRecord(result) || typeof result.clientId !== "string") {
    throw new CodexIpcProtocolError(
      "Codex IPC returned a malformed initialize response.",
    );
  }
  return result.clientId;
}

function assertSuccessfulWake(message: JsonRecord): void {
  if (
    message.resultType !== "success" ||
    message.method !== CODEX_START_TURN_METHOD
  ) {
    throw responseError(CODEX_START_TURN_METHOD, message);
  }
}

function responseError(method: string, message: JsonRecord): Error {
  const detail = typeof message.error === "string" ? `: ${message.error}` : "";
  return new CodexIpcProtocolError(
    `Codex IPC request "${method}" failed${detail}.`,
  );
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
