import type { ReviewAgentHarness, SessionRef } from "../authoring-session";

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
