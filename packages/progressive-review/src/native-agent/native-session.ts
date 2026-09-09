import type { ReviewVerbRequest } from "@dev.fast/review-protocol";

import type { ReviewAgentHarness } from "../authoring-session";

export type { ReviewAgentHarness, SessionRef } from "../authoring-session";

export interface NativeReviewMessage {
  id: string;
  role: "user" | "assistant";
  body: string;
  createdAt: string;
}

/** What a native terminal runs. The desktop pairs it with the session. */
export type NativeTerminalCommand = Extract<
  ReviewVerbRequest,
  { name: "openNativeAgentTerminal" }
>["args"]["command"];

export interface SessionUpdateStream {
  updates: AsyncIterable<SessionUpdate>;
  close(): Promise<void>;
}

export type SessionUpdate =
  | { type: "message.updated"; message: NativeReviewMessage }
  | {
      type: "status.changed";
      status: "running" | "idle" | "interrupted" | "failed";
      error?: string;
    };

export interface AgentServerOptions {
  runtimeDirectory: string;
  reviewCliPath?: string;
  reviewCliRuntimePath?: string;
  /** The desktop every native terminal can reach, for `review threads` lookups. */
  desktopEndpoint: { baseUrl: string; token: string };
}

export interface LaunchInput {
  /** Which session the terminal lands in. Absent starts a fresh one. */
  session?: { resume: string } | { forkOf: string };
  /** Submitted when the terminal starts. Absent opens the session silently. */
  prompt?: { id: string; text: string };
  cwd: string;
}

export interface AgentServer {
  readonly harness: ReviewAgentHarness;
  launch(input: LaunchInput): Promise<{
    sessionId: string;
    command: NativeTerminalCommand;
  }>;
  updates(sessionId: string): Promise<SessionUpdateStream>;
  interrupt(sessionId: string): Promise<void>;
  close(): Promise<void>;
}
