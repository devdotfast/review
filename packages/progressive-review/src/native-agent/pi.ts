import { randomUUID } from "node:crypto";

import {
  type JsonValue,
  jsonArray,
  jsonObject,
  jsonString,
} from "@dev.fast/review-protocol";

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
  ReviewCommandPath,
  reviewThreadEnvironment,
  companionModulePath,
} from "./terminal-command";

interface SessionState {
  /** The latest projection the extension posted. */
  messages: NativeReviewMessage[];
  subscribers: Set<{ queue: AsyncQueue<SessionUpdate>; delivered: number }>;
  pendingPrompt?: {
    phase: "awaiting-session-start" | "awaiting-message";
    inheritedIds: Set<string>;
    accepted: NonNullable<LaunchInput["prompt"]>["accepted"];
  };
}

/**
 * Pi is programmable in-process, so its "server" is an extension: the
 * terminal loads pi-bridge-extension, which posts the projected conversation
 * to this server's ingress on every session event. No transcript is read.
 */
export class PiAgentServer implements AgentServer {
  readonly harness = "pi" as const;
  readonly #threadEnvironment: Record<string, string>;
  readonly #commandPath: ReviewCommandPath;
  readonly #sessions = new Map<string, SessionState>();
  readonly #ingress: LoopbackIngress;

  constructor(options: AgentServerOptions) {
    this.#threadEnvironment = reviewThreadEnvironment(options.desktopEndpoint);
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
    const state = this.#session(sessionId);
    if (input.prompt) {
      if (state.pendingPrompt)
        throw new Error("Pi already has a pending Review prompt.");
      await input.prompt.prepared(sessionId);
      state.pendingPrompt = {
        phase: "awaiting-session-start",
        inheritedIds: new Set(),
        accepted: input.prompt.accepted,
      };
      args.push(input.prompt.text);
    }
    const env: NativeTerminalCommand["env"] = {
      [REVIEW_AGENT_BRIDGE_URL_ENV]: `${bridgeUrl}/${this.harness}/${encodedSession}`,
      [REVIEW_AGENT_BRIDGE_TOKEN_ENV]: this.#ingress.token,
      ...this.#threadEnvironment,
      [DEV_REVIEW_HOME_ENV]: devReviewHome(),
    };
    if (pathValue) env.PATH = pathValue;
    return {
      sessionId,
      command: {
        cwd: input.cwd,
        executable: "pi",
        args,
        env,
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

  async #receive(sessionId: string, payload: JsonValue): Promise<void> {
    const record = jsonObject(payload);
    if (!record) {
      throw new Error("The Pi bridge posted a non-object payload.");
    }
    const postedSession = jsonString(record.sessionId);
    if (postedSession !== sessionId) {
      throw new Error(
        `The Pi bridge for session "${postedSession}" posted to session "${sessionId}".`,
      );
    }
    const messages = bridgeMessages(record.messages);
    const state = this.#session(sessionId);
    const previous = state.messages;
    state.messages = messages;
    const pending = state.pendingPrompt;
    if (pending) {
      if (pending.phase === "awaiting-session-start") {
        if (record.phase !== "session-start") {
          throw new Error(
            "Pi must report its inherited branch before accepting a Review prompt.",
          );
        }
        pending.inheritedIds = new Set(messages.map((message) => message.id));
        pending.phase = "awaiting-message";
      } else {
        const first = messages.find(
          (message) =>
            message.role === "user" && !pending.inheritedIds.has(message.id),
        );
        if (first) {
          state.pendingPrompt = undefined;
          await pending.accepted(sessionId, first.id);
        }
      }
    }
    for (const subscriber of state.subscribers) {
      // A branch switch is not an append. Reconnect from the persisted
      // boundary instead of importing a different branch as new replies.
      if (
        previous
          .slice(0, subscriber.delivered)
          .some((message, index) => messages[index]?.id !== message.id)
      ) {
        subscriber.queue.close();
        state.subscribers.delete(subscriber);
        continue;
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

function bridgeMessages(value: JsonValue | undefined): NativeReviewMessage[] {
  const list = jsonArray(value);
  if (!list) {
    throw new Error("The Pi bridge posted no message list.");
  }
  return list.map((entry) => {
    const record = jsonObject(entry);
    const id = jsonString(record?.id);
    const role = jsonString(record?.role);
    const body = jsonString(record?.body);
    const createdAt = jsonString(record?.createdAt);
    if (
      !id ||
      (role !== "user" && role !== "assistant") ||
      body === undefined ||
      createdAt === undefined
    ) {
      throw new Error("The Pi bridge posted a malformed message.");
    }
    return { id, role, body, createdAt };
  });
}

export function server(options: AgentServerOptions): AgentServer {
  return new PiAgentServer(options);
}
