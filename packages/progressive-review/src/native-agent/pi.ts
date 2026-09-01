import { randomUUID } from "node:crypto";

import { DEV_REVIEW_HOME_ENV, devReviewHome } from "../review-storage";
import { AsyncQueue } from "./async-queue";
import { LoopbackIngress } from "./loopback-ingress";
import type {
  AgentServer,
  AgentServerOptions,
  LaunchInput,
  NativeReviewMessage,
  NativeTerminalCommand,
  SessionSnapshot,
  SessionUpdate,
  UpdatePipe,
} from "./native-session";
import {
  REVIEW_AGENT_BRIDGE_TOKEN_ENV,
  REVIEW_AGENT_BRIDGE_URL_ENV,
  REVIEW_AGENT_THREAD_TOKEN_ENV,
  REVIEW_AGENT_THREAD_URL_ENV,
  ReviewCommandPath,
  companionModulePath,
} from "./terminal-command";
import { isJsonRecord } from "./transcript-json";

interface SessionState {
  /** The latest projection the extension posted. */
  messages: NativeReviewMessage[];
  subscribers: Set<{ queue: AsyncQueue<SessionUpdate>; delivered: number }>;
}

/**
 * Pi is programmable in-process, so its "server" is an extension: the
 * terminal loads pi-bridge-extension, which posts the projected conversation
 * to this server's ingress on every session event. No transcript is read.
 */
export class PiAgentServer implements AgentServer {
  readonly harness = "pi" as const;
  readonly #desktop: AgentServerOptions["desktopEndpoint"];
  readonly #commandPath: ReviewCommandPath;
  readonly #sessions = new Map<string, SessionState>();
  readonly #ingress: LoopbackIngress;

  constructor(options: AgentServerOptions) {
    this.#desktop = {
      baseUrl: options.desktopEndpoint.baseUrl.replace(/\/$/u, ""),
      token: options.desktopEndpoint.token,
    };
    this.#commandPath = new ReviewCommandPath(options);
    this.#ingress = new LoopbackIngress({
      scope: this.harness,
      onPost: (sessionId, payload) => this.#receive(sessionId, payload),
    });
  }

  async launch(
    input: LaunchInput,
  ): Promise<{ sessionId: string; command: NativeTerminalCommand }> {
    // Pi accepts a caller-chosen id, so a new or forked session is minted
    // here and exists once the terminal starts.
    const sessionId =
      input.session && "resume" in input.session
        ? input.session.resume
        : randomUUID();
    const encodedSession = encodeURIComponent(sessionId);
    const bridgeUrl = await this.#ingress.url();
    const pathValue = await this.#commandPath.resolve();
    const args = [
      "-e",
      companionModulePath("pi-bridge-extension"),
      "--tools",
      "bash,find,grep,ls,read",
    ];
    if (input.session && "forkOf" in input.session) {
      args.push("--fork", input.session.forkOf, "--session-id", sessionId);
    } else if (input.session) {
      args.push("--session", input.session.resume);
    } else {
      args.push("--session-id", sessionId);
    }
    if (input.prompt !== undefined) args.push(input.prompt);
    this.#session(sessionId);
    return {
      sessionId,
      command: {
        cwd: input.cwd,
        executable: "pi",
        args,
        env: {
          [REVIEW_AGENT_BRIDGE_URL_ENV]: `${bridgeUrl}/${this.harness}/${encodedSession}`,
          [REVIEW_AGENT_BRIDGE_TOKEN_ENV]: this.#ingress.token,
          [REVIEW_AGENT_THREAD_URL_ENV]: `${this.#desktop.baseUrl}/native-agent-events/${this.harness}/${encodedSession}/thread`,
          [REVIEW_AGENT_THREAD_TOKEN_ENV]: this.#desktop.token,
          [DEV_REVIEW_HOME_ENV]: devReviewHome(),
          ...(pathValue ? { PATH: pathValue } : {}),
        },
      },
    };
  }

  async updates(
    sessionId: string,
  ): Promise<UpdatePipe<SessionSnapshot, SessionUpdate>> {
    const state = this.#session(sessionId);
    const subscriber = {
      queue: new AsyncQueue<SessionUpdate>(),
      delivered: state.messages.length,
    };
    state.subscribers.add(subscriber);
    return {
      snapshot: { sessionId, messages: [...state.messages] },
      updates: subscriber.queue,
      close: async () => {
        state.subscribers.delete(subscriber);
        subscriber.queue.close();
      },
    };
  }

  async close(): Promise<void> {
    for (const state of this.#sessions.values()) {
      for (const subscriber of state.subscribers) subscriber.queue.close();
      state.subscribers.clear();
    }
    await this.#ingress.close();
  }

  #receive(sessionId: string, payload: unknown): void {
    if (!isJsonRecord(payload)) {
      throw new Error("The Pi bridge posted a non-object payload.");
    }
    if (
      typeof payload.sessionId === "string" &&
      payload.sessionId !== sessionId
    ) {
      throw new Error(
        `The Pi bridge for session "${payload.sessionId}" posted to session "${sessionId}".`,
      );
    }
    const messages = bridgeMessages(payload.messages);
    const state = this.#session(sessionId);
    state.messages = messages;
    for (const subscriber of state.subscribers) {
      // The branch can shrink after /tree navigation; deliver from the new end.
      if (subscriber.delivered > messages.length) {
        subscriber.delivered = messages.length;
      }
      for (const message of messages.slice(subscriber.delivered)) {
        subscriber.delivered += 1;
        subscriber.queue.push({ type: "message.updated", message });
      }
    }
  }

  #session(sessionId: string): SessionState {
    let state = this.#sessions.get(sessionId);
    if (!state) {
      state = { messages: [], subscribers: new Set() };
      this.#sessions.set(sessionId, state);
    }
    return state;
  }
}

function bridgeMessages(value: unknown): NativeReviewMessage[] {
  if (!Array.isArray(value)) {
    throw new Error("The Pi bridge posted no message list.");
  }
  return value.map((entry) => {
    if (
      !isJsonRecord(entry) ||
      (entry.role !== "user" && entry.role !== "assistant") ||
      typeof entry.body !== "string" ||
      typeof entry.createdAt !== "string"
    ) {
      throw new Error("The Pi bridge posted a malformed message.");
    }
    return { role: entry.role, body: entry.body, createdAt: entry.createdAt };
  });
}

export function server(options: AgentServerOptions): AgentServer {
  return new PiAgentServer(options);
}
