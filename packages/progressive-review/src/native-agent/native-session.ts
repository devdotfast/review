import type { ReviewVerbRequest } from "@dev.fast/review-protocol";

import type { ReviewAgentHarness } from "../authoring-session";

export type { ReviewAgentHarness, SessionRef } from "../authoring-session";

export interface NativeReviewMessage {
  role: "user" | "assistant";
  body: string;
  createdAt: string;
}

/** What a native terminal runs. The desktop pairs it with the session. */
export type NativeTerminalCommand = Extract<
  ReviewVerbRequest,
  { name: "openNativeAgentTerminal" }
>["args"]["command"];

export interface UpdatePipe<Snapshot, Update> {
  snapshot: Snapshot;
  updates: AsyncIterable<Update>;
  close(): Promise<void>;
}

// ---- AgentServer ----------------------------------------------------------
//
// Review's model of a harness, as if every harness ran an app-server that can
// launch terminals into sessions and report what happens in them. Codex has a
// real one; the other backends emulate it. Callers never see the difference.

export interface SessionSnapshot {
  sessionId: string;
  messages: readonly NativeReviewMessage[];
}

export type SessionUpdate = {
  type: "message.updated";
  message: NativeReviewMessage;
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
  prompt?: string;
  cwd: string;
}

export interface AgentServer {
  readonly harness: ReviewAgentHarness;
  launch(input: LaunchInput): Promise<{
    sessionId: string;
    command: NativeTerminalCommand;
  }>;
  updates(
    sessionId: string,
  ): Promise<UpdatePipe<SessionSnapshot, SessionUpdate>>;
  close(): Promise<void>;
}
