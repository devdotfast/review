import type { ReviewAgentHarness } from "../authoring-session";

export type { ReviewAgentHarness } from "../authoring-session";

export interface NativeSessionRef {
  harness: ReviewAgentHarness;
  sessionId: string;
}

export type ReviewThreadAgentBinding = NativeSessionRef;

export interface NativeReviewMessage {
  role: "user" | "assistant";
  body: string;
  createdAt: string;
}

export interface NativeSessionSnapshot {
  session: ReviewThreadAgentBinding;
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
  readonly ref: ReviewThreadAgentBinding;
  updates(): Promise<UpdatePipe<NativeSessionSnapshot, NativeSessionUpdate>>;
}

export type NativeTerminalEvent =
  | {
      type: "session.mismatch";
      expectedSessionId: string;
      actualSessionId: string;
    }
  | { type: "observer.failed"; error: string }
  | { type: "terminal.closed" };

export interface NativeTerminalHandle {
  readonly accepted: Promise<NativeSessionRef>;
  readonly events: AsyncIterable<NativeTerminalEvent>;
  detach(): Promise<void>;
}

export type ReviewTurnRoute =
  | {
      kind: "fork";
      source: NativeSessionRef;
    }
  | { kind: "resume"; session: ReviewThreadAgentBinding }
  | { kind: "new"; harness: ReviewAgentHarness };

export interface LaunchReviewTurnInput {
  launchId: string;
  threadId: string;
  reviewMessageId: string;
  cwd: string;
  prompt: string;
  route: ReviewTurnRoute;
}
