import { randomBytes, randomUUID } from "node:crypto";
import { type IncomingMessage, type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { DEV_REVIEW_HOME_ENV, devReviewHome } from "../review-storage";
import { AsyncQueue } from "./async-queue";
import type { HarnessDialect, NativeTerminalInput } from "./harness";
import type {
  AgentServer,
  AgentServerOptions,
  LaunchInput,
  NativeReviewMessage,
  SessionSnapshot,
  SessionUpdate,
  UpdatePipe,
} from "./native-session";
import {
  REVIEW_AGENT_HOOK_TOKEN_ENV,
  REVIEW_AGENT_HOOK_URL_ENV,
  REVIEW_AGENT_THREAD_TOKEN_ENV,
  REVIEW_AGENT_THREAD_URL_ENV,
  ReviewCommandPath,
} from "./terminal-command";
import { isJsonRecord } from "./transcript-json";

const MAX_HOOK_BODY_BYTES = 2 * 1024 * 1024;

interface SessionState {
  transcriptPath?: string;
  subscribers: Set<Subscriber>;
}

interface Subscriber {
  queue: AsyncQueue<SessionUpdate>;
  /** Messages already delivered, so re-reads only emit the tail. */
  delivered: number;
  /** Serializes transcript re-reads per subscriber; wakes coalesce. */
  reading: Promise<void>;
  wakePending: boolean;
}

/**
 * An AgentServer for harnesses that have no server of their own. It listens
 * on a loopback port; the terminal's native hooks post there, and each hook
 * is a signal to re-read the transcript and forward whatever is new. Nothing
 * here is harness-specific: the dialect supplies the command line and the
 * reader.
 */
export class HookObservedAgentServer implements AgentServer {
  readonly harness: HarnessDialect["harness"];
  readonly #dialect: HarnessDialect;
  readonly #runtimeDirectory: string;
  readonly #desktop: AgentServerOptions["desktopEndpoint"];
  readonly #commandPath: ReviewCommandPath;
  readonly #sessions = new Map<string, SessionState>();
  readonly #hookToken = randomBytes(32).toString("base64url");
  #listener: Promise<{ server: Server; url: string }> | undefined;

  constructor(dialect: HarnessDialect, options: AgentServerOptions) {
    this.harness = dialect.harness;
    this.#dialect = dialect;
    this.#runtimeDirectory = options.runtimeDirectory;
    this.#desktop = {
      baseUrl: options.desktopEndpoint.baseUrl.replace(/\/$/u, ""),
      token: options.desktopEndpoint.token,
    };
    this.#commandPath = new ReviewCommandPath(options);
  }

  async launch(
    input: LaunchInput,
  ): Promise<{ sessionId: string; terminal: NativeTerminalInput }> {
    const sessionId = await this.#dialect.reserveSessionId({
      session: input.session,
      cwd: input.cwd,
    });
    const { url: hookBaseUrl } = await this.#listen();
    const sessionPath = `${this.harness}/${encodeURIComponent(sessionId)}`;
    const pathValue = await this.#commandPath.resolve();
    const terminal = await this.#dialect.terminalCommand({
      launchId: randomUUID(),
      session: input.session,
      sessionId,
      ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
      cwd: input.cwd,
      env: {
        // Native hooks report to this server's own listener.
        [REVIEW_AGENT_HOOK_URL_ENV]: `${hookBaseUrl}/${sessionPath}`,
        [REVIEW_AGENT_HOOK_TOKEN_ENV]: this.#hookToken,
        // `review threads get` inside the terminal reads its thread from the
        // desktop, which every implementation needs regardless of observation.
        [REVIEW_AGENT_THREAD_URL_ENV]: `${this.#desktop.baseUrl}/native-agent-events/${sessionPath}/thread`,
        [REVIEW_AGENT_THREAD_TOKEN_ENV]: this.#desktop.token,
        [DEV_REVIEW_HOME_ENV]: devReviewHome(),
        ...(pathValue ? { PATH: pathValue } : {}),
      },
      runtimeDirectory: this.#runtimeDirectory,
    });
    this.#session(sessionId);
    return { sessionId, terminal };
  }

  async updates(
    sessionId: string,
  ): Promise<UpdatePipe<SessionSnapshot, SessionUpdate>> {
    const state = this.#session(sessionId);
    const messages = await this.#read(sessionId, state);
    const subscriber: Subscriber = {
      queue: new AsyncQueue<SessionUpdate>(),
      delivered: messages.length,
      reading: Promise.resolve(),
      wakePending: false,
    };
    state.subscribers.add(subscriber);
    return {
      snapshot: { sessionId, messages },
      updates: subscriber.queue,
      close: async () => {
        state.subscribers.delete(subscriber);
        subscriber.queue.close();
        await subscriber.reading;
      },
    };
  }

  async close(): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const state of this.#sessions.values()) {
      for (const subscriber of state.subscribers) {
        subscriber.queue.close();
        pending.push(subscriber.reading);
      }
      state.subscribers.clear();
    }
    await Promise.all(pending);
    if (this.#listener) {
      const { server } = await this.#listener;
      this.#listener = undefined;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }

  /** Loopback listener for native hooks. Started on the first launch. */
  #listen(): Promise<{ server: Server; url: string }> {
    this.#listener ??= new Promise((resolve, reject) => {
      const server = createServer((request, response) => {
        void this.#handleHook(request)
          .then(({ status, body }) => {
            response.writeHead(status, { "content-type": "application/json" });
            response.end(JSON.stringify(body));
          })
          .catch((error: unknown) => {
            response.writeHead(500, { "content-type": "application/json" });
            response.end(JSON.stringify({ ok: false, error: String(error) }));
          });
      });
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        resolve({ server, url: `http://127.0.0.1:${port}` });
      });
    });
    return this.#listener;
  }

  async #handleHook(
    request: IncomingMessage,
  ): Promise<{ status: number; body: unknown }> {
    if (request.method !== "POST") {
      return { status: 405, body: { ok: false, error: "POST only." } };
    }
    if (request.headers["x-review-token"] !== this.#hookToken) {
      return { status: 401, body: { ok: false, error: "Unauthorized" } };
    }
    const match = /^\/([^/]+)\/([^/]+)$/u.exec(request.url ?? "");
    if (!match || match[1] !== this.harness) {
      return { status: 404, body: { ok: false, error: "Unknown session." } };
    }
    const sessionId = decodeURIComponent(match[2]!);
    const payload = await readJsonBody(request);
    try {
      this.#receiveHookEvent(sessionId, payload);
    } catch (error) {
      return {
        status: 400,
        body: {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
    return { status: 200, body: { ok: true } };
  }

  #receiveHookEvent(sessionId: string, payload: unknown): void {
    if (!isJsonRecord(payload)) return;
    const event = hookEvent(payload);
    if (event.sessionId && event.sessionId !== sessionId) {
      throw new Error(
        `A native hook for session "${event.sessionId}" was posted to session "${sessionId}".`,
      );
    }
    const state = this.#session(sessionId);
    if (event.transcriptPath) state.transcriptPath = event.transcriptPath;
    this.#wake(sessionId, state);
    if (event.completesTurn) {
      // Hooks can fire before the harness flushes the transcript.
      for (const delay of [250, 1_000]) {
        const timer = setTimeout(() => this.#wake(sessionId, state), delay);
        timer.unref();
      }
    }
  }

  #session(sessionId: string): SessionState {
    let state = this.#sessions.get(sessionId);
    if (!state) {
      state = { subscribers: new Set() };
      this.#sessions.set(sessionId, state);
    }
    return state;
  }

  #wake(sessionId: string, state: SessionState): void {
    for (const subscriber of state.subscribers) {
      if (subscriber.wakePending) continue;
      subscriber.wakePending = true;
      subscriber.reading = subscriber.reading.then(async () => {
        subscriber.wakePending = false;
        if (!state.subscribers.has(subscriber)) return;
        const messages = await this.#read(sessionId, state);
        for (const message of messages.slice(subscriber.delivered)) {
          subscriber.delivered += 1;
          subscriber.queue.push({ type: "message.updated", message });
        }
      });
    }
  }

  async #read(
    sessionId: string,
    state: SessionState,
  ): Promise<NativeReviewMessage[]> {
    try {
      return await this.#dialect.readMessages({
        sessionId,
        transcriptPath: state.transcriptPath,
      });
    } catch (error) {
      // The first hooks can fire before the harness creates its transcript.
      if (isMissingTranscript(error)) return [];
      throw error;
    }
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_HOOK_BODY_BYTES) {
      throw new Error("Native hook payload is too large.");
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as unknown) : {};
}

function isMissingTranscript(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if ("code" in error && error.code === "ENOENT") return true;
  return / has no (?:rollout|transcript) file\.$/u.test(error.message);
}

function hookEvent(payload: Record<string, unknown>): {
  sessionId?: string;
  transcriptPath?: string;
  completesTurn: boolean;
} {
  const sessionId = firstString(
    payload.session_id,
    payload.sessionId,
    payload.thread_id,
    payload.threadId,
  );
  const transcriptPath = firstString(
    payload.transcript_path,
    payload.transcriptPath,
  );
  const name = firstString(
    payload.hook_event_name,
    payload.hookEventName,
    payload.event,
  )?.toLowerCase();
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(transcriptPath ? { transcriptPath } : {}),
    completesTurn:
      name === "stop" || name === "sessionend" || name === "agent_settled",
  };
}

function firstString(...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}
