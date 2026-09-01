import type { ReviewAgentHarness, SessionRef } from "../authoring-session";
import type { NativeTerminalInput } from "./harness";

export type { ReviewAgentHarness, SessionRef } from "../authoring-session";

export interface NativeReviewMessage {
  role: "user" | "assistant";
  body: string;
  createdAt: string;
}

export interface NativeSessionSnapshot {
  session: SessionRef;
  messages: readonly NativeReviewMessage[];
}

export type NativeSessionUpdate = {
  type: "message.updated";
  message: NativeReviewMessage;
};

export interface UpdatePipe<Snapshot, Update> {
  snapshot: Snapshot;
  updates: AsyncIterable<Update>;
  close(): Promise<void>;
}

export interface ObservedNativeSession {
  readonly ref: SessionRef;
  updates(): Promise<UpdatePipe<NativeSessionSnapshot, NativeSessionUpdate>>;
}

export type NativeTerminalEvent =
  | {
      type: "session.mismatch";
      expectedSessionId: string;
      actualSessionId: string;
    }
  | { type: "observer.failed"; error: string };

export interface NativeTerminalHandle {
  readonly accepted: Promise<SessionRef>;
  readonly events: AsyncIterable<NativeTerminalEvent>;
  detach(): Promise<void>;
}

export type ReviewTurnRoute =
  | {
      kind: "fork";
      source: SessionRef;
    }
  | { kind: "resume"; session: SessionRef }
  | { kind: "new"; harness: ReviewAgentHarness };

export interface LaunchReviewTurnInput {
  launchId: string;
  threadId: string;
  reviewMessageId: string;
  cwd: string;
  prompt: string;
  route: ReviewTurnRoute;
}

// ---- AgentServer ----------------------------------------------------------
//
// Review's model of a harness, as if every harness ran an app-server that can
// launch terminals into sessions and report what happens in them. Codex has a
// real one; the other backends emulate it. Callers never see the difference.

export type SessionStatus = "pending" | "idle" | "running" | "closed";

export interface SessionSnapshot {
  sessionId: string;
  status: SessionStatus;
  messages: readonly NativeReviewMessage[];
}

export type SessionUpdate =
  | { type: "attached" }
  | { type: "message.updated"; message: NativeReviewMessage }
  | { type: "turn.started" }
  | { type: "turn.completed" }
  | { type: "closed"; reason: string };

export interface AgentServerOptions {
  runtimeDirectory: string;
  reviewCliPath?: string;
  reviewCliRuntimePath?: string;
}

export interface LaunchInput {
  /** Which session the terminal lands in. Absent starts a fresh one. */
  session?: { resume: string } | { forkOf: string };
  /** Submitted when the terminal starts. Absent opens the session silently. */
  prompt?: string;
  cwd: string;
  /** Where this review accepts native hook events and `review threads` calls. */
  hookEndpoint: { baseUrl: string; token: string };
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
