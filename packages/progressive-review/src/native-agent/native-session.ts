import type { ReviewAgentHarness } from "../authoring-session";
import type { NativeTerminalInput } from "./harness";

export type { ReviewAgentHarness, SessionRef } from "../authoring-session";

export interface NativeReviewMessage {
  role: "user" | "assistant";
  body: string;
  createdAt: string;
}

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
  /** Desktop-global endpoint that accepts native hook events and `review threads` calls. */
  hookBaseUrl: string;
  hookToken: string;
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
    terminal: NativeTerminalInput;
  }>;
  updates(
    sessionId: string,
  ): Promise<UpdatePipe<SessionSnapshot, SessionUpdate>>;
  /** Present on servers that learn about sessions through native hooks. */
  receiveHookEvent?(sessionId: string, payload: unknown): void;
  close(): Promise<void>;
}
