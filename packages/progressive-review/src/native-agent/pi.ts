import { randomUUID } from "node:crypto";

import {
  type JsonValue,
  jsonObject,
  jsonString,
} from "@dev.fast/review-protocol";

import { DEV_REVIEW_HOME_ENV, devReviewHome } from "../review-storage";
import { LiveCapture } from "./live-capture";
import { LoopbackIngress } from "./loopback-ingress";
import type {
  AgentServer,
  AgentServerOptions,
  LaunchInput,
  NativeReviewMessage,
  NativeTerminalCommand,
  SessionUpdateStream,
} from "./native-session";
import {
  REVIEW_AGENT_BRIDGE_TOKEN_ENV,
  REVIEW_AGENT_BRIDGE_URL_ENV,
  ReviewCommandPath,
  companionModulePath,
  reviewThreadEnvironment,
} from "./terminal-command";

export class PiAgentServer implements AgentServer {
  readonly harness = "pi" as const;
  readonly #desktop: AgentServerOptions["desktopEndpoint"];
  readonly #commandPath: ReviewCommandPath;
  readonly #sessions = new Map<string, LiveCapture>();
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
    if (input.prompt !== undefined) args.push(input.prompt.text);
    const capture = this.#sessions.get(sessionId) ?? new LiveCapture();
    const launchId = capture.launch(input.prompt);
    this.#sessions.set(sessionId, capture);
    const env: NativeTerminalCommand["env"] = {
      DEV_FAST_REVIEW_AGENT_LAUNCH_ID: launchId,
      [REVIEW_AGENT_BRIDGE_URL_ENV]: `${bridgeUrl}/${this.harness}/${encodedSession}`,
      [REVIEW_AGENT_BRIDGE_TOKEN_ENV]: this.#ingress.token,
      ...reviewThreadEnvironment(this.#desktop),
      [DEV_REVIEW_HOME_ENV]: devReviewHome(),
    };
    if (pathValue) env.PATH = pathValue;
    Object.assign(env, input.environment);
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

  async updates(sessionId: string): Promise<SessionUpdateStream> {
    return this.#session(sessionId).subscribe();
  }

  async interrupt(sessionId: string): Promise<void> {
    this.#session(sessionId).interrupt();
  }

  async close(): Promise<void> {
    for (const capture of this.#sessions.values()) capture.queue.close();
    await this.#ingress.close();
  }

  #receive(sessionId: string, payload: JsonValue): void {
    const record = jsonObject(payload);
    if (!record || jsonString(record.sessionId) !== sessionId) {
      throw new Error(`The Pi bridge must name session "${sessionId}".`);
    }
    const capture = this.#session(sessionId);
    const launchId = jsonString(record.review_launch_id);
    if (!launchId) throw new Error("The observer event has no launch ID.");
    if (!capture.accepts(launchId)) return;
    if (record.type === "message.updated") {
      capture.message(bridgeMessage(record.message));
    } else if (record.type === "status.changed") {
      const status = record.status;
      if (
        status !== "running" &&
        status !== "idle" &&
        status !== "failed" &&
        status !== "interrupted"
      ) {
        throw new Error("The Pi bridge posted an invalid status.");
      }
      capture.status(status, jsonString(record.error));
    } else {
      throw new Error("The Pi bridge posted an unsupported event.");
    }
  }

  #session(sessionId: string): LiveCapture {
    const capture = this.#sessions.get(sessionId);
    if (!capture)
      throw new Error(`Pi session "${sessionId}" has not been launched.`);
    return capture;
  }
}

function bridgeMessage(value: JsonValue | undefined): NativeReviewMessage {
  const record = jsonObject(value);
  const id = jsonString(record?.id);
  const role = jsonString(record?.role);
  const body = jsonString(record?.body);
  const createdAt = jsonString(record?.createdAt);
  if (
    !id ||
    (role !== "user" && role !== "assistant") ||
    body === undefined ||
    !createdAt
  ) {
    throw new Error("The Pi bridge posted a malformed message.");
  }
  return { id, role, body, createdAt };
}

export function server(options: AgentServerOptions): AgentServer {
  return new PiAgentServer(options);
}
